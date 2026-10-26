#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using Newtonsoft.Json.Linq;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>
    /// A recorded scene in the room: the Mac shows a still of the person's own recording, the headset shows it as a picture,
    /// and a turn on it is about that still. Synthetic picture and synthetic transport only; no camera, microphone or
    /// device. Render() writes stills, of the owner's own still only when BOOPY_RECORDED_FRAME names one.
    /// </summary>
    public static class RecordedSceneValidation
    {
        private const BindingFlags Flags = BindingFlags.Instance | BindingFlags.NonPublic;
        private const string Health = "{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}}";
        internal const string RecordingId = "rec_0123456789abcdef0123456789abcdef";
        internal const string FrameA = "rfr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", FrameB = "rfr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        internal const string SessionId = "ses_synthetic_recorded", ObservationId = "obs_synthetic_recorded";
        internal const int Width = 640, Height = 480;
        // The subject's box and its mask on the synthetic still, in image coordinates (0 to 1, origin top-left).
        internal static readonly Box2 SubjectBox = new Box2 { X0 = .30f, Y0 = .45f, X1 = .55f, Y1 = .80f };
        private static readonly (float X, float Y)[] SubjectMask = { (.32f, .78f), (.36f, .50f), (.47f, .46f), (.54f, .62f), (.50f, .79f) };
        // A recorded still is never the room as it is now: no visible words may say so while it shows (X13, QP-1).
        private static readonly Regex NotRecorded = new Regex(@"\b(here|now|live)\b|in front of you|in your room", RegexOptions.IgnoreCase);

        public static void Validate()
        {
            var context = SynchronizationContext.Current;
            try
            {
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                ScriptCoverage.Install();
                SynchronizationContext.SetSynchronizationContext(null);
                using (var live = new Fixture()) ValidateLiveStaysInTheRoom(live);
                ValidateController();
                using var f = new Fixture();
                ValidateScene(f);
                Debug.Log("Boopy recorded scene validation passed (synthetic still and transport; no camera, microphone or device).");
            }
            catch (Exception error)
            {
                Debug.LogException(error);
                if (Application.isBatchMode) EditorApplication.Exit(1);
                else throw;
            }
            finally { SynchronizationContext.SetSynchronizationContext(context); }
        }

        // With a Touch controller held the headset tracks no hand: its trigger is the pinch, held to talk, and the ray goes
        // where the controller points. Without focus, or with neither a hand nor a held controller, nothing pinches.
        private static void ValidateController()
        {
            var eyes = new GameObject("Controller check eyes");
            try
            {
                var hand = new HandInput(true, null, null);
                var pose = new Vector3(.2f, -.3f, .3f); var forward = new Vector3(0f, .2f, 1f);
                HandInput.Controller Pull(float trigger) => new HandInput.Controller(true, trigger, pose, forward);
                Require(hand.Update(eyes.transform, 0f, true, Pull(1f)) == PinchEvent.Began && hand.RayActive
                    && Vector3.Distance(hand.Ray.origin, pose) < 1e-5f && Vector3.Angle(hand.Ray.direction, forward) < .01f,
                    "A held controller's trigger does not begin a pinch along the controller.");
                Require(hand.Update(eyes.transform, .5f, true, Pull(1f)) == PinchEvent.Holding, "A held trigger does not talk.");
                Require(hand.Update(eyes.transform, .6f, true, Pull(0f)) == PinchEvent.Released, "Letting the trigger go does not end the talk.");
                Require(hand.Update(eyes.transform, 1f, false, Pull(1f)) == PinchEvent.None, "A controller pinches without input focus.");
                var idle = new HandInput(false, null, null);
                Require(idle.Update(eyes.transform, 0f, true) == PinchEvent.None && !idle.RayActive, "Nothing is held, yet something pinches.");
            }
            finally { UnityEngine.Object.DestroyImmediate(eyes); }
        }

        private static void ValidateScene(Fixture f)
        {
            // The Mac shows a still: the headset reads it, checks its digest, and shows it as a picture ahead.
            f.Mac.Scene = SceneJson(FrameA, f.StillA);
            f.ReadScene();
            Require(f.Picture.Showing && f.Picture.Scene!.FrameId == FrameA, "The recorded still the Mac shows is not shown.");
            var plane = f.Picture.Plane;
            Require(Vector3.Distance(Unity(plane.Center), new Vector3(0f, 0f, RecordedPicture.Distance)) < .001f,
                "The picture is not ahead of the person at eye level: " + Unity(plane.Center));
            Require(Mathf.Abs(plane.Width / plane.Height - (float)Width / Height) < .001f, "The picture lost its still's aspect.");
            // It fills the view as the room would: taller from the eyes than the headset's view (about 96 degrees), with the
            // room covered around it in every direction and the cover drawn before the picture.
            var pictureTall = 2f * Mathf.Atan(plane.Height / 2f / RecordedPicture.Distance) * Mathf.Rad2Deg;
            Require(pictureTall >= 96f, $"The picture does not fill the view from top to bottom: {pictureTall:0.0} degrees tall.");
            var renderers = f.Picture.GetComponentsInChildren<MeshRenderer>(true);
            var cover = renderers.Single(renderer => renderer.name == "Room cover");
            var face = renderers.Single(renderer => renderer.name == "Recorded picture");
            Require(cover.gameObject.activeInHierarchy && cover.enabled && cover.bounds.Contains(f.Eyes.position)
                && new[] { plane.At(0f, 0f), plane.At(1f, 0f), plane.At(0f, 1f), plane.At(1f, 1f) }.All(corner => cover.bounds.Contains(Unity(corner)))
                && cover.sortingOrder < face.sortingOrder, "The room is not covered around the recording.");
            // No words on the picture: a photo's only cue is the one word "Recorded", in the lower-left of the view, and it
            // stays there when the head turns. It has no player bar.
            var marks = f.Picture.GetComponentsInChildren<TextMeshPro>(true).Where(text => text.gameObject.activeInHierarchy).ToArray();
            Require(marks.Length == 1 && marks[0].text == RecordedPicture.Mark && InCorner(f, marks[0].transform.position),
                "A photo does not show only its Recorded mark in the corner of the view.");
            var rest = f.Eyes.rotation;
            f.Eyes.rotation = Quaternion.Euler(-10f, 30f, 0f) * rest;
            f.Picture.Follow(f.Eyes, null, float.PositiveInfinity);
            Require(InCorner(f, marks[0].transform.position), "The Recorded mark does not stay in view when the head turns.");
            f.Eyes.rotation = rest;
            f.Picture.Follow(f.Eyes, null, float.PositiveInfinity);
            Require(f.Picture.Held == null && Bars(f).All(bar => !bar.gameObject.activeInHierarchy), "A photo shows a player bar.");
            NeverNow(f, "with the picture shown");

            // With a recorded scene showing, the live room scene is off and a picture turn needs no room camera.
            Set(f.App, "connectionLiveSceneAvailable", (bool?)true);
            Require(!(bool)Prop(f.App, "AmbientSceneAllowed")!, "The live room scene stays on while a recorded scene shows.");
            Require(!(bool)Invoke(f.App, "CameraMissing", new EvidenceTurn(false))!, "A recorded scene's turn still asks for the room camera.");

            // The gaze on the picture: the turn takes the still and the gaze point on it, and nothing from the room.
            Look(f, plane.At(.42f, .63f));
            Invoke(f.App, "Capture", new object?[] { null });
            var pending = (Snapshot?)Get(f.App, "pending");
            var cues = (Cues?)Get(f.App, "pendingCues");
            Require(pending?.Recorded?.FrameId == FrameA && pending.Picture != null, "A turn on the picture did not take its recorded still.");
            Require(cues?.Gaze != null && Mathf.Abs(cues.Gaze.Point.X - .42f) < .001f && Mathf.Abs(cues.Gaze.Point.Y - .63f) < .001f,
                "The gaze point on the still is off: " + (cues?.Gaze == null ? "none" : cues.Gaze.Point.X + ", " + cues.Gaze.Point.Y));
            Require(cues!.Gaze!.World == null && !cues.Gaze.OnSurface && cues.Pointer == null, "A turn on the still sent a room point, a depth claim or a pointer.");
            // Off the picture, the turn is still about the still, as a whole.
            Look(f, plane.At(1.4f, .5f));
            Invoke(f.App, "Capture", new object?[] { null });
            Require(((Snapshot?)Get(f.App, "pending"))?.Recorded != null && ((Cues)Get(f.App, "pendingCues")!).Gaze == null,
                "A gaze off the picture sent a gaze point, or the turn lost its still.");

            // The turn goes by reference: no pixels, the recorded source, the gaze point only.
            Look(f, plane.At(.42f, .63f));
            Invoke(f.App, "Capture", new object?[] { null });
            f.Mac.OnTurn = () => NeverNow(f, "while Boopy thinks about the picture");
            f.Send(f.Reply("box"));
            f.Mac.OnTurn = null;
            Require(f.Strip.SpeakerText == "Boopy", "Boopy's answer on the picture has another speaker line: " + f.Strip.SpeakerText);
            NeverNow(f, "with Boopy's answer on the picture");
            var body = JObject.Parse(f.Mac.Posts.Single(post => post.Path == "/v1/sessions").Body);
            Require(!body.ContainsKey("frame"), "A turn on a recorded still sent pixels.");
            Require((string?)body["recordedFrame"]?["recordingId"] == RecordingId && (string?)body["recordedFrame"]?["frameId"] == FrameA,
                "A turn on a recorded still did not name its still: " + body["recordedFrame"]);
            Require((string?)body["attention"]?["source"] == "past-recollection", "A turn on a recorded still claims another source: " + body["attention"]?["source"]);
            var gaze = (JObject?)body["cues"]?["gaze"];
            Require(gaze != null && !gaze.ContainsKey("world") && (bool?)gaze["onSurface"] == false && body["cues"]?["pointer"] == null,
                "A turn on a recorded still sent more than the gaze point: " + body["cues"]);

            // The reply's outline lies on the picture, on the still's own pixels; so does the chip's anchor.
            var box = SingleOverlay(f);
            var drawn = box.Boundary.Select(point => ImageOf(plane, point)).ToArray();
            Require(drawn.Min(point => point.x) <= SubjectBox.X0 + .002f && drawn.Max(point => point.x) >= SubjectBox.X1 - .002f
                && drawn.Min(point => point.y) <= SubjectBox.Y0 + .002f && drawn.Max(point => point.y) >= SubjectBox.Y1 - .002f,
                "The box outline does not go around the whole subject on the still.");
            foreach (var point in box.Boundary)
            {
                Require(OffPlane(plane, point) <= .0015f, $"The box outline leaves the picture by {OffPlane(plane, point) * 1000f:0.0} mm.");
                var image = ImageOf(plane, point);
                Require(image.x >= SubjectBox.X0 - .05f && image.x <= SubjectBox.X1 + .05f && image.y >= SubjectBox.Y0 - .05f && image.y <= SubjectBox.Y1 + .05f,
                    $"The box outline is not around the subject on the still: {image.x:0.000}, {image.y:0.000}.");
            }
            // The subject's anchor, where Boopy goes and its word sits by, is on the subject on the still; it gets no chip.
            Require(f.Scene.TryGetActiveAnchor(out var anchor) && OffPlane(plane, anchor) <= .0015f
                && Vector2.Distance(ImageOf(plane, anchor), new Vector2((SubjectBox.X0 + SubjectBox.X1) / 2f, (SubjectBox.Y0 + SubjectBox.Y1) / 2f)) < .002f,
                "The subject's anchor is not on the subject on the still.");
            Require(f.Scene.GetComponentsInChildren<Chip>(true).All(candidate => !candidate.gameObject.activeInHierarchy), "A subject on the picture has a chip.");
            f.Apply(f.Reply("mask"));
            var mask = SingleOverlay(f);
            Require(mask.Boundary.Count == SubjectMask.Length, "The mask outline has " + mask.Boundary.Count + " points, not its own " + SubjectMask.Length + ".");
            for (var i = 0; i < SubjectMask.Length; i++)
            {
                var image = ImageOf(plane, mask.Boundary[i]);
                Require(OffPlane(plane, mask.Boundary[i]) <= .0015f && Vector2.Distance(image, new Vector2(SubjectMask[i].X, SubjectMask[i].Y)) < .002f,
                    $"Mask point {i} is not on its pixel: {image.x:0.000}, {image.y:0.000}.");
            }

            // The Mac refuses a turn because its still changed, or is gone: DESIGN's words, and the scene is read again at once.
            foreach (var (code, words) in new[] { ("recorded_frame_changed", "The picture changed before I could look. Ask again."),
                ("recorded_frame_unknown", "Your Mac doesn't have that picture.") })
            {
                Set(f.App, "nextRecordedAt", 99f);
                Invoke(f.App, "Capture", new object?[] { null });
                f.Mac.Refuse = code;
                f.Refused();
                Require(f.Strip.FullText.Contains(words), "The refusal " + code + " did not say: " + words + " It said: " + f.Strip.FullText);
                Require((float)Get(f.App, "nextRecordedAt")! == 0f, "After " + code + " the headset does not read the scene again at once.");
            }

            // A still that is not the one the Mac named is never shown.
            f.Mac.Scene = SceneJson(FrameB, f.StillA, sha: Sha(f.StillB));
            f.Mac.Stills[FrameB] = f.StillA;
            f.ReadScene();
            Require(f.Picture.Scene!.FrameId == FrameA && Overlays(f) == 1, "A still that did not match its digest replaced the picture.");
            // Another still takes the old still's outlines and chip away.
            f.Mac.Scene = SceneJson(FrameB, f.StillB);
            f.Mac.Stills[FrameB] = f.StillB;
            f.ReadScene();
            Require(f.Picture.Scene!.FrameId == FrameB, "A new still from the Mac is not shown.");
            Require(Overlays(f) == 0 && f.Scene.GetComponentsInChildren<Chip>(true).All(candidate => !candidate.gameObject.activeInHierarchy)
                && f.Scene.GetComponentsInChildren<WordBlock>(true).All(candidate => !candidate.gameObject.activeInHierarchy),
                "The old still's outline, chip or word stays on the new still.");
            // A clip's cue is a player's thin bar in the lower-left of the view, filled to where the still is in the clip, with
            // the play triangle of a stopped player just left of it; never the Pause bars, never words.
            f.Mac.Scene = SceneJson(FrameA, f.StillA, kind: "video", at: 4.2f, duration: 12.232f);
            f.ReadScene();
            Require(f.Picture.Scene!.Kind == "video" && f.Picture.Held is float held && Mathf.Abs(held - 4.2f / 12.232f) < .001f, "A clip's still does not show where it is held.");
            var track = Bars(f).Single(bar => bar.name == "Player track"); var played = Bars(f).Single(bar => bar.name == "Player played");
            var start = track.transform.TransformPoint(track.GetPosition(0)); var end = track.transform.TransformPoint(track.GetPosition(1));
            var along = Vector3.Distance(start, played.transform.TransformPoint(played.GetPosition(1))) / Vector3.Distance(start, end);
            Require(track.gameObject.activeInHierarchy && played.gameObject.activeInHierarchy && InCorner(f, (start + end) / 2f)
                && Mathf.Abs(along - 4.2f / 12.232f) < .002f,
                $"The player bar is not in the corner of the view, or not filled to the held still: {along:0.000}.");
            // The play triangle of a stopped player, about 1.5 degrees tall, just left of the bar, centered on it (DESIGN).
            var triangle = f.Picture.GetComponentsInChildren<MeshRenderer>(true).Single(renderer => renderer.name == "Play triangle");
            var bounds = triangle.bounds;
            var tall = 2f * Mathf.Atan(bounds.size.y / 2f / Vector3.Distance(f.Eyes.position, bounds.center)) * Mathf.Rad2Deg;
            var tip = triangle.transform.localPosition.x + triangle.transform.localScale.x / 2f;
            Require(triangle.gameObject.activeInHierarchy && tip < track.GetPosition(0).x && Mathf.Abs(triangle.transform.localPosition.y - track.GetPosition(0).y) < .001f
                && tall > 1.3f && tall < 1.7f,
                $"A held clip's play triangle is not 1.5 degrees tall just left of the bar: {tall:0.00} degrees.");
            Require(f.Picture.GetComponentsInChildren<SpatialActionIcon>(true).Length == 0, "The held clip shows a control glyph.");
            Require(f.Picture.GetComponentsInChildren<TextMeshPro>(true).All(text => !text.gameObject.activeInHierarchy), "Words show with the clip.");

            // No scene takes the picture away, and the live room scene may come back.
            f.Mac.Scene = "{\"scene\":null}";
            f.ReadScene();
            Require(!f.Picture.Showing, "The picture stays after the Mac cleared its scene.");
            Require((bool)Prop(f.App, "AmbientSceneAllowed")!, "The live room scene stays off after the recorded scene cleared.");
            Require((bool)Invoke(f.App, "CameraMissing", new EvidenceTurn(false))!, "With no recorded scene, a picture turn no longer needs the room camera.");
        }

        // A live turn's outline stays where it is in the room while a recorded scene comes and goes; it is never put on the picture.
        private static void ValidateLiveStaysInTheRoom(Fixture f)
        {
            // A Mac that looks only at recordings refuses a room boop: DESIGN's words, and the scene is read again at once.
            Set(f.App, "nextRecordedAt", 99f);
            Set(f.App, "pending", TaskPresentationValidation.Snapshot());
            f.Mac.Refuse = "recorded_only";
            f.Refused();
            Require(f.Strip.FullText.Contains("Open a video or photo on your Mac first."), "The refusal recorded_only said: " + f.Strip.FullText);
            Require((float)Get(f.App, "nextRecordedAt")! == 0f, "After recorded_only the headset does not read the scene again at once.");
            Require(Get(f.App, "session") == null && Get(f.App, "unresolvedStartId") == null, "A refused room boop opened a session or left an earlier capture waiting.");
            f.Mac.Posts.Clear();
            Set(f.App, "pending", TaskPresentationValidation.Snapshot());
            f.Send(f.Reply("box", live: true));
            Require(JObject.Parse(f.Mac.Posts.Single().Body).ContainsKey("frame"), "The live turn sent no frame.");
            var room = SingleOverlay(f).Boundary.ToArray();
            f.Mac.Scene = SceneJson(FrameA, f.StillA);
            f.ReadScene();
            Require(f.Picture.Showing, "The recorded scene did not show over a live reply.");
            var shown = SingleOverlay(f).Boundary.ToArray();
            // Unmoved is the test: put on the picture, its points would move onto the picture's plane.
            Require(shown.Length == room.Length && shown.Zip(room, (a, b) => Vector3.Distance(a, b)).All(moved => moved < 1e-5f),
                "A live outline moved when the recorded scene appeared.");
            f.Mac.Scene = "{\"scene\":null}";
            f.ReadScene();
            var after = SingleOverlay(f).Boundary.ToArray();
            Require(!f.Picture.Showing && after.Zip(room, (a, b) => Vector3.Distance(a, b)).All(moved => moved < 1e-5f),
                "A live outline moved or went away when the recorded scene cleared.");
        }

        /// <summary>Stills of the picture with a reply on it (synthetic), and of the owner's own still when BOOPY_RECORDED_FRAME
        /// names one: that one alone, with no outline, since only the Mac's reply may draw on the owner's footage.</summary>
        public static void Render()
        {
            var context = SynchronizationContext.Current;
            try
            {
                var output = Environment.GetEnvironmentVariable("BOOPY_RENDER_DIR") is string dir && dir.Length > 0 ? dir : Path.Combine(Path.GetTempPath(), "boopy-recorded-scene");
                var owner = Environment.GetEnvironmentVariable("BOOPY_RECORDED_FRAME");
                Require(string.IsNullOrEmpty(owner) || Directory.Exists(Environment.GetEnvironmentVariable("BOOPY_RENDER_DIR") ?? ""),
                    "A still of the owner's footage needs BOOPY_RENDER_DIR, an existing private folder (mode 700).");
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                ScriptCoverage.Install();
                SynchronizationContext.SetSynchronizationContext(null);
                Directory.CreateDirectory(output);
                using (var f = new Fixture())
                {
                    f.Mac.Scene = SceneJson(FrameA, f.StillA);
                    f.ReadScene();
                    Capture(f, Path.Combine(output, "SYNTHETIC-recorded-picture.png"));
                    Look(f, f.Picture.Plane.At(.42f, .63f));
                    Invoke(f.App, "Capture", new object?[] { null });
                    f.Send(f.Reply("mask"));
                    Capture(f, Path.Combine(output, "SYNTHETIC-recorded-reply.png"));
                    f.Mac.Scene = SceneJson(FrameB, f.StillB, kind: "video", at: 4.2f, duration: 12.232f);
                    f.Mac.Stills[FrameB] = f.StillB;
                    f.ReadScene();
                    Capture(f, Path.Combine(output, "SYNTHETIC-recorded-clip.png"));
                }
                if (!string.IsNullOrEmpty(owner))
                {
                    Require(Path.IsPathRooted(owner) && File.Exists(owner), "BOOPY_RECORDED_FRAME is not an absolute path to a file.");
                    var bytes = File.ReadAllBytes(owner);
                    Require(bytes.Length <= RecordedScenes.MaxFrameBytes && bytes.Length > 3 && bytes[0] == 0xff && bytes[1] == 0xd8, "BOOPY_RECORDED_FRAME is not a JPEG still of at most 4 MiB.");
                    var probe = new Texture2D(2, 2);
                    Require(probe.LoadImage(bytes), "BOOPY_RECORDED_FRAME does not decode.");
                    var (width, height) = (probe.width, probe.height);
                    UnityEngine.Object.DestroyImmediate(probe);
                    using var f = new Fixture();
                    f.Mac.Scene = SceneJson(FrameA, bytes, width: width, height: height);
                    f.Mac.Stills[FrameA] = bytes;
                    f.ReadScene();
                    Require(f.Picture.Showing, "The owner's still did not show.");
                    Capture(f, Path.Combine(output, "owner-recorded-picture.png"));
                }
                // The output folder only: never the owner's file path, which can carry a place.
                Debug.Log("Boopy recorded scene stills: " + output + (string.IsNullOrEmpty(owner) ? " (synthetic only)" : " (synthetic, and the owner's still with no outline)"));
            }
            catch (Exception error)
            {
                Debug.LogException(error);
                if (Application.isBatchMode) EditorApplication.Exit(1);
                else throw;
            }
            finally { SynchronizationContext.SetSynchronizationContext(context); }
        }

        internal static void Capture(Fixture f, string path)
        {
            const int width = 1600, height = 1000;
            Settle(f);
            // Not ??: a missing component is Unity's fake null, which ?? does not see.
            var camera = f.Eyes.gameObject.TryGetComponent<Camera>(out var existing) ? existing : f.Eyes.gameObject.AddComponent<Camera>();
            camera.fieldOfView = 64; camera.nearClipPlane = .05f; camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(.42f, .44f, .45f); camera.allowHDR = false; camera.allowMSAA = false;
            var target = new RenderTexture(width, height, 24); target.Create();
            var image = new Texture2D(width, height, TextureFormat.RGB24, false);
            var previous = RenderTexture.active;
            try
            {
                camera.targetTexture = target; camera.Render();
                RenderTexture.active = target; image.ReadPixels(new Rect(0, 0, width, height), 0, 0); image.Apply();
                File.WriteAllBytes(path, image.EncodeToPNG());
            }
            finally
            {
                camera.targetTexture = null; RenderTexture.active = previous;
                target.Release(); UnityEngine.Object.DestroyImmediate(target); UnityEngine.Object.DestroyImmediate(image);
            }
        }

        internal sealed class Fixture : IDisposable
        {
            public readonly GameObject Root;
            public readonly Transform Eyes;
            public readonly SessionScene Scene;
            public readonly ContextConsole Console;
            public readonly DialogueStrip Strip;
            public readonly RecordedPicture Picture;
            public readonly BoopyApp App;
            public readonly Mac Mac = new Mac();
            public readonly byte[] StillA = SyntheticStill(false), StillB = SyntheticStill(true);
            private readonly ServiceClient client;
            private readonly string directory = Path.Combine(Path.GetTempPath(), "boopy-recorded-validation-" + Guid.NewGuid().ToString("N"));

            public Fixture()
            {
                Directory.CreateDirectory(directory);
                Root = new GameObject("Synthetic recorded scene");
                Eyes = new GameObject("Synthetic eyes").transform; Eyes.SetParent(Root.transform, false);
                // A room camera that never runs: a recorded scene must not need it.
                var room = Root.AddComponent<RoomCamera>();
                Scene = SessionScene.Create(Root.transform, room, Eyes);
                Console = ContextConsole.Create(Root.transform, Eyes);
                Scene.MoveConsole(Console, SessionScene.HomeFor(Eyes, Console));
                Strip = DialogueStrip.Create(Root.transform, Eyes); Console.DockDialogue(Strip);
                Picture = RecordedPicture.Create(Root.transform);
                App = Root.AddComponent<BoopyApp>();
                client = new ServiceClient(handler: Mac);
                Mac.Stills[FrameA] = StillA;
                Set(App, "client", client); Set(App, "scene", Scene); Set(App, "console", Console); Set(App, "dialogue", Strip);
                Set(App, "room", room); Set(App, "head", Eyes); Set(App, "status", StatusLine.Create(Root.transform, Eyes, Visuals.Quad()));
                Set(App, "gaze", Reticle.Create("Synthetic gaze", Root.transform, Eyes));
                Set(App, "recorded", Picture);
                Scene.SetPicture(Picture);
                Set(App, "recoveryStore", new CaptureRecoveryStore(Path.Combine(directory, "pending-id")));
                Set(App, "handoffRecoveryStore", new HandoffRecoveryStore(Path.Combine(directory, "preparation-identity")));
            }

            public void ReadScene() => ((Task)Invoke(App, "ReadRecordedScene")!).GetAwaiter().GetResult();

            public void Send(SessionView reply)
            {
                Mac.Reply = reply;
                Set(App, "pendingEvidence", new EvidenceTurn(false));
                ((Task)Invoke(App, "Send", SpeechValidation.SyntheticWav())!).GetAwaiter().GetResult();
                Require(Get(App, "session") is SessionView view && view.Id == SessionId, "The synthetic turn on the recorded still was not applied: " + Strip.FullText);
                Settle(this);
            }

            public void Apply(SessionView view) { Invoke(App, "Apply", view); Settle(this); }

            // A turn the Mac refuses: Send ends with a line saying so, and the session stays as it was.
            public void Refused()
            {
                Set(App, "pendingEvidence", new EvidenceTurn(false));
                ((Task)Invoke(App, "Send", SpeechValidation.SyntheticWav())!).GetAwaiter().GetResult();
                Settle(this);
            }

            // The reply names one subject on the still: by its box, or by its mask.
            public SessionView Reply(string grounding, bool live = false)
            {
                var view = new SessionView
                {
                    Id = SessionId, State = "review", ReferentId = "subject", Model = new ModelRef { Provider = "fixture", Id = "synthetic" },
                    Dialogue = new DialogueView { Speaker = "boopy", UtteranceId = "synthetic-turn", At = "1970-01-01T12:00:00Z",
                        Text = live ? "That looks like a synthetic stone." : "That looks like a synthetic vehicle." },
                };
                view.Utterances.Add(new UtteranceRef { Id = "synthetic-turn", Text = "What is this?", Kind = "ask" });
                view.Observations.Add(new ObservationRef { Id = ObservationId, CapturedAt = "1970-01-01T12:00:00Z" });
                view.Items.Add(new Item
                {
                    Id = "subject", Kind = "object", Label = "vehicle", Statement = "It may be a synthetic vehicle.", Origin = "model", Status = "proposed", Confidence = .5f,
                    Grounding = grounding == "mask"
                        ? new Grounding
                        {
                            Kind = "box", ObservationId = ObservationId, Box = SubjectBox,
                            Contour = SubjectMask.Select(point => new Point2 { X = point.X, Y = point.Y }).ToList(),
                            Spatial = new SpatialEvidence { Provider = "fixture", Model = "synthetic", Concept = "vehicle", Outcome = "contour", Verification = "proposed" },
                        }
                        : new Grounding { Kind = "box", ObservationId = ObservationId, Box = SubjectBox },
                });
                return view;
            }

            public void Dispose()
            {
                client.Dispose();
                UnityEngine.Object.DestroyImmediate(Root);
                Directory.Delete(directory, true);
            }
        }

        /// <summary>The Mac as the headset sees it: the recorded scene, its stills, and the turn.</summary>
        internal sealed class Mac : HttpMessageHandler
        {
            public string Scene = "{\"scene\":null}";
            public readonly Dictionary<string, byte[]> Stills = new Dictionary<string, byte[]>();
            public SessionView Reply = new SessionView();
            public readonly List<(string Path, string Body)> Posts = new List<(string, string)>();
            // Runs as a turn reaches the Mac, before its reply: what the person sees while Boopy thinks.
            public Action? OnTurn;
            // The next turn is refused with this code.
            public string? Refuse;

            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel)
            {
                var path = request.RequestUri!.AbsolutePath;
                if (path == "/v1/health") return Json(HttpStatusCode.OK, Health);
                if (request.Method == HttpMethod.Get && path == "/v1/recorded-scene") return Json(HttpStatusCode.OK, Scene);
                const string frames = "/v1/recorded-scene/frames/";
                if (request.Method == HttpMethod.Get && path.StartsWith(frames, StringComparison.Ordinal))
                {
                    if (!Stills.TryGetValue(path.Substring(frames.Length), out var still)) return Json(HttpStatusCode.NotFound, "{\"error\":{\"code\":\"recorded_frame_unknown\",\"message\":\"Synthetic.\"}}");
                    var content = new ByteArrayContent(still);
                    content.Headers.ContentType = new MediaTypeHeaderValue("image/jpeg");
                    return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
                }
                // Any session's turn and task open: the render replays captured views of other sessions through the same Mac.
                if (request.Method == HttpMethod.Post && path.StartsWith("/v1/sessions/", StringComparison.Ordinal) && path.EndsWith("/task", StringComparison.Ordinal))
                    return Json(HttpStatusCode.NotFound, "{\"error\":{\"code\":\"no_task\",\"message\":\"Synthetic.\"}}");
                if (request.Method == HttpMethod.Post && (path == "/v1/sessions"
                    || (path.StartsWith("/v1/sessions/", StringComparison.Ordinal) && path.EndsWith("/utterances", StringComparison.Ordinal))))
                {
                    Posts.Add((path, request.Content!.ReadAsStringAsync().GetAwaiter().GetResult()));
                    OnTurn?.Invoke();
                    if (Refuse is string code)
                    {
                        Refuse = null;
                        return Json(code == "recorded_frame_unknown" ? HttpStatusCode.NotFound : HttpStatusCode.Conflict,
                            "{\"error\":{\"code\":\"" + code + "\",\"message\":\"Synthetic refusal.\"}}");
                    }
                    return Json(HttpStatusCode.OK, Wire.Write(Reply));
                }
                throw new InvalidOperationException("Unexpected synthetic request: " + request.Method + " " + path);
            }

            private static Task<HttpResponseMessage> Json(HttpStatusCode status, string body) =>
                Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }

        internal static string SceneJson(string frameId, byte[] still, string? sha = null, int width = Width, int height = Height,
            string kind = "photo", float? at = null, float? duration = null)
        {
            var digest = sha ?? Sha(still);
            string Number(float? value) => value is float some ? some.ToString(System.Globalization.CultureInfo.InvariantCulture) : "null";
            var frames = kind == "video" ? $"[{{\"frameId\":\"{frameId}\",\"seconds\":{Number(at)},\"frameSha256\":\"{digest}\"}}]" : "[]";
            return $"{{\"scene\":{{\"recordingId\":\"{RecordingId}\",\"frameId\":\"{frameId}\",\"kind\":\"{kind}\",\"width\":{width},\"height\":{height}," +
                $"\"sourceTimeSeconds\":{Number(at)},\"durationSeconds\":{Number(duration)},\"capturedAt\":{{\"value\":null,\"trust\":\"unknown\"}},\"frameSha256\":\"{digest}\",\"frames\":{frames}}}}}";
        }

        // A drawn desert under a sky with one dark shape where the subject is: synthetic, made here, never a photograph.
        private static byte[] SyntheticStill(bool later)
        {
            var texture = new Texture2D(Width, Height, TextureFormat.RGB24, false);
            try
            {
                var pixels = new Color32[Width * Height];
                for (var y = 0; y < Height; y++)
                    for (var x = 0; x < Width; x++)
                    {
                        // Texture rows run from the bottom; image coordinates from the top.
                        var u = (x + .5f) / Width; var v = 1f - (y + .5f) / Height;
                        var subject = u >= SubjectBox.X0 + .03f && u <= SubjectBox.X1 - .03f && v >= SubjectBox.Y0 + .04f && v <= SubjectBox.Y1 - .02f;
                        var color = subject ? new Color(.18f, .16f, .15f) : v < .42f ? Color.Lerp(new Color(.55f, .70f, .86f), new Color(.86f, .88f, .86f), v / .42f)
                            : Color.Lerp(new Color(.86f, .70f, .48f), new Color(.74f, .56f, .36f), (v - .42f) / .58f);
                        if (later) color = Color.Lerp(color, new Color(.95f, .62f, .35f), .25f);
                        pixels[y * Width + x] = color;
                    }
                texture.SetPixels32(pixels); texture.Apply();
                return texture.EncodeToJPG(90);
            }
            finally { UnityEngine.Object.DestroyImmediate(texture); }
        }

        internal static void Look(Fixture f, System.Numerics.Vector3 at) =>
            typeof(Reticle).GetProperty("Point")!.SetValue(Get(f.App, "gaze"), Unity(at));

        internal static GroundedOverlay SingleOverlay(Fixture f)
        {
            var shown = f.Scene.GetComponentsInChildren<GroundedOverlay>(true).Where(overlay => overlay.gameObject.activeInHierarchy).ToArray();
            Require(shown.Length == 1, "Expected the reply's one outline, found " + shown.Length + ".");
            return shown[0];
        }

        // Whether a point is in the lower-left of the view: left of and below where the eyes look, inside the headset's view.
        private static bool InCorner(Fixture f, Vector3 point)
        {
            var local = f.Eyes.InverseTransformPoint(point);
            var off = Vector3.Angle(Vector3.forward, local);
            return local.x < 0f && local.y < 0f && off > 15f && off < 40f;
        }

        private static LineRenderer[] Bars(Fixture f) => f.Picture.GetComponentsInChildren<LineRenderer>(true).Where(line => line.name.StartsWith("Player", StringComparison.Ordinal)).ToArray();

        private static TextMeshPro[] Visible(Fixture f) =>
            f.Root.GetComponentsInChildren<TextMeshPro>().Where(text => text.gameObject.activeInHierarchy && text.enabled && !string.IsNullOrWhiteSpace(text.text)).ToArray();

        internal static void NeverNow(Fixture f, string when)
        {
            foreach (var text in Visible(f))
                Require(!NotRecorded.IsMatch(text.text), $"A visible line says the recorded scene is the room now, {when}: \"{text.text}\".");
        }

        private static int Overlays(Fixture f) => f.Scene.GetComponentsInChildren<GroundedOverlay>(true).Count(overlay => overlay.gameObject.activeInHierarchy);

        internal static float OffPlane(PicturePlane plane, Vector3 point)
        {
            var normal = Vector3.Cross(Unity(plane.Right), Unity(plane.Up)).normalized;
            return Mathf.Abs(Vector3.Dot(point - Unity(plane.Center), normal));
        }

        internal static Vector2 ImageOf(PicturePlane plane, Vector3 point)
        {
            var local = point - Unity(plane.Center);
            return new Vector2(Vector3.Dot(local, Unity(plane.Right)) / plane.Width + .5f, .5f - Vector3.Dot(local, Unity(plane.Up)) / plane.Height);
        }

        internal static void Settle(Fixture f)
        {
            foreach (var text in f.Root.GetComponentsInChildren<TextMeshPro>()) text.ForceMeshUpdate(true, true);
            foreach (var chip in f.Scene.GetComponentsInChildren<Chip>()) chip.Face(f.Eyes);
            f.Console.RefreshVisuals(1f); f.Strip.RefreshVisuals(1f);
            Physics.SyncTransforms();
        }

        internal static string Sha(byte[] bytes)
        {
            using var sha = SHA256.Create();
            return string.Concat(sha.ComputeHash(bytes).Select(value => value.ToString("x2")));
        }

        private static Vector3 Unity(System.Numerics.Vector3 value) => new Vector3(value.X, value.Y, value.Z);
        internal static object? Invoke(object target, string name, params object?[] args)
        {
            var method = target.GetType().GetMethod(name, Flags) ?? throw new InvalidOperationException("BoopyApp has no " + name + ".");
            return method.Invoke(target, args);
        }
        private static object? Prop(object target, string name) =>
            (target.GetType().GetProperty(name, Flags) ?? throw new InvalidOperationException("BoopyApp has no " + name + ".")).GetValue(target);
        internal static void Set(object target, string name, object? value) =>
            (target.GetType().GetField(name, Flags) ?? throw new InvalidOperationException(target.GetType().Name + " keeps no " + name + ".")).SetValue(target, value);
        internal static object? Get(object target, string name) =>
            (target.GetType().GetField(name, Flags) ?? throw new InvalidOperationException(target.GetType().Name + " keeps no " + name + ".")).GetValue(target);
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
