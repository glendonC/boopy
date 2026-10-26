#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>
    /// The answer shows where the thinking line was (docs/design.md, Placement). A scripted turn: a first answer shows the
    /// subject; the pinch opens the next turn, Boopy listens and thinks; the reply brings three grounded objects, one where
    /// the old follow put the console. From the first thinking frame to two seconds after the answer the console holds its
    /// place, the line's panel keeps its bottom edge while it grows, Boopy flies home only after the change, and the line
    /// never switches between docked and fallback. With reduced motion the panel takes its height at once. When the reply
    /// covers the turn's place, the console moves once, by fade: no visible frame moves it. When the head turns 60 degrees
    /// while Boopy thinks, the console holds the turn's place until the answer has shown, then comes home by fade; a turn
    /// whose reply fails closes all the same. Stills: listening, thinking,
    /// mid-change, answer, Boopy home and two seconds later, head-on at standard and large, and the thinking and answer
    /// frames from the person's own pose for the owner.
    /// </summary>
    public static class AnswerPlaceValidation
    {
        private const BindingFlags Flags = BindingFlags.Instance | BindingFlags.NonPublic;
        private const float Step = 1f / 60f;
        private static string output = "";
        private static string size = "";
        // The head-on aim for one turn's stills, taken at the pinch.
        private static Quaternion? aim;

        public static void Run()
        {
            var context = SynchronizationContext.Current;
            output = Path.Combine(Path.GetTempPath(), "boopy-answer-place");
            try
            {
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                ScriptCoverage.Install();
                SynchronizationContext.SetSynchronizationContext(null);
                Directory.CreateDirectory(output);
                foreach (var large in new[] { false, true })
                {
                    size = large ? "large" : "standard";
                    Turn(large, reduced: false, cover: false, stills: true);
                    Turn(large, reduced: true, cover: false, stills: false);
                    Turn(large, reduced: false, cover: true, stills: false);
                }
                size = "standard";
                Turn(false, reduced: false, cover: false, stills: false, turned: true);
                Unanswered();
                Debug.Log("Boopy answer place validation passed: the answer shows where the thinking line was, one change with the bottom "
                    + "edge fixed, Boopy home after it, no docked or fallback switch, a covered place left by fade only; stills in "
                    + output + " (synthetic).");
            }
            catch (Exception error)
            {
                Debug.LogException(error);
                if (Application.isBatchMode) EditorApplication.Exit(1);
                else throw;
            }
            finally { SynchronizationContext.SetSynchronizationContext(context); }
        }

        // What one frame shows: where the console is, the height of the line panel's bottom edge on the console and the panel's height, how visible the console is,
        // whether the line is on its fallback strip, whether Boopy is away at the subject, and whether it has started home. Opacity
        // is the most visible of the line's panel and the row; Panel is the line's panel alone, which the row never re-reveals.
        private readonly struct Sample
        {
            public readonly float Time; public readonly Vector3 Console; public readonly float Bottom; public readonly float Height;
            public readonly float Opacity; public readonly float Panel; public readonly bool Fallback; public readonly bool Away; public readonly bool Home;
            public Sample(float time, Vector3 console, float bottom, float height, float opacity, float panel, bool fallback, bool away, bool home)
            { Time = time; Console = console; Bottom = bottom; Height = height; Opacity = opacity; Panel = panel; Fallback = fallback; Away = away; Home = home; }
        }

        private static void Turn(bool large, bool reduced, bool cover, bool stills, bool turned = false)
        {
            var when = size + (reduced ? ", reduced motion" : "") + (cover ? ", covered place" : "") + (turned ? ", head turned" : "");
            using var f = new TaskPresentationValidation.Fixture(large);
            if (reduced) f.Console.Activate(ConsoleAction.Motion);
            var camera = stills ? ControlGrammarValidation.Camera(f) : null;
            aim = null;
            var follow = f.App.gameObject.AddComponent<FollowConsole>();
            follow.Initialize(f.Eyes, f.Console.transform);
            Set(f.App, "following", follow);
            // The first answer shows the subject, as the person saw it before this turn; its frame grounds every object, the
            // reply's too, as the app's first turn keeps it.
            f.Scene.Remember(TaskPresentationValidation.ObservationId, TaskPresentationValidation.Snapshot());
            Invoke(f.App, "Apply", TaskPresentationValidation.Session());
            var trace = new List<Sample>();
            var clock = 0f;
            Frames(f, 1f, null, ref clock);

            // The pinch opens the next turn: Boopy listens, then thinks, where its line now is.
            Invoke(f.App, "OpenTurn");
            f.Console.ShowListening();
            f.Strip.Show(DialogueStage.Listening, "Listening… Release to finish.");
            Frames(f, .5f, trace, ref clock);
            if (camera != null) Shot(f, camera, "listening");
            var opened = trace.Count;
            float replied = 0f;
            f.Transport.SessionView = Reply(cover);
            f.Transport.OnUtter = () =>
            {
                // A look well away while Boopy thinks: the turn's place holds all the same.
                if (turned) f.Eyes.Rotate(0f, 60f, 0f, Space.World);
                Frames(f, .6f, trace, ref clock);
                if (camera != null) { Shot(f, camera, "thinking"); if (!large) Owner(f, "thinking"); }
                replied = clock;
            };
            Set(f.App, "pending", TaskPresentationValidation.Snapshot());
            Set(f.App, "pendingEvidence", new EvidenceTurn(false));
            ((Task)typeof(BoopyApp).GetMethod("Send", Flags)!.Invoke(f.App, new object[] { SpeechValidation.SyntheticWav() })!).GetAwaiter().GetResult();
            var layout = Layout(f);
            Require(Get(f.App, "session") is SessionView view && view.Utterances.Any(utterance => utterance.Id == "synthetic-turn-2"), when + ": the reply was not applied.");
            var thinkingFrames = trace.Skip(opened).TakeWhile(sample => sample.Time <= replied).ToArray();
            Require(thinkingFrames.Length > 0, when + ": no thinking frame was drawn.");
            var first = thinkingFrames[0];
            var shots = stills ? new Dictionary<float, string> { [.25f] = "mid-change", [.45f] = "answer", [1f] = "home", [2.45f] = "later" } : new Dictionary<float, string>();
            foreach (var (at, name) in shots.OrderBy(pair => pair.Key))
            {
                Frames(f, replied + at - clock, trace, ref clock);
                if (camera != null) { Shot(f, camera, name); if (!large && name == "answer") Owner(f, "answer"); }
            }
            Frames(f, replied + 2.5f - clock, trace, ref clock);
            var after = trace.Where(sample => sample.Time > replied).ToArray();

            // (f) The line never leaves the console for its fallback strip during the turn. With its place covered, the large
            // console may find no clear spot near (the scene's search, as before this unit): then the line takes its fallback
            // strip by fade, after the console has gone unseen, and that is all this case shows.
            var fell = trace.Skip(opened).FirstOrDefault(sample => sample.Fallback);
            if (cover && large && fell.Fallback)
            {
                var gone = trace.Skip(opened).TakeWhile(sample => !sample.Fallback).Last();
                Require(gone.Opacity <= .02f, when + ": the line took its fallback strip while the console still showed.");
                Debug.Log("Boopy answer place: " + when + ": no clear spot near; the line took its fallback strip by fade.");
                return;
            }
            Require(!fell.Fallback, when + ": the line switched to its fallback strip during the turn, first " + Mm(fell.Time - replied)
                + " ms after the reply; at the reply " + layout + ".");
            if (!cover)
            {
                // (a) The console holds the place the thinking line had, from its first frame to two seconds after the answer; with
                // the head turned, until the answer has shown (650 ms).
                var closed = turned ? replied + .65f - Step : float.PositiveInfinity;
                var held = trace.Skip(opened).Where(sample => sample.Time >= first.Time && sample.Time < closed).ToArray();
                var drift = held.Max(sample => Vector3.Distance(sample.Console, first.Console));
                var moved = held.FirstOrDefault(sample => Vector3.Distance(sample.Console, first.Console) > .01f);
                Require(drift <= .01f, when + ": the console moves " + Mm(drift) + " mm between the thinking line and the answer, first "
                    + Mm(moved.Time - replied) + " ms after the reply; at the reply " + layout + ".");
                // (b) The line's panel keeps its bottom edge while it grows: the edge's height on the console, not its middle,
                // which moves as the panel widens to the right.
                // From the last thinking frame, so the step where the answer takes the line's place counts too; within 1 mm.
                var edge = thinkingFrames[thinkingFrames.Length - 1].Bottom;
                var sink = held.Where(sample => sample.Time > replied).Max(sample => Mathf.Abs(sample.Bottom - edge));
                Require(sink <= .001f, when + ": the line panel's bottom edge moves " + Mm(sink) + " mm as the answer shows.");
                Debug.Log("Boopy answer place: " + when + ": the line panel's bottom edge moves at most " + (sink * 1000f).ToString("0.00") + " mm (1 mm allowed).");
                // (g) Kept in place, the console's panel neither fades nor shows itself again as the answer comes (the thinking stage
                // reveals it before, under the working line, which shows whole).
                var dim = held.Where(sample => sample.Time > replied).Min(sample => sample.Panel);
                Require(dim >= .98f, when + ": the console's panel fades to " + dim.ToString("0.00") + " as the answer shows.");
                // (h) After the turn, home 60 degrees off and the eyes elsewhere, the console comes home.
                if (turned)
                {
                    var away = Vector3.Distance(after[after.Length - 1].Console, follow.Home);
                    Require(away <= .02f, when + ": after the turn the console stays " + Mm(away) + " mm from its home in this view.");
                }
            }
            else
            {
                // (d) The covered place is left once, by fade: the console is never seen between its two places.
                var start = after[0].Console; var end = after[after.Length - 1].Console;
                Require(Vector3.Distance(start, end) > .01f, when + ": the console stayed over the reply's object.");
                var seen = after.Where(sample => sample.Opacity > .02f && Vector3.Distance(sample.Console, start) > .01f && Vector3.Distance(sample.Console, end) > .01f).ToArray();
                Require(seen.Length == 0, when + ": the console is seen moving between its places (" + seen.Length + " frames).");
            }
            // (d) Every move, for a covered place or home after a turn, happens unseen.
            var jumps = after.Zip(after.Skip(1), (from, to) => Vector3.Distance(from.Console, to.Console) > .01f && from.Opacity > .02f).Count(jump => jump);
            Require(jumps == 0, when + ": the console jumps to its new place while seen.");
            // (e) The answer grows the panel over several frames, or at once with reduced motion.
            var low = Mathf.Min(after[0].Height, after[after.Length - 1].Height); var high = Mathf.Max(after[0].Height, after[after.Length - 1].Height);
            var growing = after.Count(sample => sample.Height > low + .001f && sample.Height < high - .001f);
            Require(high - low > .005f, when + ": the answer does not take more room than the thinking line, so the change shows nothing.");
            Require(reduced ? growing == 0 : growing >= 3, when + ": the panel grows over " + growing + " frames" + (reduced ? ", not at once." : ", not over about 200 ms."));
            // (c) Boopy flies home at least 250 ms after the change ends (650 ms after the reply).
            if (!reduced)
            {
                Require(thinkingFrames.Any(sample => sample.Away), when + ": Boopy never left for the subject while it thought.");
                var home = after.FirstOrDefault(sample => sample.Home);
                Require(home.Time > 0f && home.Time - replied >= .65f - Step, when + ": Boopy starts home " + Mm(home.Time - replied) + " ms after the reply, not 650.");
            }
        }

        // A turn the Mac never answers closes all the same: with the head turned 60 degrees while it waits, the console comes
        // home once the reply fails, not held for a turn that is over.
        private static void Unanswered()
        {
            const string when = "standard, no answer";
            using var f = new TaskPresentationValidation.Fixture(false);
            var follow = f.App.gameObject.AddComponent<FollowConsole>();
            follow.Initialize(f.Eyes, f.Console.transform);
            Set(f.App, "following", follow);
            f.Scene.Remember(TaskPresentationValidation.ObservationId, TaskPresentationValidation.Snapshot());
            Invoke(f.App, "Apply", TaskPresentationValidation.Session());
            var trace = new List<Sample>(); var clock = 0f;
            Frames(f, 1f, null, ref clock);
            Invoke(f.App, "OpenTurn");
            f.Console.ShowListening();
            f.Strip.Show(DialogueStage.Listening, "Listening… Release to finish.");
            Frames(f, .5f, trace, ref clock);
            f.Transport.OnUtter = () =>
            {
                f.Eyes.Rotate(0f, 60f, 0f, Space.World);
                Frames(f, .6f, trace, ref clock);
                throw new InvalidOperationException("Synthetic lost reply.");
            };
            Set(f.App, "pending", TaskPresentationValidation.Snapshot());
            Set(f.App, "pendingEvidence", new EvidenceTurn(false));
            ((Task)typeof(BoopyApp).GetMethod("Send", Flags)!.Invoke(f.App, new object[] { SpeechValidation.SyntheticWav() })!).GetAwaiter().GetResult();
            Require(!(bool)Get(f.App, "turnOpen")!, when + ": the turn stayed open after its reply failed.");
            Frames(f, 1f, trace, ref clock);
            var away = Vector3.Distance(f.Console.transform.position, follow.Home);
            Require(away <= .02f, when + ": the console stays " + Mm(away) + " mm from its home after a turn without an answer.");
        }

        // Frames of the given length, each the way the app draws one: the console keeps its place, then everything refreshes.
        private static void Frames(TaskPresentationValidation.Fixture f, float seconds, List<Sample>? trace, ref float clock)
        {
            for (var elapsed = 0f; elapsed < seconds - 1e-4f; elapsed += Step)
            {
                typeof(BoopyApp).GetMethod("KeepConsolePlace", Flags)!.Invoke(f.App, new object?[] { new Ray(f.Eyes.position, f.Eyes.forward), null });
                f.Console.RefreshVisuals(Step); f.Strip.RefreshVisuals(Step);
                clock += Step;
                if (trace == null) continue;
                var backing = f.Strip.GetComponentsInChildren<MeshRenderer>(true).Single(renderer => renderer.name == "Speech contrast backing").transform;
                var header = f.Console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Intent instrument");
                var bar = f.Console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Control bar");
                trace.Add(new Sample(clock, f.Console.transform.position, f.Console.transform.InverseTransformPoint(backing.TransformPoint(new Vector3(0f, -.5f, 0f))).y,
                    backing.lossyScale.y, Mathf.Max(header.Opacity, bar.Opacity), header.Opacity, (bool)Get(f.Strip, "fallback")!, Get(f.Console, "visitPoint") != null,
                    (bool)Get(f.Console, "returning")!));
            }
        }

        // The reply to the second turn: a longer answer, the subject and two more grounded objects, one ahead and 20 degrees
        // down where the old follow placed the console, clear of the turn's place at either text size, one at the left; with
        // cover, a fourth where the turn's place is.
        private static SessionView Reply(bool cover)
        {
            var view = TaskPresentationValidation.Session();
            view.Utterances.Add(new UtteranceRef { Id = "synthetic-turn-2", Text = "And this one?", Kind = "ask" });
            view.Dialogue!.UtteranceId = "synthetic-turn-2"; view.Dialogue.At = "1970-01-01T12:00:05Z";
            view.Dialogue.Text = "It looks like a stone marker at the edge of the trail, with a painted arrow above it. I can't tell who placed it.";
            view.Dialogue.Actions.Clear();
            Add(view, "synthetic-ahead", "Painted arrow", new Box2 { X0 = .40f, Y0 = .62f, X1 = .54f, Y1 = .75f });
            Add(view, "synthetic-left", "Trail post", new Box2 { X0 = .12f, Y0 = .3f, X1 = .26f, Y1 = .48f });
            if (cover) Add(view, "synthetic-right", "Metal plate", new Box2 { X0 = .68f, Y0 = .4f, X1 = .9f, Y1 = .66f });
            return view;
        }

        private static void Add(SessionView view, string id, string label, Box2 box) => view.Items.Add(new Item
        {
            Id = id, Kind = "object", Label = label, Statement = "A synthetic proposed object.", Origin = "model", Status = "proposed", Confidence = .4f,
            Grounding = new Grounding { Kind = "box", ObservationId = TaskPresentationValidation.ObservationId, Box = box },
        });

        // Head-on at the turn's place: one aim for all six frames, taken at the pinch at the console and its line with Boopy left
        // out, so the frames show the line holding its place while Boopy flies to the subject and back.
        private static void Shot(TaskPresentationValidation.Fixture f, Camera camera, string name)
        {
            var companion = ((Component)Get(f.Console, "companion")!).transform;
            if (aim == null)
            {
                var parts = f.Console.GetComponentsInChildren<Renderer>().Concat(f.Strip.GetComponentsInChildren<Renderer>())
                    .Where(part => part.enabled && !part.transform.IsChildOf(companion)).ToArray();
                var bounds = parts[0].bounds; foreach (var part in parts) bounds.Encapsulate(part.bounds);
                aim = Quaternion.LookRotation(bounds.center - f.Eyes.position, Vector3.up);
            }
            var rotation = f.Eyes.rotation; var previous = RenderTexture.active;
            var target = new RenderTexture(1600, 900, 24); var pixels = new Texture2D(1600, 900, TextureFormat.RGB24, false);
            try
            {
                f.Eyes.rotation = aim.Value;
                camera.fieldOfView = 28f; camera.aspect = 16f / 9f;
                camera.targetTexture = target; camera.Render();
                RenderTexture.active = target; pixels.ReadPixels(new Rect(0, 0, 1600, 900), 0, 0); pixels.Apply();
                File.WriteAllBytes(Path.Combine(output, name + "-" + size + ".png"), pixels.EncodeToPNG());
            }
            finally
            {
                f.Eyes.rotation = rotation; camera.targetTexture = null; RenderTexture.active = previous;
                UnityEngine.Object.DestroyImmediate(pixels); UnityEngine.Object.DestroyImmediate(target);
            }
        }

        // The person's own view, not turned to the console: the subject and Boopy's line in one wide frame.
        private static void Owner(TaskPresentationValidation.Fixture f, string name)
        {
            var go = new GameObject("Owner view");
            try
            {
                go.transform.SetPositionAndRotation(f.Eyes.position, f.Eyes.rotation);
                var camera = go.AddComponent<Camera>();
                camera.fieldOfView = 70f; camera.aspect = 16f / 9f; camera.nearClipPlane = .05f; camera.farClipPlane = 10f;
                camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = new Color(.2f, .21f, .22f);
                var target = new RenderTexture(1600, 900, 24); var pixels = new Texture2D(1600, 900, TextureFormat.RGB24, false);
                var previous = RenderTexture.active;
                try
                {
                    camera.targetTexture = target; camera.Render();
                    RenderTexture.active = target; pixels.ReadPixels(new Rect(0, 0, 1600, 900), 0, 0); pixels.Apply();
                    File.WriteAllBytes(Path.Combine(output, "owner-" + name + ".png"), pixels.EncodeToPNG());
                }
                finally { camera.targetTexture = null; RenderTexture.active = previous; UnityEngine.Object.DestroyImmediate(target); UnityEngine.Object.DestroyImmediate(pixels); }
            }
            finally { UnityEngine.Object.DestroyImmediate(go); }
        }

        // What the scene keeps clear in the turn's view, and where the console stands in it.
        private static string Layout(TaskPresentationValidation.Fixture f)
        {
            static string Rect(LabelRect r) => "(" + r.MinX.ToString("0.00") + ", " + r.MinY.ToString("0.00") + ")-(" + r.MaxX.ToString("0.00") + ", " + r.MaxY.ToString("0.00") + ")";
            var areas = (List<LabelRect>)Get(f.Scene, "protectedAreas")!;
            var bounds = typeof(SessionScene).GetMethod("ConsoleBounds", Flags, null, new[] { typeof(ContextConsole), typeof(LabelRect).MakeByRefType() }, null)!;
            var args = new object?[] { f.Console, null };
            var placed = (bool)bounds.Invoke(f.Scene, args)!;
            var words = "objects " + string.Join(" ", areas.Select(Rect)) + (placed ? ", console " + Rect((LabelRect)args[1]!) : ", console unplaced");
            // The scene's own search for a clear spot, in the view and then wider, and whether its footprint is clear.
            var view = (LabelRect)typeof(SessionScene).GetField("ViewBounds", BindingFlags.NonPublic | BindingFlags.Static)!.GetValue(null)!;
            var wide = (LabelRect)typeof(SessionScene).GetMethod("Expanded", Flags)!.Invoke(f.Scene, null)!;
            foreach (var (name, area) in new[] { ("view", view), ("wide", wide) })
            {
                var search = new object?[] { f.Console.LayoutSize, SessionScene.ConsoleHome, new List<LabelRect>(), area, null, null };
                var found = (bool)typeof(SessionScene).GetMethod("TryPlaceElement", Flags)!.Invoke(f.Scene, search)!;
                if (!found) { words += ", " + name + " none"; continue; }
                var anchor = (Vector3)typeof(SessionScene).GetMethod("ConsoleAnchor", Flags)!.Invoke(f.Scene, new object[] { (Vector3)search[4]! })!;
                var clear = (bool)typeof(SessionScene).GetMethod("FollowFootprintClear", Flags)!.Invoke(f.Scene, new object[] { f.Console, anchor })!;
                words += ", " + name + " " + Rect((LabelRect)search[5]!) + (clear ? " clear" : " footprint not clear");
            }
            return words + ", size " + f.Console.LayoutSize.x.ToString("0.00") + " x " + f.Console.LayoutSize.y.ToString("0.00");
        }

        private static string Mm(float value) => (value * 1000f).ToString("0");
        private static object? Invoke(object target, string name, params object[] args) => target.GetType().GetMethod(name, Flags)!.Invoke(target, args);
        private static void Set(object target, string name, object? value) => target.GetType().GetField(name, Flags)!.SetValue(target, value);
        private static object? Get(object target, string name) => target.GetType().GetField(name, Flags)!.GetValue(target);
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
