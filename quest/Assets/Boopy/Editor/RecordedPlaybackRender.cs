#nullable enable
using System;
using System.Collections;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Video;
using static Boopy.Quest.Editor.RecordedSceneValidation;

namespace Boopy.Quest.Editor
{
    /// <summary>
    /// The recording the Mac shows, drawn through the app's own path from the service at BOOPY_SERVICE_URL (the owner's
    /// footage stays on the Mac; it streams here as it does to the headset; only reads are made): its clip at 0, 3, 6 and
    /// 9 seconds, then the frame fixed in the world with its surround from the head turned 0, 20 and 40 degrees either way
    /// and tipped 15 up and down. With BOOPY_BOOP set to "x,y,seconds,frameId,term,termId,guess", a tap boop at that point
    /// and time: the clip stops on that analyzed frame, read from the Mac, and the answer is a reply view typed for the
    /// render from those real facts (no turn reaches the Mac), its word, outline and Boopy shown and the shot marked as
    /// typed. Four more numbers, ",x0,y0,x1,y1", give the model's box on the subject (image coordinates from the top-left);
    /// without them the box is a small one around the point. Writes only to BOOPY_RENDER_DIR, which must already exist as a private folder; logs name the output folder
    /// and the shots only. Needs Unity's editor loop (run without -quit): it exits itself.
    /// </summary>
    public static class RecordedPlaybackRender
    {
        private const int Width = 1440, Height = 1260;
        // A Quest 3's view, about this tall, so a shot shows what the headset shows.
        private const float TallDegrees = 96f;
        private const BindingFlags Field = BindingFlags.Instance | BindingFlags.NonPublic;
        private static IEnumerator? steps;
        private static Fixture? fixture;
        private static SynchronizationContext? context;
        private static double startedAt;

        public static void Render()
        {
            context = SynchronizationContext.Current;
            try
            {
                var output = Environment.GetEnvironmentVariable("BOOPY_RENDER_DIR") is string dir && Directory.Exists(dir) ? dir
                    : throw new InvalidOperationException("BOOPY_RENDER_DIR must name an existing private folder.");
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                ScriptCoverage.Install();
                // Unity's own context stays, so the reads' continuations come back to the main thread as on the headset.
                var service = Environment.GetEnvironmentVariable("BOOPY_SERVICE_URL") is string url && url.StartsWith("http://127.0.0.1:", StringComparison.Ordinal) ? url
                    : throw new InvalidOperationException("BOOPY_SERVICE_URL must name the local service to read, http://127.0.0.1:PORT.");
                fixture = new Fixture();
                Set(fixture.App, "client", new ServiceClient(service));
                steps = Steps(fixture, output);
                startedAt = EditorApplication.timeSinceStartup;
                EditorApplication.update += Tick;
            }
            catch (Exception error) { Fail(error); }
        }

        private static void Tick()
        {
            try
            {
                if (fixture == null || steps == null) return;
                if (EditorApplication.timeSinceStartup - startedAt > 300) throw new TimeoutException("The render did not finish in 5 minutes.");
                EditorApplication.QueuePlayerLoopUpdate();
                // Edit mode runs no LateUpdate; the picture's own one moves the clip into the frame and its blur.
                typeof(RecordedPicture).GetMethod("LateUpdate", Field)!.Invoke(fixture.Picture, null);
                // Edit mode runs no Update either; the console's look over a recording is the app's own, on a clock of 50 ms a step.
                fixture.Clock += .05f; Set(fixture.App, "clock", (float?)fixture.Clock);
                Invoke(fixture.App, "KeepRecordingLook", fixture.Picture.Showing);
                if (!steps.MoveNext()) Finish(0);
            }
            catch (Exception error) { Fail(error); }
        }

        private static IEnumerator Steps(Fixture f, string output)
        {
            var read = (Task)Invoke(f.App, "ReadRecordedScene")!;
            while (!read.IsCompleted) yield return null;
            read.GetAwaiter().GetResult();
            if (f.Picture.Loaded && !f.Picture.Placed) f.Picture.Place(f.Eyes);
            if (!f.Picture.Showing || f.Picture.Source?.Video == null) throw new InvalidOperationException("The Mac shows no clip with a video.");
            Debug.Log("Boopy playback render: " + (f.Picture.Source.Projection != null ? "projection " + f.Picture.Source.Projection.Source : "no projection") + ".");
            var player = (VideoPlayer)typeof(RecordedPicture).GetField("player", Field)!.GetValue(f.Picture)!;
            var waited = EditorApplication.timeSinceStartup;
            while (!(bool)typeof(RecordedPicture).GetField("videoShown", Field)!.GetValue(f.Picture)!)
            {
                if (EditorApplication.timeSinceStartup - waited > 90)
                    throw new TimeoutException($"The clip did not start: prepared {player.isPrepared}, playing {player.isPlaying}, frame {player.frame}, enabled {player.isActiveAndEnabled}.");
                yield return null;
            }
            Debug.Log("Boopy playback render: the clip plays.");
            for (var t = 0f; t < 1f; t += .05f) { f.Console.RefreshVisuals(.05f); f.Strip.RefreshVisuals(.05f); yield return null; }
            // What of the console draws before any turn: names and sizes only, so no empty plate goes unseen.
            foreach (var shown in f.Console.GetComponentsInChildren<Renderer>())
                if (shown.enabled && shown.gameObject.activeInHierarchy) Debug.Log($"Boopy playback render console: {shown.name} {shown.bounds.size.x:0.000}x{shown.bounds.size.y:0.000}.");
            var rest = f.Eyes.rotation;
            foreach (var seconds in new[] { 0, 3, 6, 9 })
            {
                foreach (var wait in Seek(player, seconds)) yield return wait;
                Shot(f, Path.Combine(output, $"play-{seconds}s.png"));
            }
            player.Play();
            foreach (var (yaw, pitch) in new[] { (0f, 0f), (20f, 0f), (-20f, 0f), (40f, 0f), (-40f, 0f), (0f, 15f), (0f, -15f) })
            {
                f.Eyes.rotation = rest * Quaternion.Euler(-pitch, yaw, 0f);
                for (var i = 0; i < 5; i++) yield return null;
                Shot(f, Path.Combine(output, $"view-yaw{yaw:+0;-0;0}-pitch{pitch:+0;-0;0}.png"));
            }
            f.Eyes.rotation = rest;
            if (Environment.GetEnvironmentVariable("BOOPY_BOOP") is string boop)
            {
                var parts = boop.Split(',');
                var point = new Point2 { X = float.Parse(parts[0], CultureInfo.InvariantCulture), Y = float.Parse(parts[1], CultureInfo.InvariantCulture) };
                var source = f.Picture.Source;
                var near = source.Frames.Find(frame => frame.FrameId == parts[3])
                    ?? throw new InvalidOperationException("The clip lists no analyzed frame " + parts[3] + ".");
                foreach (var wait in Seek(player, float.Parse(parts[2], CultureInfo.InvariantCulture))) yield return wait;
                // The clip stops on the analyzed frame, read from the Mac as a boop does; then the turn goes to a Mac that
                // answers with the typed reply, so nothing reaches the owner's journal.
                var hold = (Task)typeof(BoopyApp).GetMethod("HoldStill", Field)!.Invoke(f.App, new object[] { source, near })!;
                while (!hold.IsCompleted) yield return null;
                hold.GetAwaiter().GetResult();
                foreach (var wait in Settle(10)) yield return wait;
                if (f.Picture.Scene?.FrameId != near.FrameId) throw new InvalidOperationException("The clip did not stop on the booped frame.");
                Box2? box = parts.Length >= 11 ? new Box2 { X0 = Number(parts[7]), Y0 = Number(parts[8]), X1 = Number(parts[9]), Y1 = Number(parts[10]) } : null;
                // ROOT's tents case: the model places no box for the man; the outline run's general list does, on this frame.
                var man = Man(box);
                f.Mac.Reply = Typed(point, parts[4], parts[5], parts[6], box);
                Set(f.App, "client", new ServiceClient(handler: f.Mac));
                if (man != null)
                {
                    string Number(float value) => value.ToString(CultureInfo.InvariantCulture);
                    f.Mac.Outlines = "{\"samples\":[{\"frameId\":\"" + near.FrameId + "\",\"seconds\":5.47,\"provider\":\"local\",\"model\":\"typed\",\"latencyMs\":1,"
                        + "\"leftOut\":0,\"verification\":\"proposed\",\"objects\":[{\"label\":\"person\",\"confidence\":0.5,\"origin\":\"base\","
                        + $"\"box\":{{\"x0\":{Number(man.X0)},\"y0\":{Number(man.Y0)},\"x1\":{Number(man.X1)},\"y1\":{Number(man.Y1)}}},\"contour\":[]}}]}}]}}";
                    var outlined = (Task)Invoke(f.App, "ReadOutlines", near.FrameId)!;
                    while (!outlined.IsCompleted) yield return null;
                    outlined.GetAwaiter().GetResult();
                }
                var turn = (Task)Invoke(f.App, "BoopWithoutWords", null, point, null)!;
                while (!turn.IsCompleted) yield return null;
                turn.GetAwaiter().GetResult();
                if (Get(f.App, "session") == null) throw new InvalidOperationException("The typed answer was not applied: " + f.Strip.FullText);
                // Heard before in ROOT's tents case: its line and "Heard it last time" under the word, then "Hold to answer". The
                // waits run 3.5 s on the app's clock: Boopy's home is chosen once the reply holds still, and moves at most once a second.
                f.App.PresentTask(PracticeTask(parts[4], parts[5], parts[6], heardBefore: man != null));
                for (var t = 0f; t < 3.5f; t += .05f)
                {
                    f.Console.RefreshVisuals(.05f); f.Strip.RefreshVisuals(.05f);
                    foreach (var word in f.Scene.GetComponentsInChildren<WordBlock>()) word.Refresh(.05f);
                    foreach (var pin in f.Scene.GetComponentsInChildren<BoopPin>()) pin.Refresh(.05f);
                    foreach (var overlay in f.Scene.GetComponentsInChildren<GroundedOverlay>()) overlay.RefreshVisuals(.05f);
                    yield return null;
                }
                MarkTyped(f);
                RequireRecordingLayout(f, "with the typed reply", point, man != null ? new[] { man } : null);
                Shot(f, Path.Combine(output, "boop-typed-reply.png"));
                if (f.Scene.TryGetWord(out var at))
                {
                    f.Eyes.rotation = Quaternion.LookRotation(at - f.Eyes.position, Vector3.up);
                    Shot(f, Path.Combine(output, "boop-typed-reply-word.png"), 40f);
                    f.Eyes.rotation = rest;
                }
                Debug.Log($"Boopy playback render: typed boop on {near.FrameId}, word {(f.Scene.TryGetWord(out _) ? "shown" : "none")}, paused {f.Picture.Paused}.");
                // A long line (150 characters or more) with Boopy at the frame's right: every caption line stays inside the
                // frame's sharp part, and the line pages there.
                f.Strip.Show(DialogueStage.Response, LongLine);
                for (var t = 0f; t < 3.5f; t += .05f) { f.Console.RefreshVisuals(.05f); f.Strip.RefreshVisuals(.05f); yield return null; }
                var plane = f.Picture.Plane; var seen = f.Picture.Readable; var lines = 0;
                foreach (var text in f.Strip.GetComponentsInChildren<TextMeshPro>())
                {
                    if (string.IsNullOrEmpty(text.text) || !text.GetComponent<MeshRenderer>().enabled) continue;
                    text.ForceMeshUpdate();
                    for (var l = 0; l < text.textInfo.lineCount; l++)
                    {
                        var line = text.textInfo.lineInfo[l];
                        if (line.visibleCharacterCount == 0) continue;
                        lines++;
                        foreach (var corner in new[] { new Vector3(line.lineExtents.min.x, line.descender), new Vector3(line.lineExtents.max.x, line.descender),
                            new Vector3(line.lineExtents.min.x, line.ascender), new Vector3(line.lineExtents.max.x, line.ascender) })
                        {
                            var toward = text.transform.TransformPoint(corner) - f.Picture.Eye;
                            if (!plane.TryImage(new System.Numerics.Vector3(f.Picture.Eye.x, f.Picture.Eye.y, f.Picture.Eye.z), new System.Numerics.Vector3(toward.x, toward.y, toward.z), out var x, out var y, out _)
                                || x < seen.X0 - .001f || x > seen.X1 + .001f || y < seen.Y0 - .001f || y > seen.Y1 + .001f)
                                throw new InvalidOperationException($"A caption line of the long reply runs outside the frame's sharp part: {text.name} line {l}.");
                        }
                    }
                }
                // The grown caption takes the first home clear of the pin and the word, by a caption line.
                for (var t = 0f; t < 3.5f; t += .05f) { f.Console.RefreshVisuals(.05f); f.Strip.RefreshVisuals(.05f); yield return null; }
                RequireRecordingLayout(f, "with the long caption", point, man != null ? new[] { man } : null);
                Shot(f, Path.Combine(output, "long-line.png"));
                Debug.Log($"Boopy playback render: long line of {LongLine.Length} characters inside the frame's sharp part, {lines} caption lines shown.");
                // The first tap after the answer plays the clip on.
                Invoke(f.App, "TapRecording", null, point, null, "render", false);
                foreach (var wait in Settle(30)) yield return wait;
                if (f.Picture.Paused) throw new InvalidOperationException("The first tap after the answer did not play the clip on.");
                Debug.Log("Boopy playback render: the first tap after the answer plays the clip on.");
            }
            Debug.Log("Boopy playback render frames: " + output);
        }

        private static IEnumerable Settle(int frames)
        {
            for (var i = 0; i < frames; i++) yield return null;
        }

        // A long line (150 characters or more), so Boopy's caption grows to several lines.
        internal const string LongLine = "The scene appears to be a desert camp at dusk, with a row of golden tents along the dune, "
            + "a guide standing left of centre, and soft sand rising toward a pale sky.";

        private static float Number(string text) => float.Parse(text, CultureInfo.InvariantCulture);

        // ROOT's tents boop (the loose box 0.534 to 0.815 by 0.014 to 0.514) at 5.47 s: the man there, a person at 0.345 to 0.47
        // by 0.11 to 0.69 (from ROOT's device runs), placed by the outline run's general list, not the model. Boopy's line keeps
        // a line off him.
        private static Box2? Man(Box2? box) => box != null && Math.Abs(box.X0 - .534f) < 1e-3f && Math.Abs(box.Y1 - .514f) < 1e-3f
            ? new Box2 { X0 = .345f, Y0 = .11f, X1 = .470f, Y1 = .69f } : null;

        // The small box a typed reply puts around the point when no box is given.
        private static Box2 SmallBox(Point2 point) => new Box2 { X0 = point.X - .02f, Y0 = point.Y - .025f, X1 = point.X + .02f, Y1 = point.Y + .025f };

        // The answer to the render's boop, typed from real facts for the picture: the subject at the booped point, the model's
        // box on it when given, else a small one around the point (no outline pass is read), and Boopy's line in the model's
        // usual shape.
        internal static SessionView Typed(Point2 point, string term, string termId, string guess, Box2? box = null, (string Label, Box2 Box)[]? others = null)
        {
            var view = new SessionView
            {
                Id = SessionId, State = "review", ReferentId = "subject", Model = new ModelRef { Provider = "typed", Id = "render" },
                Dialogue = new DialogueView { Speaker = "boopy", UtteranceId = "typed-turn", At = "1970-01-01T12:00:00Z",
                    Text = $"{guess}, I think. In Korean, that's {term}. Can you say it?" },
            };
            view.Utterances.Add(new UtteranceRef { Id = "typed-turn", Text = "", Kind = "ask" });
            view.Observations.Add(new ObservationRef { Id = ObservationId, CapturedAt = "1970-01-01T12:00:00Z" });
            view.Items.Add(new Item
            {
                Id = "subject", Kind = "object", Label = guess.ToLowerInvariant(), Statement = $"It may be a {guess.ToLowerInvariant()}.", Origin = "model",
                Status = "proposed", Confidence = .5f,
                Grounding = new Grounding { Kind = "box", ObservationId = ObservationId, Box = box ?? SmallBox(point) },
            });
            // Anything else the reply places on the frame, as the Mac's view does: proposed, by its box.
            foreach (var (label, at) in others ?? Array.Empty<(string, Box2)>())
                view.Items.Add(new Item
                {
                    Id = "other-" + view.Items.Count, Kind = "object", Label = label, Statement = $"It may be a {label}.", Origin = "model",
                    Status = "proposed", Confidence = .5f, Grounding = new Grounding { Kind = "box", ObservationId = ObservationId, Box = at },
                });
            return view;
        }

        // The practice task on that subject in the service's shape: the guess, the outside term from Zetaris and its source.
        internal static string PracticeTask(string term, string termId, string guess, bool heardBefore = false) =>
            "{" +
            $"\"taskId\":\"tsk_typed_render\",\"sessionId\":\"{SessionId}\",\"revision\":1," +
            "\"source\":{\"sourceId\":\"src_typed\",\"sourceRevision\":1,\"sha256\":\"" + new string('a', 64) + "\"}," +
            "\"intent\":\"consult_source\",\"utterance\":\"What is this?\",\"phase\":\"open\"," +
            "\"continuity\":\"local-only\",\"delivery\":\"not-sent\",\"subjectCorrected\":false," +
            "\"components\":[" +
            "{\"type\":\"subject\",\"sourceId\":\"src_typed\",\"maskId\":null}," +
            $"{{\"type\":\"annotation\",\"text\":\"{guess}\",\"evidenceIds\":[\"subject\"]}}," +
            $"{{\"type\":\"term\",\"text\":\"{term}\",\"language\":\"ko\",\"gloss\":\"{guess.ToLowerInvariant()}\",\"sourceId\":\"wikidata:{termId}\",\"revision\":\"1\"," +
            "\"retrievedAt\":\"1970-01-01T00:00:02.000Z\",\"license\":\"CC0-1.0\",\"via\":\"zetaris-local\",\"reviewed\":false,\"notHeardLastTime\":false," +
            $"\"heardLastTime\":{(heardBefore ? "true" : "false")}}}," +
            $"{{\"type\":\"dialogue\",\"text\":\"{(heardBefore ? $"{guess}, I think. Last time I heard {term}. Can you say it again?" : $"{guess}, I think. In Korean, that's {term}. Can you say it?")}\",\"evidenceIds\":[\"subject\"]}}," +
            "{\"type\":\"voice_reply\",\"prompt\":\"Answer.\"}," +
            "{\"type\":\"detail\",\"text\":\"Wikidata · Zetaris\"}," +
            "{\"type\":\"status\",\"code\":\"not-sent\"}" +
            "],\"attempts\":[],\"lastRejection\":null" +
            "}";

        // The shot says it shows a typed reply: a small line low in the view, in the render only.
        private static void MarkTyped(Fixture f)
        {
            var note = SpatialTheme.Text(f.Eyes, "Typed reply note", SpatialTheme.Utility, SpatialTheme.Ember);
            note.text = "Reply typed for this render; no turn reached the Mac";
            note.alignment = TextAlignmentOptions.Center;
            note.textWrappingMode = TextWrappingModes.NoWrap;
            note.rectTransform.sizeDelta = new Vector2(20f, 1f);
            note.transform.localPosition = new Vector3(0f, -.55f, 1f);
            note.transform.localScale = Vector3.one * (.02f / Mathf.Max(1e-5f, note.fontSize / 10f));
            note.sortingOrder = 50;
        }

        // Stops the clip and moves it to a time, then lets the frame there reach the picture and its blur.
        private static IEnumerable Seek(VideoPlayer player, float seconds)
        {
            player.Pause();
            var landed = false;
            void Done(VideoPlayer _) => landed = true;
            player.seekCompleted += Done;
            player.time = seconds;
            var since = EditorApplication.timeSinceStartup;
            while (!landed && EditorApplication.timeSinceStartup - since < 10) yield return null;
            player.seekCompleted -= Done;
            for (var i = 0; i < 10; i++) yield return null;
        }

        private static void Shot(Fixture f, string path, float tall = TallDegrees)
        {
            foreach (var text in f.Root.GetComponentsInChildren<TextMeshPro>()) text.ForceMeshUpdate(true, true);
            f.Console.RefreshVisuals(0f); f.Strip.RefreshVisuals(0f);
            var camera = f.Eyes.gameObject.TryGetComponent<Camera>(out var existing) ? existing : f.Eyes.gameObject.AddComponent<Camera>();
            camera.nearClipPlane = .05f; camera.farClipPlane = 200f; camera.clearFlags = CameraClearFlags.SolidColor;
            // Grey, so any gap in the surround shows.
            camera.backgroundColor = new Color(.42f, .44f, .45f); camera.allowHDR = false; camera.allowMSAA = false;
            camera.fieldOfView = tall;
            var target = new RenderTexture(Width, Height, 24); target.Create();
            var image = new Texture2D(Width, Height, TextureFormat.RGB24, false);
            var previous = RenderTexture.active;
            try
            {
                camera.targetTexture = target; camera.Render();
                RenderTexture.active = target; image.ReadPixels(new Rect(0, 0, Width, Height), 0, 0); image.Apply();
                File.WriteAllBytes(path, image.EncodeToPNG());
                Debug.Log("Boopy playback render shot: " + Path.GetFileName(path));
            }
            finally
            {
                camera.targetTexture = null; RenderTexture.active = previous;
                target.Release(); UnityEngine.Object.DestroyImmediate(target); UnityEngine.Object.DestroyImmediate(image);
            }
        }

        private static void Fail(Exception error)
        {
            Debug.LogException(error);
            Finish(1);
        }

        private static void Finish(int code)
        {
            EditorApplication.update -= Tick;
            steps = null;
            try { fixture?.Dispose(); } catch (Exception) { }
            fixture = null;
            SynchronizationContext.SetSynchronizationContext(context);
            if (Application.isBatchMode) EditorApplication.Exit(code);
        }
    }
}
