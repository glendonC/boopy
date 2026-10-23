#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>
    /// One control grammar on the console, through BoopyApp with synthetic views and transport. One row under the panel,
    /// its left edge on the text column (x -0.135 in the panel's frame) and its right edge at x 0.265, with at most three
    /// equal tiles of 0.124 by 0.060 and 0.014 gaps filled from the left, the orb left of the column. The first tile is the
    /// recommended action, and Pause, the privacy stop, keeps slot 2 in every state: while Boopy's line asks [Answer,
    /// Pause, More], otherwise [Talk, Pause, More], More swapping in place to [Context, Pause, More] and then [Settings,
    /// Pause, Back], recording [Finish, Pause, Cancel], working [Stop, Pause], a pending recovery [Check, Pause, New], busy
    /// [-, Pause, -]. Every control is the same tile: the control plate, an ivory Plex Regular label at the body
    /// size, its filled glyph and label centered as one group inside the tile; nothing is filled and nothing is borderless.
    /// Every tile carries a filled glyph, the same for its action in every state. The panel holds only Boopy's line, its
    /// paging target off the row, its speaker label
    /// with it, ending one gap above the row; the recovery dialog is "Earlier capture" and one sentence on the line's dark
    /// panel, with no speaker line. Head-on stills at rest, while thinking and of the recovery dialog, standard and large,
    /// and one owner picture (rest and the recovery dialog). In batch mode any failure exits non-zero.
    /// </summary>
    public static class ControlGrammarValidation
    {
        private const BindingFlags Flags = BindingFlags.Instance | BindingFlags.NonPublic;
        private const float Column = -.135f, Right = .265f, Slot = .124f;
        private const string Identity = "00000000-0000-4000-8000-000000000042";
        internal const string RecoverySentence = "Boopy restarted before it heard back from your Mac. The picture is gone from the headset.";
        private const int Width = 1600, Height = 900;

        public static void Run()
        {
            var context = SynchronizationContext.Current;
            var output = Path.Combine(Path.GetTempPath(), "boopy-control-grammar");
            try
            {
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                HangulFont.Install();
                SynchronizationContext.SetSynchronizationContext(null);
                Directory.CreateDirectory(output);
                var owner = new List<Color32[]>();
                foreach (var large in new[] { false, true }) Validate(large, output, large ? null : owner);
                Stack(owner, Path.Combine(output, "control-grammar-owner.png"));
                Debug.Log("Boopy control grammar validation passed: one row of identical tiles on the text column, the recommended action "
                    + "first, the states' tiles, More in place, Plex Regular centered labels, filled glyphs, the panel one gap above the "
                    + "row with its speaker label on its line, the recovery dialog; stills in " + output + " (synthetic).");
            }
            catch (Exception error)
            {
                Debug.LogException(error);
                if (Application.isBatchMode) EditorApplication.Exit(1);
                else throw;
            }
            finally { SynchronizationContext.SetSynchronizationContext(context); }
        }

        private static void Validate(bool large, string output, List<Color32[]>? owner)
        {
            var size = large ? "large" : "standard";
            using (var f = new TaskPresentationValidation.Fixture(large))
            {
                var camera = Camera(f);
                f.Transport.Open.Enqueue(() => TaskPresentationValidation.Reply(HttpStatusCode.OK, TaskPresentationValidation.TaskView()));
                f.Start();
                Settle(f);

                // At rest under Boopy's question: Answer is the first tile, and the panel holds only the line.
                Shelf(f, "At rest", ConsoleAction.AnswerTask, ConsoleAction.PauseScene, ConsoleAction.More);
                OneStyle(f, "At rest");
                Require(Control(f, ConsoleAction.AnswerTask).AccessibleLabel == "Answer", "The speak tile is not labeled Answer while Boopy asks.");
                Glyph(f, ConsoleAction.AnswerTask, "talk"); Glyph(f, ConsoleAction.PauseScene, "pause"); Glyph(f, ConsoleAction.More, "more");
                PagerOffRow(f, "At rest");
                f.Console.SetScenePaused(true); Glyph(f, ConsoleAction.PauseScene, "resume"); f.Console.SetScenePaused(false);
                OneStyle(f, "Right after Resume and back");
                OrbLeftOfColumn(f, "At rest");
                GapAboveShelf(f, "At rest");
                SpeakerWithLine(f, "At rest");
                var rest = Shot(f, camera, Path.Combine(output, "rest-" + size + ".png")); owner?.Add(rest);

                // More swaps the same row in place, its second page ending in Back, and Back returns it.
                f.Console.Activate(ConsoleAction.More); Settle(f);
                Shelf(f, "More", ConsoleAction.Options, ConsoleAction.PauseScene, ConsoleAction.More);
                OneStyle(f, "More");
                Glyph(f, ConsoleAction.Options, "context");
                Require(Control(f, ConsoleAction.Options).AccessibleLabel == "Context", "More does not offer Context.");
                f.Console.Activate(ConsoleAction.More); Settle(f);
                Shelf(f, "More, second page", ConsoleAction.Settings, ConsoleAction.PauseScene, ConsoleAction.ShelfBack);
                OneStyle(f, "More, second page");
                Glyph(f, ConsoleAction.Settings, "settings"); Glyph(f, ConsoleAction.ShelfBack, "back");
                Require(Control(f, ConsoleAction.Settings).AccessibleLabel == "Settings" && Control(f, ConsoleAction.ShelfBack).AccessibleLabel == "Back",
                    "More's second page does not offer Settings and Back.");
                f.Console.Activate(ConsoleAction.ShelfBack); Settle(f);
                Shelf(f, "Back from More", ConsoleAction.AnswerTask, ConsoleAction.PauseScene, ConsoleAction.More);

                // Recording: Finish, Pause, Cancel.
                var talk = (ButtonTalk)Get(f.App, "buttonTalk")!;
                // Listening by voice: Pause alone, still in slot 2.
                f.Console.ShowListening(false); Settle(f);
                Shelf(f, "Listening", ConsoleAction.None, ConsoleAction.PauseScene, ConsoleAction.None);
                talk.Begin(0f); f.Console.SetButtonRecording(true);
                f.Strip.Show(DialogueStage.Listening, "Listening… Tap Finish when done.");
                Settle(f);
                Shelf(f, "Recording", ConsoleAction.FinishTalk, ConsoleAction.PauseScene, ConsoleAction.Cancel);
                OneStyle(f, "Recording");
                Require(Control(f, ConsoleAction.Cancel).AccessibleLabel == "Cancel", "Recording's third tile is not Cancel.");
                Glyph(f, ConsoleAction.FinishTalk, "talk"); Glyph(f, ConsoleAction.Cancel, "cancel");
                Invoke(f.App, "DiscardRecording"); Invoke(f.App, "RestoreConsole");

                // Working: Stop, Pause, while a later turn is with the Mac. A turn without a photo keeps Boopy home, so the
                // still shows the whole console while it thinks.
                string? working = "The later turn never reached the Mac.";
                f.Transport.OnUtter = () =>
                {
                    Settle(f);
                    try
                    {
                        Shelf(f, "Working", ConsoleAction.Cancel, ConsoleAction.PauseScene, ConsoleAction.None);
                        OneStyle(f, "Working");
                        Require(Control(f, ConsoleAction.Cancel).AccessibleLabel == "Stop", "Working's first tile is not Stop.");
                        Glyph(f, ConsoleAction.Cancel, "stop");
                        GapAboveShelf(f, "Working");
                        working = null;
                    }
                    catch (InvalidOperationException problem) { working = problem.Message; }
                    Shot(f, camera, Path.Combine(output, "thinking-" + size + ".png"));
                };
                Set(f.App, "pending", TaskPresentationValidation.Snapshot()); Set(f.App, "pendingEvidence", new EvidenceTurn(true));
                ((Task)typeof(BoopyApp).GetMethod("Send", Flags)!.Invoke(f.App, new object[] { SpeechValidation.SyntheticWav() })!).GetAwaiter().GetResult();
                f.Transport.OnUtter = null;
                Require(working == null, "Working: " + working);
            }

            // Boopy's line asks nothing, so no Answer: Talk is the first tile.
            using (var s = new TaskPresentationValidation.Fixture(large))
            {
                s.Transport.Open.Enqueue(() => TaskPresentationValidation.Reply(HttpStatusCode.OK,
                    TaskPresentationValidation.TaskView(components: TaskPresentationValidation.Parts(action: null))));
                s.Start();
                Settle(s);
                Shelf(s, "A statement", ConsoleAction.Talk, ConsoleAction.PauseScene, ConsoleAction.More);
                OneStyle(s, "A statement");
                Glyph(s, ConsoleAction.Talk, "talk");
                PagerOffRow(s, "A statement");
                GapAboveShelf(s, "A statement");
                SpeakerWithLine(s, "A statement");
                OrbLeftOfColumn(s, "A statement");
            }

            // A capture left pending by a restart: the dialog on the panel, and Check, Pause and New on the row.
            using (var r = new TaskPresentationValidation.Fixture(large))
            {
                var camera = Camera(r);
                ((CaptureRecoveryStore)Get(r.App, "recoveryStore")!).Save(Identity);
                Invoke(r.App, "RestoreCaptureRecovery");
                Settle(r);
                Shelf(r, "Recovery", ConsoleAction.CheckCapture, ConsoleAction.PauseScene, ConsoleAction.DismissCapture);
                OneStyle(r, "Recovery");
                Require(Control(r, ConsoleAction.CheckCapture).AccessibleLabel == "Check" && Control(r, ConsoleAction.DismissCapture).AccessibleLabel == "New",
                    "The recovery row does not offer Check and New.");
                Glyph(r, ConsoleAction.CheckCapture, "check"); Glyph(r, ConsoleAction.DismissCapture, "new");
                var header = r.Console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Intent instrument");
                var texts = header.GetComponentsInChildren<TextMeshPro>(true);
                Require(texts.Single(text => text.name == "Title").text == "Earlier capture", "The recovery dialog is not titled Earlier capture.");
                Require(texts.Single(text => text.name == "Body").text == RecoverySentence, "The recovery dialog's sentence: " + texts.Single(text => text.name == "Body").text);
                Require(texts.Single(text => text.name == "State").text == "" && !r.Strip.gameObject.activeInHierarchy,
                    "The recovery dialog has a speaker or state line.");
                // The dialog sits on the line's dark panel: one backing in the panel color behind its title and sentence.
                var backing = header.GetComponentsInChildren<MeshRenderer>(true).SingleOrDefault(renderer => renderer.name == "Dialog backing");
                Require(backing != null && backing.enabled && backing.gameObject.activeInHierarchy, "The recovery dialog has no backing.");
                var tint = new MaterialPropertyBlock(); backing!.GetPropertyBlock(tint);
                Require(Near(tint.GetColor("_Color"), SpatialTheme.Panel), "The recovery dialog's backing is not the line's panel color.");
                var low = r.Console.transform.InverseTransformPoint(backing.transform.TransformPoint(new Vector3(-.5f, -.5f, 0f)));
                var high = r.Console.transform.InverseTransformPoint(backing.transform.TransformPoint(new Vector3(.5f, .5f, 0f)));
                foreach (var text in new[] { texts.Single(t => t.name == "Title"), texts.Single(t => t.name == "Body") })
                {
                    text.ForceMeshUpdate(true, true);
                    var a = r.Console.transform.InverseTransformPoint(text.transform.TransformPoint(text.textBounds.min));
                    var b = r.Console.transform.InverseTransformPoint(text.transform.TransformPoint(text.textBounds.max));
                    Require(Mathf.Min(a.x, b.x) >= low.x - .001f && Mathf.Max(a.x, b.x) <= high.x + .001f && Mathf.Min(a.y, b.y) >= low.y - .001f
                        && Mathf.Max(a.y, b.y) <= high.y + .001f, "The recovery dialog's " + text.name.ToLowerInvariant() + " sits off its backing.");
                }
                Require(OutsideOrb(r, low.x), "The recovery dialog's backing reaches under the orb.");
                GapAboveShelf(r, "Recovery", backing.transform);
                var recovery = Shot(r, camera, Path.Combine(output, "recovery-" + size + ".png")); owner?.Add(recovery);
                // While it checks, the check can be stopped: Stop, then Pause in slot 2.
                r.Console.ShowCheckingCapture(); Settle(r);
                Shelf(r, "Checking", ConsoleAction.Cancel, ConsoleAction.PauseScene, ConsoleAction.None);
            }

            // A start lost in the same run: the same dialog, in words that claim no restart and no lost picture, since
            // this run still holds the picture.
            using (var lost = new TaskPresentationValidation.Fixture(large))
            {
                lost.Transport.OnStart = () => throw new HttpRequestException("Synthetic dropped start.");
                Set(lost.App, "pending", TaskPresentationValidation.Snapshot()); Set(lost.App, "pendingEvidence", new EvidenceTurn(false));
                ((Task)typeof(BoopyApp).GetMethod("Send", Flags)!.Invoke(lost.App, new object[] { SpeechValidation.SyntheticWav() })!).GetAwaiter().GetResult();
                Settle(lost);
                var header = lost.Console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Intent instrument");
                var texts = header.GetComponentsInChildren<TextMeshPro>(true);
                var words = texts.Single(text => text.name == "Body").text;
                Require(texts.Single(text => text.name == "Title").text == "Earlier capture" && Control(lost, ConsoleAction.CheckCapture).gameObject.activeInHierarchy,
                    "A start lost in the same run does not offer the recovery dialog.");
                Require(Get(lost.App, "unresolvedSnapshot") != null, "A start lost in the same run dropped its picture.");
                Require(words.Length > 0 && !words.Contains("restarted") && !words.Contains("gone"),
                    "A start lost in the same run says Boopy restarted or the picture is gone: " + words);
            }
        }

        // The visible row: exactly these tiles in these slots of the text column (None leaves a slot empty), the first being
        // the recommended action.
        internal static void Shelf(TaskPresentationValidation.Fixture f, string when, params ConsoleAction[] slots)
        {
            var bar = f.Console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Control bar");
            var shown = bar.GetComponentsInChildren<SpatialAction>().Where(control => control.gameObject.activeInHierarchy)
                .OrderBy(control => Box(f, control).center.x).ToArray();
            var expected = slots.Where(action => action != ConsoleAction.None).ToArray();
            Require(shown.Select(control => control.Action).SequenceEqual(expected),
                when + ": expected the row [" + string.Join(", ", slots) + "], found [" + string.Join(", ", shown.Select(control => control.Action)) + "].");
            for (var i = 0; i < shown.Length; i++)
            {
                var box = Box(f, shown[i]);
                var left = Column + Array.IndexOf(slots, shown[i].Action) * (Slot + SpatialTheme.Gap);
                Require(Mathf.Abs(box.min.x - left) < .001f && Mathf.Abs(box.size.x - Slot) < .001f && Mathf.Abs(box.size.y - SpatialTheme.Target) < .001f
                    && box.max.x <= Right + .001f,
                    when + ": " + shown[i].Action + " is not slot " + (i + 1) + " (left " + left.ToString("0.000") + ", 0.124 by 0.060): left "
                    + box.min.x.ToString("0.000") + ", " + box.size.x.ToString("0.000") + " by " + box.size.y.ToString("0.000") + ".");
                Centered(shown[i], when + " " + shown[i].Action);
            }
        }

        // One tile style for every visible control: the control plate, an ivory Plex Regular label at the body size on one
        // line that fits, the same 0.124 by 0.060 target. Nothing is filled, nothing is borderless.
        internal static void OneStyle(TaskPresentationValidation.Fixture f, string when)
        {
            foreach (var control in f.Console.GetComponentsInChildren<SpatialAction>().Where(control => control.gameObject.activeInHierarchy))
            {
                var verb = Verb(control); verb.ForceMeshUpdate(true, true);
                var plate = new MaterialPropertyBlock();
                control.GetComponentsInChildren<MeshRenderer>(true).Single(renderer => renderer.name == "Action surface").GetPropertyBlock(plate);
                var fill = plate.GetColor("_Color");
                var box = control.GetComponent<BoxCollider>();
                var content = control.transform.parent.name != "Control bar";
                Require(verb.font == BoopyTypography.Load() && Mathf.Approximately(verb.fontSize, SpatialTheme.Body) && Near(verb.color, SpatialTheme.Ivory)
                    && Near(fill, SpatialTheme.Control) && fill.a > .9f && !verb.isTextOverflowing && verb.textInfo.lineCount == 1
                    && (content || Mathf.Abs(box.size.x - Slot) < .001f) && Mathf.Abs(box.size.y - SpatialTheme.Target) < .001f,
                    when + ": " + control.Action + " (\"" + control.AccessibleLabel + "\") is not the one tile style.");
                // The glyph takes its label's color the moment it is drawn, even right after a relabel rebuilt it.
                foreach (var stroke in control.GetComponentsInChildren<SpatialActionIcon>(true).SelectMany(icon => icon.GetComponentsInChildren<LineRenderer>(true)).Where(line => line.enabled))
                    Require(Near(stroke.startColor, verb.color), when + ": " + control.Action + "'s glyph is " + stroke.startColor + ", not its label's color.");
                // Glyph and label stay inside the tile with 3 mm to spare.
                var xs = verb.textInfo.characterInfo.Take(verb.textInfo.characterCount).Where(glyph => glyph.isVisible)
                    .SelectMany(glyph => new[] { glyph.bottomLeft, glyph.topRight }).Select(point => control.transform.InverseTransformPoint(verb.transform.TransformPoint(point)).x)
                    .Concat(Strokes(control).Select(point => point.x)).ToArray();
                Require(xs.Length > 0 && xs.Max(x => Mathf.Abs(x)) <= box.size.x / 2f - .003f,
                    when + ": " + control.Action + " (\"" + control.AccessibleLabel + "\") does not fit its tile: " + (xs.Max(x => Mathf.Abs(x)) * 2000f).ToString("0") + " mm wide.");
            }
        }

        // Paging the line is a pinch on its panel, never on a tile of the row under it.
        private static void PagerOffRow(TaskPresentationValidation.Fixture f, string when)
        {
            var pager = f.Strip.GetComponent<BoxCollider>().bounds;
            var bar = f.Console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Control bar");
            foreach (var control in bar.GetComponentsInChildren<SpatialAction>().Where(control => control.gameObject.activeInHierarchy))
                Require(!pager.Intersects(control.GetComponent<BoxCollider>().bounds), when + ": the line's paging target overlaps " + control.Action + ".");
        }

        // Icon and label centered as one group on the control.
        private static void Centered(SpatialAction control, string what)
        {
            var verb = Verb(control); verb.ForceMeshUpdate(true, true);
            var xs = verb.textInfo.characterInfo.Take(verb.textInfo.characterCount).Where(glyph => glyph.isVisible)
                .SelectMany(glyph => new[] { glyph.bottomLeft, glyph.topRight }).Select(point => control.transform.InverseTransformPoint(verb.transform.TransformPoint(point)).x)
                .Concat(Strokes(control).Select(point => point.x)).ToArray();
            Require(xs.Length > 0 && Mathf.Abs((xs.Min() + xs.Max()) / 2f) < .002f,
                what + ": icon and label are not centered: " + ((xs.Min() + xs.Max()) / 2f * 1000f).ToString("0.0") + " mm off.");
        }

        // The control's glyph kind, filled: a solid part at least 2.5 mm wide. Null is a label only.
        private static void Glyph(TaskPresentationValidation.Fixture f, ConsoleAction action, string? kind)
        {
            var icon = Control(f, action).GetComponentsInChildren<SpatialActionIcon>(true).SingleOrDefault();
            var lines = icon == null ? Array.Empty<LineRenderer>() : icon.GetComponentsInChildren<LineRenderer>(true).Where(line => line.enabled).ToArray();
            if (kind == null) { Require(lines.Length == 0, action + " draws a glyph; it is a label only."); return; }
            Require(icon != null && icon.Kind == kind && lines.Any(line => line.widthMultiplier >= .0025f),
                action + " does not carry the filled " + kind + " glyph: " + (icon?.Kind ?? "none") + ".");
            if (kind == "more") Require(lines.Count(line => line.widthMultiplier >= .0025f) == 3, "More does not show three solid dots.");
            if (kind == "pause") Require(lines.Count(line => line.widthMultiplier >= .0025f) == 2, "Pause does not show two solid bars.");
        }

        // The speaker label sits with its line: its letters end 1 to 8 mm above the line's first letters.
        private static void SpeakerWithLine(TaskPresentationValidation.Fixture f, string when)
        {
            var texts = f.Strip.GetComponentsInChildren<TextMeshPro>(true);
            var speaker = texts.Single(text => text.name == "Actual speaker and state");
            var caption = texts.Single(text => text.name == "Actual response");
            speaker.ForceMeshUpdate(true, true); caption.ForceMeshUpdate(true, true);
            var labelBottom = speaker.transform.parent.InverseTransformPoint(speaker.transform.TransformPoint(speaker.textBounds.min)).y;
            var lineTop = caption.transform.parent.InverseTransformPoint(caption.transform.TransformPoint(caption.textBounds.max)).y;
            var gap = labelBottom - lineTop;
            Require(gap >= .001f && gap <= .008f, when + ": the speaker label sits " + (gap * 1000f).ToString("0") + " mm above its line, not with it.");
        }

        // The panel sits one gap above the shelf whatever its line holds: it grows upward, and the shelf stays put.
        // A dialog with no line passes its own backing plate.
        internal static void GapAboveShelf(TaskPresentationValidation.Fixture f, string when, Transform? plate = null)
        {
            var bar = f.Console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Control bar");
            var shelfTop = bar.GetComponentsInChildren<SpatialAction>().Where(control => control.gameObject.activeInHierarchy).Max(control => Box(f, control).max.y);
            float panelBottom;
            // A plate is a unit mesh under its transform: its lower edge is local y -0.5.
            if (plate != null) panelBottom = f.Console.transform.InverseTransformPoint(plate.TransformPoint(new Vector3(0f, -.5f, 0f))).y;
            else
            {
                var backing = f.Strip.GetComponentsInChildren<MeshRenderer>(true).Single(renderer => renderer.name == "Speech contrast backing");
                Require(backing.enabled && backing.gameObject.activeInHierarchy, when + ": the line has no panel.");
                // The plate is a unit mesh under its transform: its lower edge is local y -0.5.
                panelBottom = f.Console.transform.InverseTransformPoint(backing.transform.TransformPoint(new Vector3(0f, -.5f, 0f))).y;
            }
            var gap = panelBottom - shelfTop;
            var header = f.Console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Intent instrument");
            Require(Mathf.Abs(gap - SpatialTheme.Gap) < .002f, when + ": the panel sits " + (gap * 1000f).ToString("0") + " mm above the shelf, not 14 (header "
                + header.Size.y.ToString("0.000") + " at " + header.transform.localPosition.y.ToString("0.000")
                + ", line at " + f.Strip.transform.localPosition.y.ToString("0.000") + ", backing " + ((Transform)Get(f.Strip, "captionBacking")!).localPosition.y.ToString("0.000")
                + " by " + ((Transform)Get(f.Strip, "captionBacking")!).localScale.y.ToString("0.000") + ", shelf top " + shelfTop.ToString("0.000") + ", panel bottom " + panelBottom.ToString("0.000") + ").");
        }

        // True when x lies right of the orb's body, so nothing drawn there sits under it.
        private static bool OutsideOrb(TaskPresentationValidation.Fixture f, float x)
        {
            var companion = (CompanionOrb)Get(f.Console, "companion")!;
            var body = companion.GetComponentsInChildren<MeshRenderer>(true).Single(renderer => renderer.name == "Porcelain body").bounds;
            return x >= f.Console.transform.InverseTransformPoint(body.max).x - .001f;
        }

        private static void OrbLeftOfColumn(TaskPresentationValidation.Fixture f, string when)
        {
            var companion = (CompanionOrb)Get(f.Console, "companion")!;
            var body = companion.GetComponentsInChildren<MeshRenderer>(true).Single(renderer => renderer.name == "Porcelain body").bounds;
            var right = f.Console.transform.InverseTransformPoint(body.max).x;
            Require(right <= Column + .001f, when + ": the orb reaches into the text column: right edge " + right.ToString("0.000") + ".");
        }

        // The control's target in the panel's frame.
        private static Bounds Box(TaskPresentationValidation.Fixture f, SpatialAction control)
        {
            var hit = control.GetComponent<BoxCollider>();
            var corners = new[] { new Vector3(-.5f, -.5f, 0f), new Vector3(.5f, .5f, 0f) }
                .Select(corner => f.Console.transform.InverseTransformPoint(control.transform.TransformPoint(hit.center + Vector3.Scale(corner, hit.size)))).ToArray();
            var bounds = new Bounds(corners[0], Vector3.zero); bounds.Encapsulate(corners[1]);
            return bounds;
        }

        private static IEnumerable<Vector3> Strokes(SpatialAction control) =>
            control.GetComponentsInChildren<SpatialActionIcon>(true).SelectMany(icon => icon.GetComponentsInChildren<LineRenderer>(true)).Where(line => line.enabled)
                .SelectMany(line =>
                {
                    var points = new Vector3[line.positionCount]; line.GetPositions(points);
                    var half = line.widthMultiplier / 2f;
                    return points.SelectMany(point => new[] { point + Vector3.left * half, point + Vector3.right * half })
                        .Select(point => control.transform.InverseTransformPoint(line.transform.TransformPoint(point)));
                });

        private static TextMeshPro Verb(SpatialAction control) => control.GetComponentsInChildren<TextMeshPro>(true).Single(text => text.name == "Verb");
        private static SpatialAction Control(TaskPresentationValidation.Fixture f, ConsoleAction action) =>
            f.Root.GetComponentsInChildren<SpatialAction>(true).Single(control => control.Action == action && control.GetComponentInParent<DialogueStrip>(true) == null);

        internal static void Settle(TaskPresentationValidation.Fixture f)
        {
            TaskPresentationValidation.Settle(f);
            for (var frame = 0; frame < 12; frame++) { f.Console.RefreshVisuals(1f / 12f); f.Strip.RefreshVisuals(1f / 12f); }
        }

        // WCAG contrast of two colors, each as drawn (alpha ignored).
        private static float Contrast(Color a, Color b)
        {
            static float Luminance(Color c)
            {
                static float Channel(float v) => v <= .03928f ? v / 12.92f : Mathf.Pow((v + .055f) / 1.055f, 2.4f);
                return .2126f * Channel(c.r) + .7152f * Channel(c.g) + .0722f * Channel(c.b);
            }
            var (high, low) = (Mathf.Max(Luminance(a), Luminance(b)), Mathf.Min(Luminance(a), Luminance(b)));
            return (high + .05f) / (low + .05f);
        }
        private static bool Near(Color a, Color b) => Mathf.Abs(a.r - b.r) < .02f && Mathf.Abs(a.g - b.g) < .02f && Mathf.Abs(a.b - b.b) < .02f;

        internal static Camera Camera(TaskPresentationValidation.Fixture f)
        {
            var camera = f.Eyes.gameObject.AddComponent<Camera>();
            camera.fieldOfView = 40f; camera.nearClipPlane = .05f; camera.farClipPlane = 10f;
            camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = new Color(.20f, .21f, .22f);
            camera.allowHDR = false; camera.allowMSAA = false;
            return camera;
        }

        // Head-on: the eyes turned to the console and its line, as a person looks at them, in one 28 degree view for every
        // state. These are pictures of the console: the room's outline and chip are off for the capture only, so nothing
        // is cut at the frame's edge.
        internal static Color32[] Shot(TaskPresentationValidation.Fixture f, Camera camera, string path)
        {
            var target = new RenderTexture(Width, Height, 24); var pixels = new Texture2D(Width, Height, TextureFormat.RGB24, false);
            var previous = RenderTexture.active; var rotation = f.Eyes.rotation;
            var room = f.Scene.GetComponentsInChildren<Renderer>().Where(part => part.enabled).ToArray();
            try
            {
                foreach (var part in room) part.enabled = false;
                var parts = f.Console.GetComponentsInChildren<Renderer>().Concat(f.Strip.GetComponentsInChildren<Renderer>()).Where(part => part.enabled).ToArray();
                var bounds = parts[0].bounds; foreach (var part in parts) bounds.Encapsulate(part.bounds);
                f.Eyes.rotation = Quaternion.LookRotation(bounds.center - f.Eyes.position, Vector3.up);
                camera.fieldOfView = 28f;
                camera.targetTexture = target; camera.Render();
                RenderTexture.active = target; pixels.ReadPixels(new Rect(0, 0, Width, Height), 0, 0); pixels.Apply();
                File.WriteAllBytes(path, pixels.EncodeToPNG());
                return pixels.GetPixels32();
            }
            finally
            {
                foreach (var part in room) part.enabled = true;
                f.Eyes.rotation = rotation; camera.targetTexture = null; RenderTexture.active = previous;
                UnityEngine.Object.DestroyImmediate(pixels); UnityEngine.Object.DestroyImmediate(target);
            }
        }

        // The owner picture: at rest with the new shelf, then the recovery dialog, top to bottom.
        private static void Stack(List<Color32[]> frames, string path)
        {
            if (frames.Count != 2) throw new InvalidOperationException("The owner picture needs two frames, found " + frames.Count + ".");
            var sheet = new Texture2D(Width, Height * 2, TextureFormat.RGB24, false);
            try
            {
                for (var i = 0; i < 2; i++) sheet.SetPixels32(0, Height * (1 - i), Width, Height, frames[i]);
                sheet.Apply(); File.WriteAllBytes(path, sheet.EncodeToPNG());
            }
            finally { UnityEngine.Object.DestroyImmediate(sheet); }
        }

        private static object? Invoke(object target, string name, params object[] args) => target.GetType().GetMethod(name, Flags)!.Invoke(target, args);
        private static void Set(object target, string name, object? value) => target.GetType().GetField(name, Flags)!.SetValue(target, value);
        private static object? Get(object target, string name) => target.GetType().GetField(name, Flags)!.GetValue(target);
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
