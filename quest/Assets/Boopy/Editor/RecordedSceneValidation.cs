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
                ValidateLevels();
                using (var projected = new Fixture()) ValidateProjection(projected);
                using (var tapped = new Fixture()) ValidateTapBoop(tapped);
                using (var rule = new Fixture()) ValidateTapRule(rule);
                ValidateCrowdedHome();
                using (var steps = new Fixture()) ValidateHomesOnce(steps);
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

        // A measured projection puts the frame back at exactly the angles its camera saw it, off the middle of the view
        // where the camera was, whole: each corner at its edge's tangent from the eyes. The word keeps to the part of the
        // frame in the sharp view, and the blurred footage still covers the view past it.
        private static void ValidateProjection(Fixture f)
        {
            const float left = 1.3f, right = .7f, up = .6f, down = .5f;
            string Tangent(float value) => value.ToString(System.Globalization.CultureInfo.InvariantCulture);
            f.Mac.Scene = SceneJson(FrameA, f.StillA,
                extra: $",\"projection\":{{\"tanLeft\":{Tangent(left)},\"tanRight\":{Tangent(right)},\"tanUp\":{Tangent(up)},\"tanDown\":{Tangent(down)},\"source\":\"measured-device-profile\",\"profile\":\"synthetic\",\"centring\":\"measured\"}}");
            f.ReadScene();
            Require(f.Picture.Showing && f.Picture.Scene?.Projection != null, "The measured recording did not show.");
            var plane = f.Picture.Plane;
            foreach (var (x, y, across, upward) in new[] { (0f, 0f, -left, up), (1f, 0f, right, up), (0f, 1f, -left, -down), (1f, 1f, right, -down) })
            {
                var corner = f.Eyes.InverseTransformPoint(Unity(plane.At(x, y)));
                Require(Mathf.Abs(corner.x / corner.z - across) < 1e-4f && Mathf.Abs(corner.y / corner.z - upward) < 1e-4f,
                    $"The frame's corner ({x}, {y}) is at tangents {corner.x / corner.z:0.0000}, {corner.y / corner.z:0.0000}, not {across}, {upward}.");
            }
            var seen = f.Picture.Readable;
            float Inside(float tangent) => Mathf.Tan(Mathf.Atan(tangent) - RecordedPicture.EdgeDegrees * Mathf.Deg2Rad);
            Require(Mathf.Abs(seen.X0 - (left - Inside(left)) / (left + right)) < 1e-4f && Mathf.Abs(seen.X1 - (left + Inside(right)) / (left + right)) < 1e-4f
                && Mathf.Abs(seen.Y0 - (up - Inside(up)) / (up + down)) < 1e-4f && Mathf.Abs(seen.Y1 - (up + Inside(down)) / (up + down)) < 1e-4f,
                $"The word's part of the measured frame is not the frame 8 degrees inside its edge: {seen}.");
            Covers(f, f.Picture.GetComponentsInChildren<MeshRenderer>(true).Single(renderer => renderer.name == "Recorded surround"),
                "The blurred footage does not surround the person in line with the measured frame");
        }

        // A tap on the picture boops with no words: the turn names the still, the point the hand aims at, and a tap for its
        // speech; no sound and no words are sent, and the Mac's answer shows.
        private static void ValidateTapBoop(Fixture f)
        {
            f.Mac.Scene = SceneJson(FrameA, f.StillA);
            f.ReadScene();
            var plane = f.Picture.Plane;
            var hand = new HandInput(true, null, null);
            var from = new Vector3(-.2f, -.3f, .4f);
            hand.Update(f.Eyes, 0f, true, new HandInput.Controller(true, 0f, from, Unity(plane.At(.4f, .6f)) - from));
            f.Mac.Reply = f.Reply("box");
            ((Task)Invoke(f.App, "BoopWithoutWords", hand, null, null)!).GetAwaiter().GetResult();
            Settle(f);
            var body = JObject.Parse(f.Mac.Posts.Single(post => post.Path == "/v1/sessions").Body);
            var speech = (JObject?)body["speech"];
            Require(speech != null && (string?)speech["gesture"] == "tap" && speech.Count == 1, "A tap's turn does not say it is a tap with no words: " + speech);
            Require((string?)body["recordedFrame"]?["frameId"] == FrameA && !body.ContainsKey("frame"), "A tap's turn is not about the still: " + body["recordedFrame"]);
            var gaze = body["cues"]?["gaze"]?["point"];
            Require(gaze != null && Mathf.Abs((float)gaze["x"]! - .4f) < .001f && Mathf.Abs((float)gaze["y"]! - .6f) < .001f,
                "A tap's turn is not about where the hand points: " + gaze);
            Require(Get(f.App, "session") is SessionView, "The Mac's answer to a tap was not applied: " + f.Strip.FullText);
            // An adb boop at a given point takes the same turn about that point. It is a second boop on the recording, so it
            // starts its own session, which can open its own task: only a session's first turn opens one.
            ((Task)Invoke(f.App, "BoopWithoutWords", null, new Point2 { X = .25f, Y = .75f }, null)!).GetAwaiter().GetResult();
            Settle(f);
            var later = JObject.Parse(f.Mac.Posts.Last().Body);
            var pointed = later["cues"]?["gaze"]?["point"];
            Require(f.Mac.Posts.Count == 2 && f.Mac.Posts.All(post => post.Path == "/v1/sessions"),
                "A second boop on a recording did not start its own session: " + string.Join(", ", f.Mac.Posts.Select(post => post.Path)));
            Require((string?)later["speech"]?["gesture"] == "tap"
                && pointed != null && Mathf.Abs((float)pointed["x"]! - .25f) < .001f && Mathf.Abs((float)pointed["y"]! - .75f) < .001f,
                "An adb boop does not take a tap's turn about its point: " + later);
        }

        // One tap rule on a recording, by hand or by adb: the first tap after Boopy's answer plays the clip on and clears his
        // line, the word and the shape, and sends nothing; the next tap boops.
        private static void ValidateTapRule(Fixture f)
        {
            f.Mac.Scene = SceneJson(FrameA, f.StillA);
            f.ReadScene();
            var point = new Point2 { X = .4f, Y = .6f };
            f.Mac.Reply = f.Reply("box");
            ((Task)Invoke(f.App, "BoopWithoutWords", null, point, null)!).GetAwaiter().GetResult();
            Settle(f);
            Require(f.Scene.TryGetWord(out _) && f.Mac.Posts.Count == 1, "The boop before the tap rule showed no word.");
            // The clip stands stopped on the boop: a video shown and not playing.
            var player = f.Picture.gameObject.AddComponent<UnityEngine.Video.VideoPlayer>();
            player.playOnAwake = false; player.enabled = false;
            Set(f.Picture, "player", player); Set(f.Picture, "videoShown", true);
            Require(f.Picture.Paused, "The synthetic clip does not stand stopped.");
            Invoke(f.App, "TapRecording", null, point, null, "adb", false);
            Settle(f);
            Require(f.Mac.Posts.Count == 1 && !f.Scene.TryGetWord(out _) && !f.Strip.gameObject.activeSelf && Get(f.App, "task") == null,
                "The first tap after the answer did not play the clip on and clear his line and the word: " + f.Mac.Posts.Count + " turns, line \"" + f.Strip.FullText + "\".");
            // Playing again, the next tap boops.
            Set(f.Picture, "videoShown", false);
            Invoke(f.App, "TapRecording", null, point, null, "adb", false);
            for (var i = 0; i < 50 && f.Mac.Posts.Count < 2; i++) { Settle(f); Thread.Sleep(10); }
            Require(f.Mac.Posts.Count == 2 && f.Mac.Posts.Last().Path == "/v1/sessions", "The tap after the clip played on did not boop.");
            UnityEngine.Object.DestroyImmediate(player);
        }

        // The Quest's own capture, as ROOT measured it: 16:9, a little more to the left of centre than to the right.
        internal const string QuestProjection = ",\"projection\":{\"tanLeft\":0.8424,\"tanRight\":0.8359,\"tanUp\":0.472,\"tanDown\":0.472,"
            + "\"source\":\"measured-device-profile\",\"profile\":\"synthetic\",\"centring\":\"measured\"}";
        // ROOT's campsite on the headset: a loose model box over the top right of the frame, booped inside it.
        internal static readonly Box2 CampsiteBox = new Box2 { X0 = .534f, Y0 = .014f, X1 = .815f, Y1 = .514f };
        internal static readonly Point2 CampsitePoint = new Point2 { X = .674f, Y = .264f };
        // The man on that frame, as the Mac placed him in ROOT's device runs: a person there.
        internal static readonly Box2 TentsMan = new Box2 { X0 = .345f, Y0 = .11f, X1 = .470f, Y1 = .69f };

        // ROOT's two device cases on a synthetic 16:9 still, the same loose box and boop: the campsite (야영지) and the tents
        // (천막, its line "Tent, I think. In Korean, that's 천막. Can you say it?"). No box is drawn; the pin marks the boop
        // and the word sits by it; Boopy's line and the hint to answer, then the long caption. Boopy and all of his line take
        // the first home clear of the pin and the word, inside the sharp part, facing the eye, and stay in view.
        private static void ValidateCrowdedHome()
        {
            foreach (var (term, guess) in new[] { ("야영지", "Campsite"), ("천막", "Tent") })
            {
                using var f = new Fixture();
                var wide = SyntheticStill(false, 640, 360);
                f.Mac.Stills[FrameA] = wide;
                f.Mac.Scene = SceneJson(FrameA, wide, width: 640, height: 360, extra: QuestProjection);
                f.ReadScene();
                Require(f.Picture.Showing && f.Picture.Scene?.Projection != null, "The tents' recording did not show.");
                // The reply also places a person on the frame where the Mac's view placed the man.
                f.Mac.Reply = RecordedPlaybackRender.Typed(CampsitePoint, term, "Q1", guess, CampsiteBox, new[] { ("person", TentsMan) });
                ((Task)Invoke(f.App, "BoopWithoutWords", null, CampsitePoint, null)!).GetAwaiter().GetResult();
                Settle(f);
                f.App.PresentTask(RecordedPlaybackRender.PracticeTask(term, "Q1", guess));
                Frames(f);
                var word = f.Scene.GetComponentsInChildren<WordBlock>().SingleOrDefault(block => block.gameObject.activeInHierarchy);
                Require(word != null && word.Term == term && word.Guess == guess
                    && f.Strip.GetComponentsInChildren<TextMeshPro>().Any(text => text.name == "Hint" && text.gameObject.activeInHierarchy && text.text.Length > 0),
                    $"The {guess} boop shows no word \"{term}\" over \"{guess}\", or no hint to answer: \"{word?.Term}\" / \"{word?.Guess}\".");
                Require(f.Strip.FullText == $"{guess}, I think. In Korean, that's {term}. Can you say it?", "The tents' line is not the task's: " + f.Strip.FullText);
                // The person the reply places on the frame is a keep-out too, by a line.
                RequireRecordingLayout(f, $"beside the {guess} pin", CampsitePoint, new[] { TentsMan });
                // An object the outline run proposed on this frame, a tent's size, right where Boopy's body sits: he moves clear of
                // it by a line.
                var (left, right, up, down) = f.Picture.Frame;
                var away = Quaternion.Inverse(f.Picture.Facing);
                var seen = SessionScene.DrawnParts(f.Console.Companion!).SelectMany(part => part).Select(corner => away * (corner - f.Picture.Eye)).ToArray();
                var where = new Box2
                {
                    X0 = (seen.Min(c => c.x / c.z) + left) / (left + right), X1 = (seen.Max(c => c.x / c.z) + left) / (left + right),
                    Y0 = (up - seen.Max(c => c.y / c.z)) / (up + down), Y1 = (up - seen.Min(c => c.y / c.z)) / (up + down),
                };
                string Number(float value) => value.ToString(System.Globalization.CultureInfo.InvariantCulture);
                f.Mac.Outlines = "{\"samples\":[{\"frameId\":\"" + FrameA + "\",\"seconds\":null,\"provider\":\"local\",\"model\":\"synthetic\",\"latencyMs\":1,"
                    + "\"leftOut\":0,\"verification\":\"proposed\",\"objects\":[{\"label\":\"synthetic\",\"confidence\":0.3,\"origin\":\"proposed\","
                    + $"\"box\":{{\"x0\":{Number(where.X0)},\"y0\":{Number(where.Y0)},\"x1\":{Number(where.X1)},\"y1\":{Number(where.Y1)}}},\"contour\":[]}}]}}]}}";
                ((Task)Invoke(f.App, "ReadOutlines", FrameA)!).GetAwaiter().GetResult();
                Frames(f);
                RequireRecordingLayout(f, $"with an object outlined where Boopy sat beside the {guess} pin", CampsitePoint, new[] { where, TentsMan });
                // The long caption, on the frame as the Mac's view leaves it: it stays inside the sharp part, clear of the rest.
                f.Mac.Outlines = "{\"samples\":[]}";
                ((Task)Invoke(f.App, "ReadOutlines", FrameA)!).GetAwaiter().GetResult();
                f.Strip.Show(DialogueStage.Response, RecordedPlaybackRender.LongLine);
                Frames(f);
                RequireRecordingLayout(f, $"with the long caption beside the {guess} pin", CampsitePoint, new[] { TentsMan });
            }
        }

        /// <summary>
        /// Every line of Boopy's boxless caption reads at 4.5:1 or more over the footage under it (AUDIT): its ink against the
        /// footage seen through that line's shadow or glow, at its own strength and blended in linear light, at the worst
        /// pixel under it (the brightest behind Frost, the darkest behind Graphite), read by <paramref name="under"/>.
        /// </summary>
        internal static void RequireCaptionContrast(Fixture f, string when, Func<Vector3[], (float Darkest, float Brightest)> under)
        {
            var lines = 0;
            foreach (var text in f.Strip.GetComponentsInChildren<TextMeshPro>())
            {
                if (string.IsNullOrEmpty(text.text) || !text.GetComponent<MeshRenderer>().enabled) continue;
                var plate = text.GetComponentsInChildren<MeshRenderer>(true).SingleOrDefault(shadow => shadow.name == "Caption shadow");
                Require(plate != null && plate.enabled, $"The line {text.name} has no shadow {when}.");
                var block = new MaterialPropertyBlock(); plate!.GetPropertyBlock(block);
                var glow = block.GetColor("_Color");
                var mesh = plate.GetComponent<MeshFilter>().sharedMesh;
                var colors = mesh.colors;
                text.ForceMeshUpdate();
                var info = text.textInfo;
                var drawn = Enumerable.Range(0, info.lineCount).Where(l => info.lineInfo[l].visibleCharacterCount > 0).ToList();
                Require(mesh.vertexCount == 16 * drawn.Count, $"The line {text.name} has {mesh.vertexCount} shadow points for {drawn.Count} lines {when}.");
                var ink = WordBlock.Luminance(text.color);
                var frost = Mathf.Abs(ink - WordBlock.Luminance(WordBlock.Frost)) < Mathf.Abs(ink - WordBlock.Luminance(WordBlock.Graphite));
                // One style for every line (DESIGN): Frost words on the dark shadow.
                Require(frost && WordBlock.Luminance(glow) < .05f, $"The line {text.name} is not Frost on the dark shadow {when}.");
                for (var k = 0; k < drawn.Count; k++)
                {
                    var extent = info.lineInfo[drawn[k]];
                    var corners = new[] { new Vector3(extent.lineExtents.min.x, extent.descender), new Vector3(extent.lineExtents.max.x, extent.descender),
                        new Vector3(extent.lineExtents.max.x, extent.ascender), new Vector3(extent.lineExtents.min.x, extent.ascender) }
                        .Select(corner => text.transform.TransformPoint(corner)).ToArray();
                    var (darkest, brightest) = under(corners);
                    var strength = colors[16 * k + 5].a * glow.a;
                    var seen = (1f - strength) * (frost ? brightest : darkest) + strength * WordBlock.Luminance(glow);
                    var contrast = WordBlock.Contrast(ink, seen);
                    Require(contrast >= 4.5f - 1e-3f, $"Line {k} of {text.name} reads {contrast:0.00}:1 {when} ({(frost ? "Frost" : "Graphite")} ink, "
                        + $"strength {strength:0.00}, footage {darkest:0.000} to {brightest:0.000}).");
                    lines++;
                }
            }
            Require(lines > 0, $"No line of Boopy's caption shows {when}.");
            Debug.Log($"Boopy caption contrast {when}: {lines} lines at 4.5:1 or more.");
        }

        // A reply arriving in steps (thinking lines while the Mac works, Boopy's line, then the task with its word, pin and hint
        // to answer, and the view again on a focus change) homes Boopy once after the pinch, and he stays.
        private static void ValidateHomesOnce(Fixture f)
        {
            var wide = SyntheticStill(false, 640, 360);
            f.Mac.Stills[FrameA] = wide;
            f.Mac.Scene = SceneJson(FrameA, wide, width: 640, height: 360, extra: QuestProjection);
            f.ReadScene();
            Frames(f);
            f.Mac.Reply = RecordedPlaybackRender.Typed(CampsitePoint, "천막", "Q1", "Tent", CampsiteBox, new[] { ("person", TentsMan) });
            var atPinch = -1;
            f.Mac.OnTurn = () =>
            {
                atPinch = f.Console.Moves;
                foreach (var thinking in new[] { "Looking…", "Looking at the tents…", "Finding the word…" })
                {
                    f.Strip.Show(DialogueStage.Working, thinking);
                    Frames(f, 2);
                }
            };
            ((Task)Invoke(f.App, "BoopWithoutWords", null, CampsitePoint, null)!).GetAwaiter().GetResult();
            f.Mac.OnTurn = null;
            Require(atPinch >= 0 && f.Console.Moves == atPinch, $"Boopy moved while the reply was still arriving: {f.Console.Moves - atPinch} moves.");
            Frames(f, 2);
            f.App.PresentTask(RecordedPlaybackRender.PracticeTask("천막", "Q1", "Tent"));
            Frames(f);
            f.Apply((SessionView)Get(f.App, "session")!);
            Frames(f);
            Require(f.Console.Moves - atPinch <= 1, $"A reply arriving in steps homed Boopy {f.Console.Moves - atPinch} times, not once.");
            RequireRecordingLayout(f, "after a reply that arrived in steps", CampsitePoint, new[] { TentsMan });
        }

        /// <summary>
        /// Over a recording Boopy is in view with his line beside him, facing the eye, on the side of it away from the subject;
        /// every drawn part of him (body, caption, hint and their shadows) lies inside the frame's sharp part and clear of each
        /// drawn outline, each pin and each word block, by one caption line (the keepout margin when that is more), as seen
        /// from the eye at the placement, and of each box in <paramref name="outlined"/> (a person or thing the reply or the
        /// outline run places on the frame). With <paramref name="pinAt"/>, the subject is a loose box: no outline is drawn,
        /// one pin sits at that point, and the word sits by the pin, within a line of it.
        /// </summary>
        internal static void RequireRecordingLayout(Fixture f, string when, Point2? pinAt = null, Box2[]? outlined = null)
        {
            var home = f.Scene.RecordingHome(f.Console);
            Require(f.Scene.ConsolePlaced && f.Console.gameObject.activeInHierarchy && !(bool)Get(f.Console, "controlsOnly")! && !(bool)Get(f.Strip, "fallback")!,
                $"Boopy is hidden {when}, or his line is not with him.");
            var away = Quaternion.Inverse(f.Picture.Facing);
            Rect Seen(IEnumerable<Vector3> corners)
            {
                var seen = corners.Select(corner => away * (corner - f.Picture.Eye)).ToArray();
                return Rect.MinMaxRect(seen.Min(c => c.x / c.z), seen.Min(c => c.y / c.z), seen.Max(c => c.x / c.z), seen.Max(c => c.y / c.z));
            }
            var sharp = f.Picture.Sharp;
            bool Inside(Rect part) => part.xMin >= -sharp.Left - 1e-3f && part.xMax <= sharp.Right + 1e-3f && part.yMin >= -sharp.Down - 1e-3f && part.yMax <= sharp.Up + 1e-3f;
            var body = f.Console.GetComponentInChildren<CompanionOrb>().GetComponentsInChildren<Renderer>().Where(part => part.enabled && part.gameObject.activeInHierarchy).ToArray();
            Require(body.Length > 0 && body.All(part => Inside(Seen(new[] { part.bounds.min, part.bounds.max }))), $"Boopy is not in view {when}.");
            var named = SessionScene.Drawn(f.Console).Select(part => (part.Part.name, Seen: Seen(part.Corners))).ToList();
            var parts = named.Select(part => part.Seen).ToList();
            Require(parts.Count > 0 && parts.All(Inside), $"Boopy or his line runs outside the frame's sharp part {when}: "
                + $"{string.Join(", ", named.Where(part => !Inside(part.Seen)).Select(part => part.name + " " + part.Seen))}, sharp {sharp}, home {home}.");
            var facing = Vector3.Angle(f.Console.transform.forward, f.Console.transform.position - f.Eyes.position);
            Require(facing < 1f, $"Boopy's line is turned {facing:0.0} degrees from the eye {when}.");
            var gap = Mathf.Max(SpatialTheme.KeepoutMargin * f.Console.ComfortScale, f.Console.CaptionLineHeight) - 1e-3f;
            var pins = f.Scene.GetComponentsInChildren<BoopPin>().Where(pin => pin.gameObject.activeInHierarchy).ToArray();
            var outlines = f.Scene.GetComponentsInChildren<GroundedOverlay>().Where(overlay => overlay.gameObject.activeInHierarchy).ToArray();
            var subjects = pins.Select(pin => (Area: f.Scene.SeenFromEye(pin.transform, pin.Size), What: "the pin"))
                .Concat(outlines.Select(outline => (Area: Seen(outline.Boundary), What: "the subject's outline"))).ToList();
            var words = f.Scene.GetComponentsInChildren<WordBlock>().Where(word => word.gameObject.activeInHierarchy).ToArray();
            var plane = f.Picture.Plane;
            Rect OnPicture(Box2 box) => Seen(new[] { (box.X0, box.Y0), (box.X1, box.Y0), (box.X1, box.Y1), (box.X0, box.Y1) }.Select(corner => Unity(plane.At(corner.Item1, corner.Item2))));
            foreach (var (area, what) in subjects.Concat(words.Select(word => (Area: f.Scene.SeenFromEye(word.transform, word.Size), What: "the word")))
                .Concat((outlined ?? Array.Empty<Box2>()).Select(box => (Area: OnPicture(box), What: "an outlined object"))))
            {
                var kept = Rect.MinMaxRect(area.xMin - gap, area.yMin - gap, area.xMax + gap, area.yMax + gap);
                Require(!parts.Any(part => part.Overlaps(kept)), $"Boopy or his line comes within a caption line of {what} {when}: home {home}; "
                    + $"keep-outs {string.Join("; ", f.Scene.RecordingKeepouts().Select(keepout => keepout.What + " " + keepout.Area))}; "
                    + $"drawn {Rect.MinMaxRect(parts.Min(part => part.xMin), parts.Min(part => part.yMin), parts.Max(part => part.xMax), parts.Max(part => part.yMax))}, "
                    + $"wrap {f.Strip.WrapWidth:0.00}, sharp {sharp}.");
            }
            // Where he is, not what a fresh search would pick, is what must be clear: a home he already holds stays his.
            // Boopy sits on the side of his line away from the subject, where his line lies to one side of it; a line that
            // spans the subject's middle across has no side away from it.
            var orb = Seen(body.SelectMany(part => new[] { part.bounds.min, part.bounds.max })).center.x;
            var spanned = Seen(SessionScene.DrawnParts(f.Strip).SelectMany(part => part));
            var line = spanned.center.x;
            if (subjects.Count > 0 && (subjects[0].Area.center.x < spanned.xMin || subjects[0].Area.center.x > spanned.xMax))
                Require(orb > line == line > subjects[0].Area.center.x, $"Boopy sits on the side of his line toward the subject {when}: Boopy at {orb:0.000}, his line at {line:0.000}.");
            if (pinAt is Point2 point)
            {
                Require(outlines.Length == 0 && pins.Length == 1 && Vector2.Distance(ImageOf(plane, pins[0].transform.position), new Vector2(point.X, point.Y)) < .002f,
                    $"The loose box is drawn, or no pin marks where the person pointed {when}.");
                var pinRect = f.Scene.SeenFromEye(pins[0].transform, pins[0].Size);
                var wordRect = f.Scene.SeenFromEye(words.Single().transform, words.Single().Size);
                var apart = Mathf.Max(Mathf.Max(pinRect.xMin - wordRect.xMax, wordRect.xMin - pinRect.xMax), Mathf.Max(pinRect.yMin - wordRect.yMax, wordRect.yMin - pinRect.yMax));
                var termLine = words.Single().Lines[0].height / Vector3.Distance(f.Picture.Eye, words.Single().transform.position);
                Require(apart >= 0f && apart <= termLine, $"The word does not sit by the pin {when}: {apart:0.000} apart, a line is {termLine:0.000}.");
            }
            // "Hold to answer" has its own row: it touches no row of the caption and not Boopy (DESIGN).
            var texts = f.Strip.GetComponentsInChildren<TextMeshPro>().Where(text => text.text.Length > 0 && text.GetComponent<MeshRenderer>().enabled).ToArray();
            if (texts.FirstOrDefault(text => text.name == "Hint") is TextMeshPro hint)
            {
                Rect Rows(TextMeshPro text)
                {
                    text.ForceMeshUpdate();
                    var b = text.textBounds;
                    return Seen(new[] { new Vector3(b.min.x, b.min.y), new Vector3(b.max.x, b.min.y), new Vector3(b.max.x, b.max.y), new Vector3(b.min.x, b.max.y) }.Select(corner => text.transform.TransformPoint(corner)));
                }
                var asked = Rows(hint);
                string Show(Rect r) => $"({r.xMin:0.000}..{r.xMax:0.000}, {r.yMin:0.000}..{r.yMax:0.000})";
                var into = texts.Where(text => text != hint && Rows(text).Overlaps(asked)).Select(text => text.name + " " + Show(Rows(text)))
                    .Concat(body.Where(part => Seen(new[] { part.bounds.min, part.bounds.max }).Overlaps(asked)).Select(part => part.name + " " + Seen(new[] { part.bounds.min, part.bounds.max }))).ToList();
                var spoken = texts.Single(text => text.name == "Actual response");
                Require(into.Count == 0, $"\"Hold to answer\" {Show(asked)} runs into {string.Join(", ", into)} {when}, wrap {f.Strip.WrapWidth:0.00}, Boopy {(f.Console.Mirrored ? "right" : "left")} of his line; "
                    + $"local caption {spoken.transform.localPosition.y:0.0000} bounds {spoken.textBounds.min.y:0.0000}..{spoken.textBounds.max.y:0.0000} box {spoken.rectTransform.sizeDelta.y:0.0000} lines {spoken.textInfo.lineCount}, "
                    + $"hint {hint.transform.localPosition.y:0.0000} bounds {hint.textBounds.min.y:0.0000}..{hint.textBounds.max.y:0.0000} box {hint.rectTransform.sizeDelta.y:0.0000}, same parent {spoken.transform.parent == hint.transform.parent}.");
            }
            // A narrower wrap never leaves one word alone on the last row.
            if (f.Strip.WrapWidth < .399f && (bool)Invoke(f.Strip, "OneWordLastRow")!)
                Require(false, $"The narrowed caption leaves one word alone on its last row {when}.");
            Debug.Log($"Boopy recorded layout {when}: home {home}, {parts.Count} parts drawn.");
        }

        // The surround is a sphere around the eye at the placement, every way round, showing the footage shrunk to a blur,
        // mirrored past its edges and near its own brightness; each direction takes the image point at its angles, scaled so
        // the frame's edges, seen from that eye, fall on the image's edges, so it lines up with the frame.
        private static void Covers(Fixture f, MeshRenderer layer, string message)
        {
            var mesh = layer.GetComponent<MeshFilter>().sharedMesh;
            var center = layer.transform.position;
            var blurred = layer.sharedMaterial.mainTexture as RenderTexture;
            var round = mesh.vertices.Select(vertex => layer.transform.TransformPoint(vertex) - center).ToArray();
            Require(Vector3.Distance(center, f.Eyes.position) < 1e-3f && round.All(arm => Mathf.Abs(arm.magnitude - RecordedPicture.SurroundRadius) < .01f)
                && round.Any(arm => arm.normalized.z < -.99f) && round.Any(arm => arm.normalized.y > .99f) && round.Any(arm => arm.normalized.y < -.99f)
                && blurred != null && Mathf.Max(blurred.width, blurred.height) <= RecordedPicture.BlurSide && blurred.wrapMode == TextureWrapMode.Mirror
                && RecordedPicture.SurroundShade >= .85f,
                $"{message}: centre {center}, blur {(blurred == null ? "none" : blurred.width + "x" + blurred.height + " " + blurred.wrapMode)}.");
            var plane = f.Picture.Plane;
            var topLeft = layer.transform.InverseTransformPoint(Unity(plane.At(0f, 0f))); var bottomRight = layer.transform.InverseTransformPoint(Unity(plane.At(1f, 1f)));
            var (left, up) = (Mathf.Atan(-topLeft.x / topLeft.z), Mathf.Atan(topLeft.y / topLeft.z));
            var (right, down) = (Mathf.Atan(bottomRight.x / bottomRight.z), Mathf.Atan(-bottomRight.y / bottomRight.z));
            for (var i = 0; i < mesh.vertices.Length; i++)
            {
                var toward = mesh.vertices[i].normalized;
                // At the poles and on the seam straight behind, the angle across has no one value.
                if (Mathf.Abs(toward.y) > .999f || (toward.z < 0f && Mathf.Abs(toward.x) < 1e-3f)) continue;
                var expected = new Vector2((Mathf.Atan2(toward.x, toward.z) + left) / (left + right), (Mathf.Asin(toward.y) + down) / (up + down));
                Require(Vector2.Distance(mesh.uv[i], expected) < 1e-3f, $"{message}: toward {toward} it shows {mesh.uv[i]}, not {expected}.");
            }
        }

        // An adb hold logs its sound's level only: a half-scale tone reads -6.0 dBFS peak and RMS, past a leading chunk.
        private static void ValidateLevels()
        {
            var samples = Enumerable.Range(0, 200).Select(i => (short)(i % 2 == 0 ? 16384 : -16384)).ToArray();
            using var bytes = new MemoryStream(); using var write = new BinaryWriter(bytes);
            write.Write(System.Text.Encoding.ASCII.GetBytes("RIFF")); write.Write(0); write.Write(System.Text.Encoding.ASCII.GetBytes("WAVE"));
            write.Write(System.Text.Encoding.ASCII.GetBytes("LIST")); write.Write(4); write.Write(System.Text.Encoding.ASCII.GetBytes("INFO"));
            write.Write(System.Text.Encoding.ASCII.GetBytes("data")); write.Write(samples.Length * 2); foreach (var sample in samples) write.Write(sample);
            var (peak, rms) = ((double, double))typeof(BoopyApp).GetMethod("Levels", BindingFlags.Static | BindingFlags.NonPublic)!.Invoke(null, new object?[] { bytes.ToArray() })!;
            Require(Math.Abs(peak + 6.02) < .05 && Math.Abs(rms + 6.02) < .05, $"A half-scale tone reads {peak:0.00} dBFS peak, {rms:0.00} dBFS RMS.");
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
            // With no projection measured nothing is guessed: the whole frame fits the view (here, with no eyes' projection,
            // about a Quest 3's) on its tight side, nothing cropped. Past it, the same footage blurred and dimmed covers the rest
            // of the view; the room is covered around both, and the cover draws first, then the surround, then the frame.
            var pictureTall = 2f * Mathf.Atan(plane.Height / 2f / RecordedPicture.Distance) * Mathf.Rad2Deg;
            var pictureWide = 2f * Mathf.Atan(plane.Width / 2f / RecordedPicture.Distance) * Mathf.Rad2Deg;
            Require(pictureTall <= RecordedPicture.TallDegrees + .01f && pictureWide <= RecordedPicture.WideDegrees + .01f
                && Mathf.Min(RecordedPicture.TallDegrees - pictureTall, RecordedPicture.WideDegrees - pictureWide) < .01f,
                $"The unmeasured frame is not fitted whole into the view: {pictureWide:0.0} by {pictureTall:0.0} degrees.");
            // A word keeps to the frame, a few degrees inside the view's edge, where the lenses are sharp.
            var seen = f.Picture.Readable;
            Require(seen.X0 > 0f && seen.Y0 > 0f && seen.X1 < 1f && seen.Y1 < 1f && Mathf.Abs(seen.X0 + seen.X1 - 1f) < .001f && Mathf.Abs(seen.Y0 + seen.Y1 - 1f) < .001f
                && Mathf.Abs(Mathf.Atan((.5f - seen.X0) * plane.Width / RecordedPicture.Distance) * Mathf.Rad2Deg
                    - (RecordedPicture.WideDegrees / 2f - RecordedPicture.EdgeDegrees)) < .05f,
                $"The part of the still a word can sit on is not the sharp frame inside its edge: {seen}.");
            var renderers = f.Picture.GetComponentsInChildren<MeshRenderer>(true);
            var face = renderers.Single(renderer => renderer.name == "Recorded picture");
            var surround = renderers.Single(renderer => renderer.name == "Recorded surround");
            Require(surround.sortingOrder < face.sortingOrder, "The blurred footage draws over the frame.");
            Covers(f, surround, "The blurred footage does not surround the person in line with the frame");
            // Past the frame's edge the mirrored blur eases into a far field of the same footage at a few texels, drawn first,
            // so no subject repeats as a shape far out: whole near the frame, gone behind the person.
            var farField = renderers.Single(renderer => renderer.name == "Recorded far field");
            var coarse = farField.sharedMaterial.mainTexture as RenderTexture;
            var nearColors = surround.GetComponent<MeshFilter>().sharedMesh.colors; var nearPoints = surround.GetComponent<MeshFilter>().sharedMesh.vertices;
            float NearAt(Vector3 toward) => nearColors[Enumerable.Range(0, nearPoints.Length).OrderBy(i => Vector3.Angle(nearPoints[i], toward)).First()].a;
            Require(farField.sortingOrder < surround.sortingOrder && coarse != null && Mathf.Max(coarse.width, coarse.height) <= RecordedPicture.FarSide
                && coarse.wrapMode == TextureWrapMode.Mirror && NearAt(Vector3.forward) == 1f && NearAt(Vector3.back) == 0f,
                $"The far field is not a few texels of the footage under a near blur that fades out: {(coarse == null ? "none" : coarse.width + "x" + coarse.height)}, "
                + $"near {NearAt(Vector3.forward):0.00} ahead, {NearAt(Vector3.back):0.00} behind.");
            // The whole image is on the frame, and its outer edge dissolves smoothly into the surround: clear at the edge,
            // whole inside the feather, and in between rising with the distance from the edge, the same on both axes.
            var quad = face.GetComponent<MeshFilter>().sharedMesh;
            var feather = RecordedPicture.Feather;
            bool Edge(Vector2 uv) => uv.x == 0f || uv.x == 1f || uv.y == 0f || uv.y == 1f;
            bool Inside(Vector2 uv) => uv.x >= feather - 1e-4f && uv.x <= 1f - feather + 1e-4f && uv.y >= feather - 1e-4f && uv.y <= 1f - feather + 1e-4f;
            Require(quad.uv.Min(uv => uv.x) == 0f && quad.uv.Max(uv => uv.x) == 1f && quad.uv.Min(uv => uv.y) == 0f && quad.uv.Max(uv => uv.y) == 1f
                && quad.uv.Zip(quad.colors, (uv, color) => Edge(uv) ? color.a == 0f : Inside(uv) ? Mathf.Abs(color.a - 1f) < 1e-4f : color.a > 0f && color.a < 1f).All(right => right)
                && quad.uv.Count(uv => !Edge(uv) && !Inside(uv)) > 40,
                "The frame does not show the whole image with its outer edge dissolving into the surround.");

            // No words on the picture: a photo's only cue is the one word "Recorded", on the frame's lower-left inside its
            // edge, and it stays there when the head turns. It has no player bar.
            var marks = f.Picture.GetComponentsInChildren<TextMeshPro>(true).Where(text => text.gameObject.activeInHierarchy).ToArray();
            Require(marks.Length == 1 && marks[0].text == RecordedPicture.Mark && InCorner(f, marks[0].transform.position),
                "A photo does not show only its Recorded mark in the frame's lower-left.");
            var rest = f.Eyes.rotation; var marked = marks[0].transform.position;
            f.Eyes.rotation = Quaternion.Euler(-10f, 30f, 0f) * rest;
            f.Picture.Follow(f.Eyes, null, float.PositiveInfinity);
            Require(Vector3.Distance(marks[0].transform.position, marked) < 1e-4f, "The Recorded mark moves with the head instead of staying on the frame.");
            f.Eyes.rotation = rest;
            f.Picture.Follow(f.Eyes, null, float.PositiveInfinity);
            Require(f.Picture.Held == null && Bars(f).All(bar => !bar.gameObject.activeInHierarchy), "A photo shows a player bar.");
            NeverNow(f, "with the picture shown");
            // Over the recording the console draws no button, no panel and none of its own words; Boopy stays.
            Invoke(f.App, "KeepRecordingLook", true);
            var spoken = f.Console.GetComponentsInChildren<TextMeshPro>().Where(text => text.GetComponent<MeshRenderer>().enabled
                && !string.IsNullOrWhiteSpace(text.text) && text.GetComponentInParent<DialogueStrip>() == null).Select(text => text.name).ToArray();
            Require(f.Console.GetComponentsInChildren<SpatialAction>().Length == 0
                && f.Console.GetComponentsInChildren<MeshRenderer>().Where(plate => plate.name == "Dialog backing").All(plate => !plate.enabled)
                && spoken.Length == 0,
                "The console draws over the recording: " + string.Join(", ", spoken));
            // Boopy's line over it is a caption with no box: each line on a soft shadow or glow behind it, at 4.5:1 or more over
            // the footage under it.
            f.Strip.Show(DialogueStage.Response, "A synthetic line, long enough to wrap onto a second line under the first.");
            Frames(f, 2);
            for (var t = 0f; t < 1f; t += .1f) { f.Console.RefreshVisuals(.1f); f.Strip.RefreshVisuals(.1f); }
            var line = f.Strip.GetComponentsInChildren<TextMeshPro>().Single(text => text.name == "Actual response");
            Require(line.alpha > .9f, $"Boopy's line over the recording is not shown: words at {line.alpha:0.00}.");
            RequireCaptionContrast(f, "over the synthetic sky", f.Scene.GroundUnder);
            // Its home on the recording keeps all of Boopy and his line inside the frame's sharp part, so the caption never runs off it.
            Frames(f);
            RequireRecordingLayout(f, "with a two-line caption");
            Invoke(f.App, "KeepRecordingLook", false);
            f.Strip.RefreshVisuals(0f);
            Require(f.Strip.GetComponentsInChildren<MeshRenderer>(true).Where(plate => plate.name == "Caption shadow").All(plate => !plate.enabled),
                "A caption shadow stays when the line has its panel back.");
            f.Strip.Hide();

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
            // The view is held on the picture, so the eyes rest on its middle: a talking hand or controller that points at
            // the picture sets the point instead, still as the one gaze point a recorded frame takes.
            var pointing = new HandInput(true, null, null);
            var from = new Vector3(.2f, -.3f, .4f); var toward = Unity(plane.At(.3f, .4f)) - from;
            pointing.Update(f.Eyes, 0f, true, new HandInput.Controller(true, 0f, from, toward));
            Set(f.App, "active", pointing);
            Invoke(f.App, "Capture", new object?[] { null });
            Set(f.App, "active", null);
            var aimed = ((Cues?)Get(f.App, "pendingCues"))?.Gaze;
            Require(aimed != null && Mathf.Abs(aimed.Point.X - .3f) < .001f && Mathf.Abs(aimed.Point.Y - .4f) < .001f && aimed.World == null,
                "The point the hand aims at on the still is not the turn's point: " + (aimed == null ? "none" : aimed.Point.X + ", " + aimed.Point.Y));
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

            // A loose model box is no shape Boopy knows (DESIGN): no box is drawn, and a pin marks where the person pointed.
            Require(Overlays(f) == 0, "A loose model box is drawn on the picture.");
            var pins = f.Scene.GetComponentsInChildren<BoopPin>(true).Where(pin => pin.gameObject.activeInHierarchy).ToArray();
            Require(pins.Length == 1 && OffPlane(plane, pins[0].transform.position) <= .004f
                && Vector2.Distance(ImageOf(plane, pins[0].transform.position), new Vector2(.42f, .63f)) < .002f,
                "No pin marks where the person pointed on the picture.");
            var pinDistance = Vector3.Distance(f.Eyes.position, pins[0].transform.position);
            var pinDegrees = 2f * Mathf.Atan(pins[0].Size.x / 2f / pinDistance) * Mathf.Rad2Deg;
            Require(pinDegrees > 1.7f && pinDegrees < 1.9f, $"The pin is {pinDegrees:0.00} degrees across, not about 1.8.");
            // The subject's anchor, where Boopy goes and its word sits by, is on the subject on the still; it gets no chip.
            Require(f.Scene.TryGetActiveAnchor(out var anchor) && OffPlane(plane, anchor) <= .0015f
                && Vector2.Distance(ImageOf(plane, anchor), new Vector2((SubjectBox.X0 + SubjectBox.X1) / 2f, (SubjectBox.Y0 + SubjectBox.Y1) / 2f)) < .002f,
                "The subject's anchor is not on the subject on the still.");
            Require(f.Scene.GetComponentsInChildren<Chip>(true).All(candidate => !candidate.gameObject.activeInHierarchy), "A subject on the picture has a chip.");
            f.Apply(f.Reply("mask"));
            var mask = SingleOverlay(f);
            Require(f.Scene.GetComponentsInChildren<BoopPin>(true).All(pin => !pin.gameObject.activeInHierarchy), "A pin stays where a real outline shows.");
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
            // The clock Boopy's home keeps time by in these checks.
            public float Clock = 100f;
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

            // The Mac's scene is read, and a first one is put in front of the eyes, as wearing the headset does.
            public void ReadScene()
            {
                ((Task)Invoke(App, "ReadRecordedScene")!).GetAwaiter().GetResult();
                if (Picture.Loaded && !Picture.Placed) Picture.Place(Eyes);
            }

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
            public string Outlines = "{\"samples\":[]}";
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
                if (request.Method == HttpMethod.Get && path == "/v1/recorded-scene/outlines") return Json(HttpStatusCode.OK, Outlines);
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
            string kind = "photo", float? at = null, float? duration = null, string extra = "")
        {
            var digest = sha ?? Sha(still);
            string Number(float? value) => value is float some ? some.ToString(System.Globalization.CultureInfo.InvariantCulture) : "null";
            var frames = kind == "video" ? $"[{{\"frameId\":\"{frameId}\",\"seconds\":{Number(at)},\"frameSha256\":\"{digest}\"}}]" : "[]";
            return $"{{\"scene\":{{\"recordingId\":\"{RecordingId}\",\"frameId\":\"{frameId}\",\"kind\":\"{kind}\",\"width\":{width},\"height\":{height}," +
                $"\"sourceTimeSeconds\":{Number(at)},\"durationSeconds\":{Number(duration)},\"capturedAt\":{{\"value\":null,\"trust\":\"unknown\"}},\"frameSha256\":\"{digest}\",\"frames\":{frames}{extra}}}}}";
        }

        // A drawn desert under a sky with one dark shape where the subject is: synthetic, made here, never a photograph.
        private static byte[] SyntheticStill(bool later, int width = Width, int height = Height)
        {
            var texture = new Texture2D(width, height, TextureFormat.RGB24, false);
            try
            {
                var pixels = new Color32[width * height];
                for (var y = 0; y < height; y++)
                    for (var x = 0; x < width; x++)
                    {
                        // Texture rows run from the bottom; image coordinates from the top.
                        var u = (x + .5f) / width; var v = 1f - (y + .5f) / height;
                        var subject = u >= SubjectBox.X0 + .03f && u <= SubjectBox.X1 - .03f && v >= SubjectBox.Y0 + .04f && v <= SubjectBox.Y1 - .02f;
                        var color = subject ? new Color(.18f, .16f, .15f) : v < .42f ? Color.Lerp(new Color(.55f, .70f, .86f), new Color(.86f, .88f, .86f), v / .42f)
                            : Color.Lerp(new Color(.86f, .70f, .48f), new Color(.74f, .56f, .36f), (v - .42f) / .58f);
                        if (later) color = Color.Lerp(color, new Color(.95f, .62f, .35f), .25f);
                        pixels[y * width + x] = color;
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

        // Whether a point is on the frame's lower-left, just in front of it and inside the part words may sit on.
        private static System.Numerics.Vector3 Numerics(Vector3 value) => new System.Numerics.Vector3(value.x, value.y, value.z);

        private static bool InCorner(Fixture f, Vector3 point)
        {
            var plane = f.Picture.Plane; var image = ImageOf(plane, point); var seen = f.Picture.Readable;
            return OffPlane(plane, point) < .01f && image.x >= seen.X0 && image.x < .5f && image.y > .5f && image.y <= seen.Y1;
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

        // Frames of the recording look, 0.3 s apart on the fixture's clock: long enough for Boopy to settle on his home.
        internal static void Frames(Fixture f, int count = 12)
        {
            for (var i = 0; i < count; i++) { f.Clock += .3f; Set(f.App, "clock", (float?)f.Clock); Invoke(f.App, "KeepRecordingLook", true); Settle(f); }
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
