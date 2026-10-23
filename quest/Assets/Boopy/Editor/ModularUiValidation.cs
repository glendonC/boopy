#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Boopy.Client;
using TMPro;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>Production-component checks using only synthetic evidence; no device or service required.</summary>
    public static class ModularUiValidation
    {
        public static void Validate()
        {
            HangulFont.Install();
            var root = new GameObject("Synthetic modular UI validation");
            try
            {
                var eyes = new GameObject("Synthetic eyes").transform;
                eyes.SetParent(root.transform, false);
                var console = ContextConsole.Create(root.transform, eyes);
                console.SetReducedMotion(true);
                console.Place(new Vector3(0.3f, 0f, 1f));
                Ready(console);
                HeaderInstruction(console, "Connecting to your Mac…", "Boopy");
                Companion(console);
                Geometry(console);
                console.Activate(ConsoleAction.Settings); Ready(console);
                Require(Active(console, ConsoleAction.Speech) && Controls(console).Single(control=>control.Action==ConsoleAction.Speech).AccessibleLabel=="Voice unavailable", "Settings conceal unavailable voice before any session.");
                console.Activate(ConsoleAction.Settings); Ready(console);
                var view = SyntheticSession();
                var selected = view.Items[1];
                console.Render(view);
                Ready(console);
                HeaderInstruction(console, "Talk to continue.");
                Actions(console, ConsoleAction.Options);
                Require(!console.ReaderOpen && !console.GetComponentsInChildren<SpatialSurface>(true)
                    .Single(surface => surface.name == "Evidence instrument").gameObject.activeInHierarchy,
                    "A returned scene opened the evidence sheet without an explicit action.");
                console.Inspect(view.Items[2]);
                Require(!console.ReaderOpen, "Looking at an object opened a sheet automatically.");
                console.Inspect(selected);
                console.Activate(ConsoleAction.Options);
                console.Activate(ConsoleAction.Review);
                Ready(console);
                Actions(console, ConsoleAction.NextItem, ConsoleAction.ToggleDetails,
                    ConsoleAction.ToggleIncluded, ConsoleAction.Review);
                Geometry(console);
                var fixedTargets = Positions(console);
                console.Inspect(selected);
                console.Render(view);
                Ready(console);
                Stable(console, fixedTargets);
                var bodyHit = console.GetComponentsInChildren<SpatialSurface>(true)
                    .Single(surface => surface.name == "Evidence instrument").GetComponent<BoxCollider>();
                Require(console.HitTarget(RayTo(console, bodyHit.bounds.center), out _) == selected.Id,
                    "Selected evidence has no correction target.");

                console.Activate(ConsoleAction.ToggleDetails);
                Ready(console);
                Actions(console, ConsoleAction.ToggleDetails, ConsoleAction.NextText,
                    ConsoleAction.Confirm, ConsoleAction.Review);
                Geometry(console);
                var firstPage = Reader(console);
                console.Inspect(view.Items[2]);
                console.Render(view);
                Ready(console);
                Require(console.SelectedItemId == selected.Id && Reader(console) == firstPage,
                    "Hover or refresh changed the open reader's selection/page.");
                var exact = new StringBuilder();
                var pages = 0;
                do
                {
                    Ready(console);
                    Geometry(console);
                    exact.Append(Reader(console));
                    Require(++pages <= 256, "Synthetic reader navigation did not reach its bounded end.");
                    if (!Active(console, ConsoleAction.NextText)) break;
                    console.Activate(ConsoleAction.NextText);
                } while (true);
                Require(pages > 1, "Long synthetic evidence did not exercise text paging.");
                Require(exact.ToString() == ExpectedSources(view, selected),
                    "Measured reader pages lost or rewrote source text.");
                Actions(console, ConsoleAction.ToggleDetails, ConsoleAction.PreviousText,
                    ConsoleAction.Confirm, ConsoleAction.Review);
                var lastPage = Reader(console);
                console.Activate(ConsoleAction.NextText);
                Require(Reader(console) == lastPage, "Text paging wrapped at the last page.");
                console.Activate(ConsoleAction.ToggleDetails);
                console.Activate(ConsoleAction.NextItem);
                console.Activate(ConsoleAction.NextItem);
                Ready(console);
                Require(console.SelectedItemId == "question", "Item navigation skipped evidence.");
                Actions(console, ConsoleAction.PreviousItem, ConsoleAction.ToggleDetails, ConsoleAction.ToggleIncluded,
                    ConsoleAction.Review);
                console.Activate(ConsoleAction.NextItem);
                Require(console.SelectedItemId == "question", "Item navigation wrapped at the end.");

                console.Activate(ConsoleAction.Review);
                console.Activate(ConsoleAction.Options);
                console.Activate(ConsoleAction.Settings);
                console.Activate(ConsoleAction.Size);
                Ready(console);
                Require(Mathf.Abs(console.ComfortScale - 1.2f) < 0.0001f, "Large option did not apply one uniform scale.");
                Geometry(console);
                console.SetBusy(true);
                Ready(console);
                foreach (var action in Controls(console).Where(action => action.gameObject.activeInHierarchy))
                    Require(console.HitAction(RayTo(console, action.transform.position), out _) == (action.Action == ConsoleAction.PauseScene ? ConsoleAction.PauseScene : ConsoleAction.None),
                        "Busy controls accept unrelated input or disable the scene pause control.");
                console.SetBusy(false);
                console.ShowError("Synthetic connection failure; the existing review is still available.");
                Ready(console);
                Require(Active(console, ConsoleAction.More), "A recoverable error discarded deliberate actions for existing context.");
                console.Activate(ConsoleAction.Options);
                Ready(console);
                Require(Active(console, ConsoleAction.PrepareSave), "Explicit actions lost Save after recoverable error.");

                var save = Controls(console).Single(action => action.Action == ConsoleAction.PrepareSave);
                Require(console.HitAction(RayTo(console, save.transform.position), out _) == ConsoleAction.PrepareSave,
                    "Save after a recoverable error is not hittable.");
                console.Render(view);
                Ready(console);
                Require(Active(console, ConsoleAction.PrepareSave), "Returning from an error did not restore review actions.");
                var beforePreview = Wire.Write(view);
                console.Activate(ConsoleAction.PrepareSave);
                Ready(console);
                Require(console.SavePreviewOpen, "Save has no content/destination preview.");
                Actions(console, ConsoleAction.Back, ConsoleAction.Save);
                var finalSave = Controls(console).Single(action => action.Action == ConsoleAction.Save);
                var back = Controls(console).Single(action => action.Action == ConsoleAction.Back);
                Require(console.CanRelease(ConsoleAction.Save, RayTo(console, finalSave.transform.position)),
                    "An unchanged save press cannot release on its original target.");
                Require(!console.CanRelease(ConsoleAction.Save, RayTo(console, back.transform.position))
                    && !console.CanRelease(ConsoleAction.Save, RayTo(console, console.transform.position + Vector3.up * 2f)),
                    "Withdrawing a save press can still commit or switch to another action.");
                Geometry(console);
                Require(Reader(console).Contains("Nothing is sent."), "Save preview implies a phone delivery.");
                Require(Wire.Write(view) == beforePreview, "Opening save preview committed or mutated context.");
                console.ShowError("Could not confirm the save. The outcome is still unknown.");
                Require(console.SavePreviewOpen, "Uncertain save hid its retry preview.");
                Actions(console, ConsoleAction.Back, ConsoleAction.Save);
                Require(view.Committed == null, "Uncertain save fabricated a receipt.");
                console.Activate(ConsoleAction.Back);
                Require(!console.SavePreviewOpen, "Back did not dismiss save preview.");
                Require(!console.ReaderOpen, "Review could not collapse back to the scene.");
                console.ShowListening();
                Actions(console);
                Require(!Active(console,ConsoleAction.Talk), "Listening exposes a competing Talk target.");
                HeaderInstruction(console, "Listening…\nLet go when you’re done.");
                Companion(console);
                console.ShowProcessing();
                console.SetBusy(true);
                Actions(console, ConsoleAction.Cancel);
                Require(!Active(console,ConsoleAction.Talk), "Processing exposes a competing Talk target.");
                HeaderInstruction(console, "Sending…");
                Companion(console);
                Geometry(console);
                var cancel = Controls(console).Single(action => action.Action == ConsoleAction.Cancel);
                Require(!cancel.IconOnly && cancel.AccessibleLabel == "Stop", "Stopping the wait must have a visible action label.");
                Require(cancel.GetComponent<BoxCollider>().size.x >= .060f, "Cancel target is too small.");
                var beforeStop = Wire.Write(view);
                console.Activate(ConsoleAction.Cancel);
                Require(Wire.Write(view) == beforeStop && view.Committed == null,
                    "The local Cancel action mutated or saved context.");
                view.State = "committed";
                view.Committed = new Committed { PackageId = "ctx_synthetic_modular_validation",
                    Summary = "1 confirmed, 1 accepted, 1 question" };
                console.Render(view);
                Ready(console);
                Actions(console, ConsoleAction.Options);
                console.Activate(ConsoleAction.Options);
                Require(Active(console, ConsoleAction.Handoff), "Saved context has no deliberate manual handoff option.");
                console.Activate(ConsoleAction.Handoff);
                Actions(console, ConsoleAction.Back);
                Geometry(console);
                console.Activate(ConsoleAction.Back);
                Require(!console.HitSave(RayTo(console, console.transform.position), out _),
                    "Saved receipt still offers another commit.");
                Geometry(console);
                console.Render(view = SyntheticSession());
                console.Activate(ConsoleAction.PrepareSave);
                console.Render(new SessionView { Id = view.Id });
                Require(!console.SavePreviewOpen && !Active(console, ConsoleAction.Save),
                    "A same-session failed interpretation retained a stale commit action.");
                console.Render(new SessionView { Id = "synthetic-no-proposal" });
                console.ShowError("Synthetic interpretation unavailable.");
                Actions(console, ConsoleAction.Options);
                Debug.Log("Boopy: modular UI validation passed (synthetic navigation, source text, bounds and input).");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }

        private static SessionView SyntheticSession()
        {
            var view = new SessionView { Id = "synthetic-modular-validation", IntentId = "goal", ReferentId = "notes",
                Model = new ModelRef { Provider = "fixture", Id = "synthetic-model", LatencyMs = 1200f } };
            view.Utterances.Add(new UtteranceRef { Id = "synthetic-utterance", Kind = "ask", Text = "Help me review these synthetic notes in Korean." });
            view.Items.Add(new Item { Id = "goal", Kind = "goal", Label = "Practice describing the synthetic journey in Korean",
                Statement = "Prepare vocabulary from this context; place and dates remain unknown." });
            view.Items.Add(new Item { Id = "notes", Kind = "text", Confidence = 0.4f,
                Label = "A deliberately long synthetic label / 여행 메모와 한국어 표현을 검토하기 위한 예시",
                Statement = "Synthetic notes provide expressions to review. The source is shown exactly when Details is opened.",
                Text = new List<string> { string.Concat(Enumerable.Repeat("  사막 메모: 한글 👩🏽‍🚀\r\n풍경을 한국어로 설명해요.\n", 32)), "마지막 문장  " },
                Why = "This is a synthetic model explanation, still proposed.",
                Note = "Synthetic person note; preserve the original source.",
                Grounding = new Grounding { Kind = "box", ObservationId = "synthetic-frame",
                    Box = new Box2 { X0 = 0.1f, Y0 = 0.2f, X1 = 0.3f, Y1 = 0.4f } } });
            view.Items.Add(new Item { Id = "other", Kind = "topic", Label = "Another topic", Statement = "A short scene-level idea." });
            view.Items.Add(new Item { Id = "question", Kind = "question", Label = "Where was this?", Statement = "The place is unknown." });
            return view;
        }

        private static string ExpectedSources(SessionView view, Item item) => "Detail: " + item.Label + "\n"
            + ChipStyles.For(item, false).Tag + " / Approximate box\n" + ContextReview.Evidence(item)
            + "\nInitial session request: " + view.Utterances[0].Text
            + "\nGoal interpretation: " + view.Items[0].Label + "\n" + view.Items[0].Statement
            + $"\nSession model: {view.Model!.Provider} / {view.Model.Id}, {view.Model.LatencyMs / 1000f:0.0} s";

        private static string Reader(ContextConsole console) => console.GetComponentsInChildren<SpatialSurface>(true)
            .Single(surface => surface.name == "Evidence instrument").BodyText;
        private static void HeaderInstruction(ContextConsole console, string expected, string? identity = null)
        {
            Ready(console);
            var header = console.GetComponentsInChildren<SpatialSurface>(true)
                .Single(surface => surface.name == "Intent instrument");
            var visible = header.GetComponentsInChildren<TextMeshPro>(true)
                .Where(text => text.GetComponentInParent<SpatialAction>() == null && text.gameObject.activeInHierarchy && !string.IsNullOrWhiteSpace(text.text)).ToArray();
            Require(visible.Length == (identity == null ? 1 : 2) && visible.Single(text=>text.name=="Body").text == expected
                && (identity == null || visible.Single(text=>text.name=="Title").text==identity),
                "Companion state has the wrong identity or instruction.");
            var instruction = visible.Single(text=>text.name=="Body");
            var glyphs = instruction.textInfo.characterInfo.Take(instruction.textInfo.characterCount)
                .Where(character => character.isVisible).ToArray();
            Require(glyphs.Length > 0, "Companion instruction has no rendered glyphs.");
            var height = glyphs.Max(character => Mathf.Abs(character.topRight.y - character.bottomLeft.y))
                * instruction.transform.lossyScale.y;
            Require(height >= 0.002f && height <= 0.080f,
                "Instruction glyphs fell outside the intended physical text range.");
        }
        private static void Companion(ContextConsole console)
        {
            var orbs = console.GetComponentsInChildren<CompanionOrb>(true);
            Require(orbs.Length == 1 && orbs[0].gameObject.activeInHierarchy,
                "Quiet state is missing its native companion.");
            Require(orbs[0].GetComponentsInChildren<Collider>().Length == 0,
                "Decorative companion intercepts interaction rays.");
            var body = orbs[0].GetComponentInChildren<MeshRenderer>();
            Require(body != null && body.sharedMaterial != null && body.sharedMaterial.shader != null,
                "Companion has no native rendering material.");
        }
        private static SpatialAction[] Controls(ContextConsole console) => console.GetComponentsInChildren<SpatialAction>(true);
        private static bool Active(ContextConsole console, ConsoleAction action) => Controls(console)
            .Any(control => control.Action == action && control.gameObject.activeInHierarchy);
        private static void Ready(ContextConsole console)
        {
            console.RefreshVisuals(1f);
            foreach (var text in console.GetComponentsInChildren<TextMeshPro>(true)) text.ForceMeshUpdate(true, true);
            Physics.SyncTransforms();
        }
        private static Ray RayTo(ContextConsole console, Vector3 point) => new Ray(point - console.transform.forward * 0.3f, console.transform.forward);

        private static void Actions(ContextConsole console, params ConsoleAction[] expected)
        {
            Ready(console);
            var global = new[] { ConsoleAction.Talk, ConsoleAction.FinishTalk, ConsoleAction.PauseScene, ConsoleAction.Settings, ConsoleAction.Options, ConsoleAction.Cancel,
                ConsoleAction.More, ConsoleAction.ShelfBack };
            if (expected.Contains(ConsoleAction.Options))
                Require(Active(console,ConsoleAction.Talk) && Active(console,ConsoleAction.More), "Idle conversation lost its global controls.");
            Require(Active(console,ConsoleAction.PauseScene), "Global scene pause is missing.");
            expected = expected.Where(action => !global.Contains(action)).ToArray();
            var active = Controls(console).Where(control => control.gameObject.activeInHierarchy).ToArray();
            Require(active.Where(control => !global.Contains(control.Action)).Select(control => control.Action).OrderBy(action => action).SequenceEqual(expected.OrderBy(action => action)),
                "Unexpected active modular action set.");
            foreach (var control in active)
                Require(console.HitAction(RayTo(console, control.transform.position), out _) == control.Action,
                    "A visible action does not resolve to its own hit target.");
        }

        private static Dictionary<ConsoleAction, Vector3> Positions(ContextConsole console) => Controls(console)
            .Where(control => control.gameObject.activeInHierarchy).ToDictionary(control => control.Action, control => control.transform.position);
        private static void Stable(ContextConsole console, Dictionary<ConsoleAction, Vector3> previous)
        {
            var current = Positions(console);
            foreach (var pair in previous)
                Require(current.TryGetValue(pair.Key, out var point) && Vector3.Distance(point, pair.Value) < 0.0001f,
                    "Repeated inspection or same-session refresh moved an action target.");
        }

        private static void Geometry(ContextConsole console)
        {
            var active = Controls(console).Where(control => control.gameObject.activeInHierarchy).ToArray();
            var boxes = active.Select(control => Bounds(console.transform, control.GetComponent<BoxCollider>())).ToArray();
            for (var i = 0; i < boxes.Length; i++)
                for (var j = i + 1; j < boxes.Length; j++)
                    Require(!Overlap(boxes[i], boxes[j]), "Visible action rectangles overlap.");
            foreach (var text in console.GetComponentsInChildren<TextMeshPro>(true))
            {
                if (!text.gameObject.activeInHierarchy || string.IsNullOrWhiteSpace(text.text)) continue;
                var ownControl = text.GetComponentInParent<SpatialAction>();
                if (ownControl != null) continue;
                var corners = new Vector3[4]; text.rectTransform.GetWorldCorners(corners);
                var rectangle = Bounds(console.transform, corners);
                foreach (var box in boxes) Require(!Overlap(rectangle, box), "Source text or a counter overlaps an action rectangle.");
            }
            var modules = console.GetComponentsInChildren<SpatialSurface>(true).Where(surface => surface.gameObject.activeInHierarchy).ToArray();
            var reserved = modules.Sum(surface => surface.Size.y) + SpatialTheme.Gap * Mathf.Max(0, modules.Length - 1);
            Require(console.LayoutSize.y >= reserved * console.ComfortScale,
                "Console reservation excludes a visible module.");
        }

        private static Rect Bounds(Transform frame, BoxCollider box)
        {
            var c = box.center; var h = box.size * 0.5f;
            return Bounds(frame, new[] { box.transform.TransformPoint(c + new Vector3(-h.x, -h.y, 0f)),
                box.transform.TransformPoint(c + new Vector3(h.x, -h.y, 0f)),
                box.transform.TransformPoint(c + new Vector3(h.x, h.y, 0f)),
                box.transform.TransformPoint(c + new Vector3(-h.x, h.y, 0f)) });
        }
        private static Rect Bounds(Transform frame, Vector3[] corners)
        {
            var local = corners.Select(frame.InverseTransformPoint).ToArray();
            return Rect.MinMaxRect(local.Min(point => point.x), local.Min(point => point.y), local.Max(point => point.x), local.Max(point => point.y));
        }
        private static bool Overlap(Rect a, Rect b) => a.xMin < b.xMax - 0.0001f && a.xMax > b.xMin + 0.0001f
            && a.yMin < b.yMax - 0.0001f && a.yMax > b.yMin + 0.0001f;
        private static void Require(bool condition, string message)
        { if (!condition) throw new InvalidOperationException("Synthetic modular UI validation: " + message); }
    }
}
