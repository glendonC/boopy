#nullable enable
using System;
using System.Linq;
using System.Threading;
using Boopy.Client;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using static Boopy.Quest.Editor.RecordedSceneValidation;

namespace Boopy.Quest.Editor
{
    /// <summary>
    /// The look on a subject in a recorded picture (DESIGN's spec, Settled and Plain words): the word sits on the subject in
    /// the picture's plane in place of a chip, its ink read from the still, the outline carries a Graphite halo on footage,
    /// what Boopy heard in an answer plays once on the word and on Boopy, "Didn't hear it last time" shows on a later turn,
    /// and the console docks beside the picture. Synthetic stills, words and transport only.
    /// </summary>
    public static class RecordedLookValidation
    {
        private const string Term = "낙타", Guess = "Camel", Source = "Wikidata · Zetaris";

        public static void Validate()
        {
            var context = SynchronizationContext.Current;
            try
            {
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                ScriptCoverage.Install();
                SynchronizationContext.SetSynchronizationContext(null);
                ValidateInk();
                using (var f = new Fixture()) ValidateWord(f);
                using (var dark = new Fixture()) ValidateDarkStill(dark);
                using (var busy = new Fixture()) ValidateBusyStill(busy);
                Debug.Log("Boopy recorded look validation passed (synthetic stills, words and transport).");
            }
            catch (Exception error)
            {
                Debug.LogException(error);
                if (Application.isBatchMode) EditorApplication.Exit(1);
                else throw;
            }
            finally { SynchronizationContext.SetSynchronizationContext(context); }
        }

        // The ink rule on its own: dark ink on bright footage, light on dark, a scrim only where neither reaches 4.5:1.
        private static void ValidateInk()
        {
            Require(WordBlock.Choose(.55f, .80f) == (WordBlock.Graphite, false), "Bright footage does not take Graphite ink.");
            Require(WordBlock.Choose(.002f, .02f) == (WordBlock.Frost, false), "Dark footage does not take Frost ink.");
            Require(WordBlock.Choose(.08f, .35f).Scrim, "Footage neither ink reads on does not get a scrim.");
        }

        private static void ValidateWord(Fixture f)
        {
            f.Mac.Scene = SceneJson(FrameA, f.StillA);
            f.ReadScene();
            var plane = f.Picture.Plane;
            Look(f, plane.At(.42f, .63f));
            // The recording fills the view as the room would: a turn on it puts the console at its usual home, in view and
            // in front of the picture.
            Invoke(f.App, "OpenTurn");
            var place = f.Console.Destination;
            var off = Vector3.Angle(f.Eyes.forward, place - f.Eyes.position);
            var away = Vector3.Distance(f.Eyes.position, place);
            Require(off < 40f && away < RecordedPicture.Distance - 1f,
                $"The console is not in view in front of the recording: {off:0.0} degrees off the eyes, {away:0.00} m away.");
            Invoke(f.App, "CloseTurn");
            Invoke(f.App, "Capture", new object?[] { null });
            f.Send(f.Reply("box"));
            Require(f.App.GetType().GetMethod("PresentTask") != null, "BoopyApp cannot present a task.");
            f.App.PresentTask(Task(1, "Camel, I think. In Korean, that's 낙타. Can you say it?"));
            Settle(f);

            // The word on the subject, in place of the chip.
            Require(f.Scene.GetComponentsInChildren<Chip>(true).All(chip => !chip.gameObject.activeInHierarchy), "A subject on the picture has a chip.");
            var word = f.Scene.GetComponentsInChildren<WordBlock>(true).Single(block => block.gameObject.activeInHierarchy);
            Require(word.Term == Term && word.Guess == Guess && word.Source == Source && !word.Remembers,
                $"The word shows \"{word.Term}\" / \"{word.Guess}\" / \"{word.Source}\", remembers {word.Remembers}.");
            Require(OffPlane(plane, word.transform.position) < .004f, "The word is not in the picture's plane.");
            var center = ImageOf(plane, word.transform.position);
            var half = new Vector2(word.Size.x / plane.Width, word.Size.y / plane.Height) / 2f;
            Require(center.y + half.y <= SubjectBox.Y0 + .001f && center.x - half.x >= 0f && center.x + half.x <= 1f && center.y - half.y >= 0f,
                $"The word is not above the subject inside the picture: {center}, half {half}.");
            var distance = Vector3.Distance(f.Eyes.position, word.transform.position);
            var termText = word.GetComponentsInChildren<TextMeshPro>(true).Single(text => text.name == "Term");
            var termDegrees = 2f * Mathf.Atan(termText.fontSize / 10f * termText.transform.lossyScale.y / 2f / distance) * Mathf.Rad2Deg;
            Require(termDegrees > 1.7f && termDegrees < 2.3f, $"The word's em is {termDegrees:0.00} degrees, not about 2.");
            termText.ForceMeshUpdate(true, true);
            var drawn = termText.textInfo.characterInfo.Take(termText.textInfo.characterCount).Where(character => !char.IsWhiteSpace(character.character)).ToArray();
            Require(drawn.All(character => character.fontAsset != null && character.fontAsset.name.StartsWith("IBMPlexSansKR-Medium", StringComparison.Ordinal)),
                "The word is not drawn in IBM Plex Sans KR Medium.");
            // The synthetic still is bright sky above the subject: dark ink, no scrim.
            Require(word.Ink == WordBlock.Graphite && !word.Scrimmed, "The word over bright sky does not take Graphite ink.");
            Require(SingleOverlay(f).Haloed, "The outline on footage has no Graphite halo.");
            Require(SingleOverlay(f).GetComponentsInChildren<LineRenderer>(true).Single(line => line.name == "Observed boundary").sharedMaterial == Visuals.Solid,
                "The outline on footage keeps a soft edge, which lets its halo through so it reads grey.");
            NeverNow(f, "with the word on the picture");

            // Boopy did not catch the word: the word brightens once and Boopy points at it; no memory line yet.
            f.App.PresentTask(Task(2, "I didn't catch 낙타 there. Try again?", Attempt("evt_first", "not-heard"), notHeardLastTime: true, replies: "evt_first"));
            Settle(f);
            Require(!word.Remembers, "The memory line shows on Boopy's own reply to the answer.");
            Require(f.Console.Reaction == "not-heard", "Boopy does not point at the word it did not hear: " + f.Console.Reaction);
            word.Refresh(.2f);
            Require(word.Brightness > .9f, "The word does not brighten when Boopy did not catch it.");
            // The brighten is a glow behind the word; the word keeps its ink, so it keeps its contrast.
            Require(word.GetComponentsInChildren<TextMeshPro>(true).Single(text => text.name == "Term").color == word.Ink, "A brighten changed the word's ink.");
            word.Refresh(.3f);
            Require(word.Brightness == 0f, "The word stays bright.");
            // The same view again plays nothing again.
            f.Console.RefreshVisuals(2f);
            Invoke(f.App, "ShowTask");
            Require(f.Console.Reaction == null, "The same answer's moment played twice.");

            // Boopy heard the word: the word and the outline brighten once and Boopy hops.
            f.App.PresentTask(Task(3, "I heard 낙타.", Attempt("evt_second", "heard"), replies: "evt_second"));
            Settle(f);
            Require(f.Console.Reaction == "heard", "Boopy does not hop when it heard the word: " + f.Console.Reaction);
            word.Refresh(.2f); SingleOverlay(f).RefreshVisuals(.2f);
            Require(word.Brightness > .9f && SingleOverlay(f).Brightness > .9f, "The word and the outline do not brighten when Boopy heard it.");
            word.Refresh(.5f); SingleOverlay(f).RefreshVisuals(.5f); f.Console.RefreshVisuals(2f);

            // No word of the language in the answer: Boopy tilts toward the person; nothing changes on the subject.
            f.App.PresentTask(Task(4, "I didn't hear any Korean there. Try again?", Attempt("evt_third", "unclear"), replies: "evt_third"));
            Settle(f);
            Require(f.Console.Reaction == "unclear" && word.Brightness == 0f, "An unclear answer did not tilt Boopy, or lit the word.");
            f.Console.RefreshVisuals(2f);

            // A later turn on the same subject remembers the miss: the line under the word, and its Ember underline.
            f.App.PresentTask(Task(5, "Last time 낙타 didn't come through. Want to try again?", Attempt("evt_third", "not-heard"), notHeardLastTime: true));
            Settle(f);
            var underline = word.GetComponentsInChildren<LineRenderer>(true).Single(line => line.name == "Memory underline");
            Require(word.Remembers && underline.enabled && word.GetComponentsInChildren<TextMeshPro>(true).Any(text => text.gameObject.activeSelf && text.text == WordBlock.Memory),
                "A later turn does not say \"Didn't hear it last time\" with the underline.");
            NeverNow(f, "with the memory on the word");
        }

        // A dark still takes Frost ink.
        private static void ValidateDarkStill(Fixture f)
        {
            var dark = Still(new Color(.06f, .06f, .07f));
            f.Mac.Stills[FrameB] = dark;
            f.Mac.Scene = SceneJson(FrameB, dark);
            f.ReadScene();
            Look(f, f.Picture.Plane.At(.42f, .63f));
            Invoke(f.App, "Capture", new object?[] { null });
            f.Send(f.Reply("box"));
            f.App.PresentTask(Task(1, "Camel, I think. In Korean, that's 낙타. Can you say it?"));
            Settle(f);
            var word = f.Scene.GetComponentsInChildren<WordBlock>(true).Single(block => block.gameObject.activeInHierarchy);
            Require(word.Ink == WordBlock.Frost && !word.Scrimmed, "The word over a dark still does not take Frost ink.");
        }

        // Busy detail right above the subject (stripes, like a rider's arm against the sky): the word climbs above it, every
        // line on calm pixels, never across it.
        private static void ValidateBusyStill(Fixture f)
        {
            const float BandTop = .26f;
            var texture = new Texture2D(Width, Height, TextureFormat.RGB24, false);
            byte[] still;
            try
            {
                var pixels = new Color32[Width * Height];
                for (var y = 0; y < Height; y++)
                    for (var x = 0; x < Width; x++)
                    {
                        var v = 1f - (y + .5f) / Height;
                        pixels[y * Width + x] = v < BandTop ? new Color(.80f, .86f, .92f) : v < SubjectBox.Y0 ? ((x / 6) % 2 == 0 ? Color.black : Color.white) : new Color(.80f, .64f, .44f);
                    }
                texture.SetPixels32(pixels); texture.Apply();
                still = texture.EncodeToJPG(95);
            }
            finally { UnityEngine.Object.DestroyImmediate(texture); }
            f.Mac.Stills[FrameB] = still;
            f.Mac.Scene = SceneJson(FrameB, still);
            f.ReadScene();
            var plane = f.Picture.Plane;
            Look(f, plane.At(.42f, .63f));
            Invoke(f.App, "Capture", new object?[] { null });
            f.Send(f.Reply("box"));
            f.App.PresentTask(Task(1, "Camel, I think. In Korean, that's 낙타. Can you say it?"));
            Settle(f);
            var word = f.Scene.GetComponentsInChildren<WordBlock>(true).Single(block => block.gameObject.activeInHierarchy);
            var center = ImageOf(plane, word.transform.position);
            Require(center.y + word.Size.y / plane.Height / 2f <= BandTop + .01f,
                $"The word crosses busy detail above the subject: its bottom at {center.y + word.Size.y / plane.Height / 2f:0.000}, the detail from {BandTop}.");
        }

        private static byte[] Still(Color color)
        {
            var texture = new Texture2D(Width, Height, TextureFormat.RGB24, false);
            try
            {
                texture.SetPixels32(Enumerable.Repeat((Color32)color, Width * Height).ToArray()); texture.Apply();
                return texture.EncodeToJPG(90);
            }
            finally { UnityEngine.Object.DestroyImmediate(texture); }
        }

        private static string Attempt(string eventId, string heard) =>
            $"{{\"eventId\":\"{eventId}\",\"text\":\"synthetic\",\"recognitionUncertain\":true,\"kind\":\"practice-attempt\",\"heard\":\"{heard}\"}}";

        // A practice task on the fixture's subject, in the service's shape: Boopy's guess, the outside term and its source.
        private static string Task(int revision, string line, string? attempt = null, bool notHeardLastTime = false, string? replies = null) =>
            "{" +
            $"\"taskId\":\"tsk_synthetic_practice\",\"sessionId\":\"{SessionId}\",\"revision\":{revision}," +
            "\"source\":{\"sourceId\":\"src_synthetic\",\"sourceRevision\":1,\"sha256\":\"" + new string('a', 64) + "\"}," +
            "\"intent\":\"consult_source\",\"utterance\":\"What is this?\",\"phase\":\"open\"," +
            "\"continuity\":\"local-only\",\"delivery\":\"not-sent\",\"subjectCorrected\":false," +
            "\"components\":[" +
            "{\"type\":\"subject\",\"sourceId\":\"src_synthetic\",\"maskId\":null}," +
            $"{{\"type\":\"annotation\",\"text\":\"{Guess}\",\"evidenceIds\":[\"subject\"]}}," +
            $"{{\"type\":\"term\",\"text\":\"{Term}\",\"language\":\"ko\",\"gloss\":\"camel\",\"sourceId\":\"wikidata:Q7375\",\"revision\":\"101\"," +
            "\"retrievedAt\":\"1970-01-01T00:00:02.000Z\",\"license\":\"CC0-1.0\",\"via\":\"zetaris-local\",\"reviewed\":false," +
            $"\"notHeardLastTime\":{(notHeardLastTime ? "true" : "false")}}}," +
            $"{{\"type\":\"dialogue\",\"text\":\"{line}\",\"evidenceIds\":[{(replies != null ? "\"" + replies + "\"" : "\"subject\"")}]}}," +
            "{\"type\":\"voice_reply\",\"prompt\":\"Answer.\"}," +
            $"{{\"type\":\"detail\",\"text\":\"{Source}\"}}," +
            "{\"type\":\"status\",\"code\":\"not-sent\"}" +
            $"],\"attempts\":[{attempt ?? ""}],\"lastRejection\":null" +
            "}";

        private static Vector3 Unity(System.Numerics.Vector3 value) => new Vector3(value.X, value.Y, value.Z);
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
