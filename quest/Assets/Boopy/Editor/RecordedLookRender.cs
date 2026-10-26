#nullable enable
using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using Newtonsoft.Json.Linq;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using static Boopy.Quest.Editor.RecordedSceneValidation;

namespace Boopy.Quest.Editor
{
    /// <summary>
    /// DESIGN's four frames for the owner's picture, on the owner's real stills and a real rehearsal's replies (captured as
    /// JSON by the service, its turn words typed and its answers synthetic speech, declared with the picture): A the first
    /// result on the camel, B Boopy's reply to an answer it did not catch, C a later turn that remembers it, D a still from
    /// the ATV clip. Each frame is drawn through the app's own path (the recorded picture, the turn, the task) from one head
    /// pose, plus a 2x crop of the subject and its word. Reads BOOPY_RECORDED_VIEWS (the captured JSON),
    /// BOOPY_RECORDED_FRAME and BOOPY_RECORDED_FRAME_D (the camel and ATV stills, absolute paths) and writes only to
    /// BOOPY_RENDER_DIR, which must already exist as a private folder. Logs name the output folder only.
    /// </summary>
    public static class RecordedLookRender
    {
        private const int Width = 1600, Height = 900;

        public static void Render()
        {
            var context = SynchronizationContext.Current;
            try
            {
                string Folder(string name) => Environment.GetEnvironmentVariable(name) is string dir && Directory.Exists(dir) ? dir
                    : throw new InvalidOperationException(name + " must name an existing private folder.");
                string Still(string name) => Environment.GetEnvironmentVariable(name) is string path && Path.IsPathRooted(path) && File.Exists(path) ? path
                    : throw new InvalidOperationException(name + " must be an absolute path to a still.");
                var views = Folder("BOOPY_RECORDED_VIEWS"); var output = Folder("BOOPY_RENDER_DIR");
                var camel = File.ReadAllBytes(Still("BOOPY_RECORDED_FRAME")); var atvs = File.ReadAllBytes(Still("BOOPY_RECORDED_FRAME_D"));
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                ScriptCoverage.Install();
                SynchronizationContext.SetSynchronizationContext(null);
                using var f = new Fixture();
                string View(string name) => File.ReadAllText(Path.Combine(views, name));

                // A: the first result on the camel.
                Boop(f, JObject.Parse(View("scene-camel.json")), camel, View("A-session.json"));
                f.App.PresentTask(View("A-task.json"));
                Pose(f, 1f);
                Expect(f, "A", word => word.Term.Length > 0 && word.Guess.Length > 0 && !word.Remembers);
                Frame(f, output, "A");
                // B: Boopy's reply to an answer it did not catch: the word brightens and Boopy points at it.
                f.App.PresentTask(View("B-task.json"));
                Pose(f, .2f);
                Expect(f, "B", word => word.Brightness > .5f && !word.Remembers && f.Console.Reaction == "not-heard");
                Frame(f, output, "B");
                // C: a later conversation on the same subject remembers the miss (the Mac's memory, not this headset's).
                Pose(f, 2f);
                Set(f.App, "session", null);
                Turn(f, View("C-session.json"));
                f.App.PresentTask(View("C-task.json"));
                Pose(f, 1f);
                Expect(f, "C", word => word.Term.Length > 0 && word.Remembers);
                Frame(f, output, "C");
                // D: a still from the ATV clip, a new conversation on the small quad bike the person looks at.
                Set(f.App, "session", null);
                Boop(f, JObject.Parse(View("scene-atvs.json")), atvs, View("D-session.json"));
                f.App.PresentTask(View("D-task.json"));
                Pose(f, 1f);
                Expect(f, "D", word => word.Term.Length > 0 && word.Guess.Length > 0 && !word.Remembers);
                Frame(f, output, "D");
                Debug.Log("Boopy recorded look frames: " + output);
            }
            catch (Exception error)
            {
                Debug.LogException(error);
                if (Application.isBatchMode) EditorApplication.Exit(1);
                else throw;
            }
            finally { SynchronizationContext.SetSynchronizationContext(context); }
        }

        // The Mac shows the captured frame (a clip's scene stopped on the frame the rehearsal asked about); the eyes rest where
        // the rehearsal's gaze was; a turn opens there and its reply comes back.
        private static void Boop(Fixture f, JObject scene, byte[] still, string session)
        {
            var shown = (JObject)scene["scene"]!.DeepClone();
            var frame = scene["frame"]!;
            var frameId = (string)frame["frameId"]!;
            shown["frameId"] = frameId;
            shown["frameSha256"] = frame["frameSha256"];
            if ((string?)shown["kind"] == "video") shown["sourceTimeSeconds"] = frame["seconds"];
            f.Mac.Stills[frameId] = still;
            f.Mac.Scene = new JObject { ["scene"] = shown }.ToString();
            f.ReadScene();
            // The app refuses a still that is not the scene's frame and keeps the last one, so check it is this one.
            if (!f.Picture.Showing || f.Picture.Scene?.FrameId != frameId) throw new InvalidOperationException("The captured still did not show.");
            Look(f, f.Picture.Plane.At((float)scene["gaze"]!["x"]!, (float)scene["gaze"]!["y"]!));
            Turn(f, session);
        }

        private static void Turn(Fixture f, string session)
        {
            Invoke(f.App, "OpenTurn");
            Invoke(f.App, "Capture", new object?[] { null });
            f.Mac.Reply = Wire.Read<SessionView>(session);
            Set(f.App, "pendingEvidence", new EvidenceTurn(false));
            ((Task)Invoke(f.App, "Send", SpeechValidation.SyntheticWav())!).GetAwaiter().GetResult();
            if (Get(f.App, "session") == null) throw new InvalidOperationException("The captured reply was not applied: " + f.Strip.FullText);
            Pose(f, 1f);
        }

        // Lets the line change, the console settle and Boopy's moment reach its pose.
        private static void Pose(Fixture f, float seconds)
        {
            for (var t = 0f; t < seconds; t += .05f)
            {
                f.Console.RefreshVisuals(.05f); f.Strip.RefreshVisuals(.05f);
                foreach (var word in f.Scene.GetComponentsInChildren<WordBlock>()) word.Refresh(.05f);
                foreach (var overlay in f.Scene.GetComponentsInChildren<GroundedOverlay>()) overlay.RefreshVisuals(.05f);
            }
            Hold(f);
        }

        // Text and colliders up to date without moving time on, so Boopy's moment is still on when the frame is taken.
        private static void Hold(Fixture f)
        {
            foreach (var text in f.Root.GetComponentsInChildren<TextMeshPro>()) text.ForceMeshUpdate(true, true);
            f.Console.RefreshVisuals(0f); f.Strip.RefreshVisuals(0f);
            Physics.SyncTransforms();
        }

        // What each frame must show, checked here because QUEST never opens a still of the owner's footage: the frame's word,
        // and the console clear of the picture as seen from the eyes. Counts and flags only go to the log.
        private static void Expect(Fixture f, string name, Func<WordBlock, bool>? shows)
        {
            Hold(f);
            var word = UnityEngine.Object.FindObjectsByType<WordBlock>(FindObjectsSortMode.None);
            var shown = Array.Find(word, block => block.gameObject.activeInHierarchy);
            if (shows != null && (shown == null || !shows(shown)))
                throw new InvalidOperationException($"Frame {name} does not show what it should (word {(shown != null ? "present" : "missing")}, "
                    + $"brightness {shown?.Brightness:0.00}, remembers {shown?.Remembers}, reaction {f.Console.Reaction ?? "none"}).");
            var plane = f.Picture.Plane;
            var edge = f.Eyes.InverseTransformPoint(new Vector3(plane.At(1f, .5f).X, plane.At(1f, .5f).Y, plane.At(1f, .5f).Z));
            var console = f.Eyes.InverseTransformPoint(f.Console.transform.position) - Vector3.right * (f.Console.LayoutSize.x / 2f);
            if (Mathf.Atan2(console.x, console.z) <= Mathf.Atan2(edge.x, edge.z))
                throw new InvalidOperationException($"Frame {name}: the console covers the picture.");
            Debug.Log(shown == null ? $"Boopy recorded look frame {name}: no word (no subject grounded)."
                : $"Boopy recorded look frame {name}: ink {(shown.Ink == WordBlock.Graphite ? "graphite" : "frost")}, scrim {shown.Scrimmed}, remembers {shown.Remembers}, reaction {f.Console.Reaction ?? "none"}.");
        }

        // One frame from the head pose, and a 2x crop on the subject's word (or its anchor when no word shows).
        private static void Frame(Fixture f, string output, string name)
        {
            Hold(f);
            var camera = f.Eyes.gameObject.TryGetComponent<Camera>(out var existing) ? existing : f.Eyes.gameObject.AddComponent<Camera>();
            camera.nearClipPlane = .05f; camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(.42f, .44f, .45f); camera.allowHDR = false; camera.allowMSAA = false;
            var rest = f.Eyes.rotation;
            // Framed on the picture and the docked console together, from the same eyes, so nothing runs off the frame.
            var plane = f.Picture.Plane;
            var corners = new[] { plane.At(0f, 0f), plane.At(1f, 0f), plane.At(0f, 1.08f), plane.At(1f, 1.08f) }
                .Select(point => new Vector3(point.X, point.Y, point.Z)).ToList();
            var console = f.Console.transform; var half = f.Console.LayoutSize / 2f;
            var middle = console.position + console.up * f.Console.LayoutCenterOffset;
            foreach (var x in new[] { -1f, 1f }) foreach (var y in new[] { -1f, 1f }) corners.Add(middle + console.right * (half.x * x) + console.up * (half.y * y));
            var directions = corners.Select(point => (point - f.Eyes.position).normalized).ToList();
            var center = directions.Aggregate(Vector3.zero, (sum, direction) => sum + direction).normalized;
            f.Eyes.rotation = Quaternion.LookRotation(center, Vector3.up);
            float wide = 0f, tall = 0f;
            foreach (var direction in directions)
            {
                var local = f.Eyes.InverseTransformDirection(direction);
                wide = Mathf.Max(wide, Mathf.Abs(Mathf.Atan2(local.x, local.z)));
                tall = Mathf.Max(tall, Mathf.Abs(Mathf.Atan2(local.y, local.z)));
            }
            var aspect = (float)Width / Height;
            var needed = Mathf.Max(tall, Mathf.Atan(Mathf.Tan(wide) / aspect)) * 1.08f;
            camera.fieldOfView = Mathf.Clamp(2f * needed * Mathf.Rad2Deg, 40f, 90f);
            Shot(camera, Path.Combine(output, name + ".png"));
            var target = f.Scene.TryGetWord(out var word) ? word : f.Scene.TryGetActiveAnchor(out var anchor) ? anchor : f.Picture.transform.position;
            f.Eyes.rotation = Quaternion.LookRotation(target - f.Eyes.position, Vector3.up);
            camera.fieldOfView = 30f;
            Shot(camera, Path.Combine(output, name + "-crop.png"));
            f.Eyes.rotation = rest;
        }

        private static void Shot(Camera camera, string path)
        {
            var target = new RenderTexture(Width, Height, 24); target.Create();
            var image = new Texture2D(Width, Height, TextureFormat.RGB24, false);
            var previous = RenderTexture.active;
            try
            {
                foreach (var text in UnityEngine.Object.FindObjectsByType<TextMeshPro>(FindObjectsSortMode.None)) text.ForceMeshUpdate(true, true);
                camera.targetTexture = target; camera.Render();
                RenderTexture.active = target; image.ReadPixels(new Rect(0, 0, Width, Height), 0, 0); image.Apply();
                File.WriteAllBytes(path, image.EncodeToPNG());
            }
            finally
            {
                camera.targetTexture = null; RenderTexture.active = previous;
                target.Release(); UnityEngine.Object.DestroyImmediate(target); UnityEngine.Object.DestroyImmediate(image);
            }
        }
    }
}
