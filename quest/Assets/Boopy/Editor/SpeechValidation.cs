#nullable enable
using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Reflection;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    public static class SpeechValidation
    {
        public static byte[] SyntheticWav()
        {
            using var stream = new MemoryStream(); using var writer = new BinaryWriter(stream, Encoding.ASCII);
            writer.Write(Encoding.ASCII.GetBytes("RIFF")); writer.Write(2036);
            writer.Write(Encoding.ASCII.GetBytes("WAVEfmt ")); writer.Write(16);
            writer.Write((short)1); writer.Write((short)1); writer.Write(22050); writer.Write(44100);
            writer.Write((short)2); writer.Write((short)16);
            writer.Write(Encoding.ASCII.GetBytes("data")); writer.Write(2000);
            for (var index = 0; index < 1000; index++) writer.Write((short)(index % 2 == 0 ? 16384 : -16384));
            return stream.ToArray();
        }
        public static void Validate()
        {
            var bytes = SyntheticWav(); var samples = SpeechPlayback.Decode(bytes);
            Require(samples.Length == 1000 && samples[0] == .5f && samples[1] == -.5f, "PCM waveform decode changed.");
            var neural=(byte[])bytes.Clone(); Array.Copy(BitConverter.GetBytes(24000),0,neural,24,4); Array.Copy(BitConverter.GetBytes(48000),0,neural,28,4);
            var neuralSamples=SpeechPlayback.Decode(neural,out var rate);
            Require(rate==24000 && neuralSamples.SequenceEqual(samples),"Neural speech was rejected or its sample rate changed.");
            Require(SpeechPlayback.EnergyAt(samples, 0) == 1f && SpeechPlayback.EnergyAt(new float[441], 0) == 0f,
                "Speech activity does not distinguish real samples from silence.");
            Require(SpeechPlayback.EnergyAt(samples, -1) == 0f && SpeechPlayback.EnergyAt(samples, samples.Length) == 0f,
                "Out-of-range playback cursor retained speech activity.");
            foreach (var invalid in new[] { new byte[0], bytes.Take(43).ToArray(), new byte[SpeechPlayback.MaxBytes + 1] })
                Reject(invalid);
            var stereo = (byte[])bytes.Clone(); stereo[22] = 2; Reject(stereo);
            var badRate = (byte[])bytes.Clone(); badRate[24] = 0; Reject(badRate);
            var badLength = (byte[])bytes.Clone(); badLength[40] = 1; Reject(badLength);
            var root = new GameObject("Synthetic speech validation");
            try
            {
                var playback = SpeechPlayback.Create(root.transform);
                Require(!playback.HasClip && !playback.Playing && playback.Activity == 0f, "Playback began without request.");
                playback.Play(bytes);
                var source = playback.GetComponent<AudioSource>();
                Require(source.clip.samples == 1000 && source.clip.channels == 1 && source.clip.frequency == 22050,
                    "Unity clip differs from service audio.");
                var prior = source.clip; playback.Play(bytes);
                Require(source.clip != prior, "Playback replacement retained old clip.");
                playback.Stop(); Require(!playback.HasClip && source.clip == null && !playback.Playing && playback.Activity == 0f, "Stop retained audio or speech activity.");
                playback.Play(bytes); playback.gameObject.SetActive(false);
                // Edit-mode batch objects do not receive play-mode lifecycle callbacks automatically.
                typeof(SpeechPlayback).GetMethod("OnDisable", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(playback, null);
                Require(!playback.HasClip && source.clip == null, "Disable retained audio.");
                var console = ContextConsole.Create(root.transform, root.transform);
                Require(!console.VoiceEnabled, "Voice enabled by default.");
                console.Activate(ConsoleAction.Speech);
                Require(!console.VoiceEnabled, "Unavailable voice could be enabled.");
                var view = new SessionView { Id = "synthetic", SpeechOutputAvailable = true };
                console.Render(view); console.Activate(ConsoleAction.Options); console.Activate(ConsoleAction.Settings);
                // Voice is the fourth setting, one per page.
                for (var page = 0; page < 3; page++) console.NextPage();
                Require(console.VoiceEnabled, "Available voice did not use the requested default.");
                Require(console.GetComponentsInChildren<SpatialAction>(true).Single(action => action.Action == ConsoleAction.Speech).gameObject.activeSelf,
                    "Available voice has no separate option.");
                var cues = console.SoundEnabled; console.Activate(ConsoleAction.Speech);
                Require(!console.VoiceEnabled && console.SoundEnabled == cues, "Voice mute changes interaction sounds.");
                view.SpeechOutputAvailable = false; console.Render(view);
                Require(!console.VoiceEnabled, "Lost capability retained voice enablement.");
                ValidateInterruptedReply(root, console, playback, bytes);
                ValidateSaveReceipt(root);
                Debug.Log("Boopy speech validation passed (synthetic; acoustic comfort unverified).");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }
        private static void ValidateSaveReceipt(GameObject root)
        {
            const string receipt = "Ready on your Mac. Not sent yet.";
            var fixture = new GameObject("Synthetic save receipt"); fixture.transform.SetParent(root.transform, false);
            var eyes = new GameObject("Synthetic receipt eyes").transform; eyes.SetParent(fixture.transform, false);
            var console = ContextConsole.Create(fixture.transform, eyes);
            var caption = DialogueStrip.Create(fixture.transform, eyes); console.DockDialogue(caption);
            var scene = SessionScene.Create(fixture.transform, fixture.AddComponent<RoomCamera>(), eyes);
            var app = fixture.AddComponent<BoopyApp>(); var flags = BindingFlags.Instance | BindingFlags.NonPublic;
            foreach (var pair in new[] { ("console",(object)console),("dialogue",(object)caption),("scene",(object)scene),("pocket",(object)eyes) })
                typeof(BoopyApp).GetField(pair.Item1,flags)!.SetValue(app,pair.Item2);
            var view = new SessionView { Id="synthetic-receipt",State="committed",Committed=new Committed {PackageId="ctx_synthetic_receipt"},
                Dialogue=new DialogueView {Speaker="boopy",UtteranceId="synthetic-save",At="1970-01-01T12:00:00Z",Text=receipt} };
            view.Utterances.Add(new UtteranceRef {Id="synthetic-save",Text="Save it",Kind="commit"});
            typeof(BoopyApp).GetMethod("Apply",flags)!.Invoke(app,new object[] {view});
            Require(caption.Stage==DialogueStage.LocalSave && caption.FullText==view.Dialogue.Text,"Spoken-save caption differs from exact journaled receipt used for synthesis.");
            view.Dialogue=null;
            typeof(BoopyApp).GetMethod("Apply",flags)!.Invoke(app,new object[] {view});
            Require(caption.Stage==DialogueStage.LocalSave && caption.FullText==console.HandoffStatusWords,"Normal button commit lost its precise local preparation state.");
            Require(view.Committed.PackageId=="ctx_synthetic_receipt", "Rendering receipt changed the selected package.");
        }

        private static void Reject(byte[] bytes)
        {
            try { SpeechPlayback.Decode(bytes); } catch (InvalidDataException) { return; }
            throw new Exception("Invalid synthetic speech WAV was accepted.");
        }
        private sealed class LateReply : HttpMessageHandler
        {
            public readonly TaskCompletionSource<HttpResponseMessage> Reply = new TaskCompletionSource<HttpResponseMessage>();
            public int Calls, SpeechCalls;
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            {
                Calls++;
                if (request.Method != HttpMethod.Get) SpeechCalls++;
                return request.Method == HttpMethod.Get
                    ? Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}}") })
                    : Reply.Task; // Intentionally ignores cancellation to exercise late-response guards.
            }
        }
        private static void ValidateInterruptedReply(GameObject root, ContextConsole console, SpeechPlayback playback, byte[] bytes)
        {
            var app = root.AddComponent<BoopyApp>();
            var flags = BindingFlags.Instance | BindingFlags.NonPublic;
            var eyes = new GameObject("Synthetic dialogue eyes").transform; eyes.SetParent(root.transform, false);
            var caption = DialogueStrip.Create(root.transform, eyes);
            var view = new SessionView { Id = "synthetic-speech", SpeechOutputAvailable = true,
                Dialogue = new DialogueView { Speaker = "boopy", UtteranceId = "synthetic-turn", At = "1970-01-01T12:00:00Z", Text = "Synthetic response" } };
            console.Render(view); console.Activate(ConsoleAction.Speech);
            var handler = new LateReply(); using var client = new ServiceClient(handler: handler);
            foreach (var pair in new[] { ("client", (object)client), ("session", (object)view),
                ("console", (object)console), ("speechPlayback", (object)playback), ("dialogue", (object)caption) })
                typeof(BoopyApp).GetField(pair.Item1, flags)!.SetValue(app, pair.Item2);
            var context = SynchronizationContext.Current;
            SynchronizationContext.SetSynchronizationContext(null);
            try
            {
                var pending = (Task)typeof(BoopyApp).GetMethod("Speak", flags)!.Invoke(app, new object[] { view })!;
                Require(handler.Calls == 2, "Enabled reply did not request health/speech.");
                app.enabled = false;
                typeof(BoopyApp).GetMethod("OnDisable", flags)!.Invoke(app, null);
                handler.Reply.SetResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Wire.Write(new SpeechOutputResponse
                { SessionId = view.Id, UtteranceId = view.Dialogue.UtteranceId, ResponseAt = view.Dialogue.At,
                    Speaker = "boopy", MimeType = "audio/wav", Wav = Convert.ToBase64String(bytes) })) });
                pending.GetAwaiter().GetResult();
                Require(!playback.HasClip, "Disabled app played a late reply.");
                typeof(BoopyApp).GetMethod("Apply", flags)!.Invoke(app, new object[] { view });
                Require(!caption.gameObject.activeSelf, "Disabled app displayed a late reply.");
                ((Task)typeof(BoopyApp).GetMethod("Speak", flags)!.Invoke(app, new object[] { view })!).GetAwaiter().GetResult();
                Require(handler.Calls == 2, "Disabled app requested another reply.");
                app.enabled = true;
                typeof(BoopyApp).GetField("inputAllowed", flags)!.SetValue(app, false);
                view.State = "committed"; view.Committed = new Committed { PackageId = "synthetic-saved" };
                typeof(BoopyApp).GetMethod("Apply", flags)!.Invoke(app, new object[] { view });
                Require(!caption.gameObject.activeSelf, "Unfocused app displayed a late save response.");
                typeof(BoopyApp).GetMethod("OnFocusAcquired", flags)!.Invoke(app, null);
                Require(console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Intent instrument").BodyText == "Context kept on your Mac. Handoff not prepared. Not sent yet.",
                    "Focus recovery failed to reconcile returned saved state.");
                Require(handler.Calls == 3 && handler.SpeechCalls == 1 && !playback.HasClip, "Focus recovery did not perform only its health refresh, or replayed voice.");
            }
            finally { SynchronizationContext.SetSynchronizationContext(context); }
        }
        public static void Render()
        {
            Validate(); HangulFont.Install();
            var root = new GameObject("Synthetic voice options");
            var camera = new GameObject("Synthetic eyes").AddComponent<Camera>(); camera.transform.SetParent(root.transform, false);
            camera.fieldOfView = 58; camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(.69f, .72f, .73f);
            var console = ContextConsole.Create(root.transform, camera.transform);
            console.SetReducedMotion(true); console.Place(new Vector3(0, .20f, 1));
            console.Render(new SessionView { Id = "synthetic", SpeechOutputAvailable = true });
            console.Activate(ConsoleAction.Options); console.Activate(ConsoleAction.Settings);
            var target = new RenderTexture(1600, 1400, 24); camera.targetTexture = target;
            camera.Render(); RenderTexture.active = target;
            var texture = new Texture2D(1600, 1400, TextureFormat.RGB24, false);
            texture.ReadPixels(new Rect(0, 0, 1600, 1400), 0, 0); texture.Apply();
            var path = Path.Combine(Path.GetTempPath(), "boopy-voice-options.png");
            File.WriteAllBytes(path, texture.EncodeToPNG());
            console.Activate(ConsoleAction.Speech); camera.Render();
            texture.ReadPixels(new Rect(0, 0, 1600, 1400), 0, 0); texture.Apply();
            File.WriteAllBytes(Path.Combine(Path.GetTempPath(), "boopy-voice-options-on.png"), texture.EncodeToPNG());
            RenderTexture.active = null; camera.targetTexture = null;
            UnityEngine.Object.DestroyImmediate(texture); UnityEngine.Object.DestroyImmediate(target); UnityEngine.Object.DestroyImmediate(root);
            Debug.Log("Boopy synthetic voice options: " + path);
        }
        private static void Require(bool valid, string message) { if (!valid) throw new Exception(message); }
    }
}
