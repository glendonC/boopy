#nullable enable
using System;
using System.Linq;
using Boopy.Client;
using TMPro;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    public static class ConversationActionsValidation
    {
        public static void Validate()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var root = new GameObject("Synthetic conversation actions");
            try
            {
                var eyes = new GameObject("Synthetic eyes").transform; eyes.SetParent(root.transform, false);
                var console = ContextConsole.Create(root.transform, eyes); console.Place(new Vector3(0, 0, 1));
                var dialogue = DialogueStrip.Create(root.transform, eyes); console.DockDialogue(dialogue);
                var view = new SessionView { Id = "synthetic-conversation", State = "review", ReferentId = "synthetic-source", Model = new ModelRef { Provider = "fixture", Id = "synthetic" } };
                view.Items.Add(new Item { Id = "synthetic-source", Kind = "object", Label = "Synthetic source", Statement = "Synthetic proposed meaning.", Note = "Exact synthetic personal words. 그때 추웠어요.", Status = "proposed", Confidence = .3f, Grounding = new Grounding { Kind = "scene" } });
                view.Utterances.Add(new UtteranceRef { Id = "synthetic-turn", Text = "What is this?", Kind = "ask" });
                view.Observations.Add(new ObservationRef { Id = "synthetic-view" });
                view.Dialogue = new DialogueView { UtteranceId = "synthetic-turn", Text = "It may be a synthetic source." };
                view.Dialogue.Actions.Add(new ContextualAction { Id = "question-one", Question = "Which part of this object do you mean?", TargetItemId = "synthetic-source", ObservationId = "synthetic-view" });
                view.Dialogue.Actions.Add(new ContextualAction { Id = "question-two", Question = "What detail on this object would help identify the unfamiliar material and distinguish it from other visible examples?", ObservationId = "synthetic-view" });
                view.Dialogue.Actions.Add(new ContextualAction { Id = "question-three", Question = "An extra question" });
                console.Render(view); dialogue.Show(DialogueStage.Response, view.Dialogue.Text);
                var exactReply = dialogue.FullText;
                Only(console, ConsoleAction.FollowUpOne, ConsoleAction.FollowUpTwo, ConsoleAction.Options);
                var bar = console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Control bar");
                var anchor = bar.transform.position;
                Require(console.SuggestedAction(ConsoleAction.FollowUpOne)?.Id == "question-one", "Generated question lost its source identity.");
                foreach (var action in new[] { ConsoleAction.FollowUpOne, ConsoleAction.FollowUpTwo }) { Fits(console, action); Hit(console, eyes, action); }
                var firstBox = Control(console, ConsoleAction.FollowUpOne).GetComponent<BoxCollider>();
                var secondBox = Control(console, ConsoleAction.FollowUpTwo).GetComponent<BoxCollider>();
                Require(firstBox.transform.localPosition.y - firstBox.size.y / 2f > secondBox.transform.localPosition.y + secondBox.size.y / 2f, "Wrapped question hit targets overlap.");
                console.SuppressSuggestions(); console.Render(view);
                Only(console, ConsoleAction.Options);
                Require(view.Dialogue.Actions.Count == 3 && view.Items[0].Status == "proposed", "Suppression mutated service state or context.");
                console.Activate(ConsoleAction.Options); console.Activate(ConsoleAction.Review);
                Require(console.ReaderOpen && console.SelectedItemId == "synthetic-source", "Suppression removed source inspection.");
                console.Activate(ConsoleAction.Review);
                view.Dialogue.At = "1970-01-01T12:00:02Z";
                console.Render(view); Only(console, ConsoleAction.FollowUpOne, ConsoleAction.FollowUpTwo, ConsoleAction.Options);
                Require(console.SuggestedAction(ConsoleAction.FollowUpOne)?.Id == "question-one", "New accepted response retained old suggestion suppression.");
                view.Dialogue.UtteranceId = "stale-turn";
                Require(console.SuggestedAction(ConsoleAction.FollowUpOne) == null, "Stale displayed suggestion remains actionable.");
                console.Render(view); Only(console, ConsoleAction.Options);
                view.Dialogue.UtteranceId = "synthetic-turn";
                view.Dialogue.Actions[0].ObservationId = "missing-view";
                view.Dialogue.Actions[1].TargetItemId = "missing-item";
                view.Dialogue.Actions[2].Question = new string('x', 121);
                console.Render(view); Only(console, ConsoleAction.Options);
                view.Dialogue.Actions[0].ObservationId = "synthetic-view";
                view.Dialogue.Actions[1].TargetItemId = null;
                console.Render(view);
                console.Activate(ConsoleAction.Options);
                Require(bar.transform.position == anchor && dialogue.FullText == exactReply, "Opening context tools moved the app bar or rewrote the answer.");
                AssertFootprint(console);
                Require(!Control(console, ConsoleAction.Actions).gameObject.activeInHierarchy && !Control(console, ConsoleAction.Save).gameObject.activeInHierarchy, "Context tools restore foreground save/actions workflow.");
                Require(Label(console, ConsoleAction.Review) == "Conversation" && Label(console, ConsoleAction.PrepareSave) == "Prepare context", "Context tools lack their actual purpose.");
                Hit(console, eyes, ConsoleAction.Review); console.Activate(ConsoleAction.Review);
                Require(console.ReaderOpen && console.SelectedItemId == "synthetic-source", "Deliberate context reading lost selected evidence.");
                console.Activate(ConsoleAction.ToggleDetails);
                var exactAccountVisible = false;
                for (var page = 0; page < 20; page++)
                {
                    exactAccountVisible |= console.GetComponentsInChildren<SpatialSurface>(true).Any(surface => surface.BodyText.Contains("Exact synthetic personal words."));
                    console.Activate(ConsoleAction.NextText);
                }
                Require(exactAccountVisible, "Source pagination dropped exact personal account.");
                console.Activate(ConsoleAction.Review); Only(console, ConsoleAction.FollowUpOne, ConsoleAction.FollowUpTwo, ConsoleAction.Options);
                console.Activate(ConsoleAction.Options); console.Activate(ConsoleAction.PrepareSave);
                Require(console.SavePreviewOpen && view.Committed == null && view.Items[0].Status == "proposed", "Preparation silently committed or confirmed context.");
                Only(console, ConsoleAction.Back, ConsoleAction.Save);
                Require(Label(console, ConsoleAction.Save) == "Use this context", "Preparation confirmation hides its purpose.");
                console.Activate(ConsoleAction.Back); Only(console, ConsoleAction.FollowUpOne, ConsoleAction.FollowUpTwo, ConsoleAction.Options);
                console.Activate(ConsoleAction.Settings); console.Activate(ConsoleAction.Size); Hit(console, eyes, ConsoleAction.Settings); console.Activate(ConsoleAction.Settings);
                foreach (var action in new[] { ConsoleAction.FollowUpOne, ConsoleAction.FollowUpTwo }) Fits(console, action);
                console.ShowProcessing(); Only(console, ConsoleAction.Cancel);
                Require(console.SuggestedAction(ConsoleAction.FollowUpOne) == null, "Busy state retained a suggested action.");
                console.Render(view); console.SetCaptureRecovery(true); Only(console, ConsoleAction.CheckCapture, ConsoleAction.DismissCapture);
                console.SetCaptureRecovery(false);
                view.Dialogue.Actions.Clear(); console.Render(view); Only(console, ConsoleAction.Options);
                view.Dialogue.Actions.Add(new ContextualAction { Id = "duplicate", Question = "A duplicated question?" });
                view.Dialogue.Actions.Add(new ContextualAction { Id = "duplicate", Question = "A duplicated question?" });
                console.Render(view); Only(console, ConsoleAction.Options);
                view.Dialogue.Actions.Clear();
                view.Utterances.Add(new UtteranceRef { Id = "synthetic-clarify", Text = "Synthetic ambiguous request" });
                view.Attention = new AttentionView { UtteranceId = "synthetic-clarify", Action = "clarify", Source = "unknown" };
                console.Render(view); Only(console, ConsoleAction.UseCurrentView, ConsoleAction.UseSpokenOnly);
                Require(dialogue.FullText == exactReply && view.Committed == null, "Context tools mutated reply or receipt.");
                console.Render(new SessionView { Id = "synthetic-prepared-session", State = "committed", Committed = new Committed { PackageId = "ctx_synthetic_prepared" } });
                console.Activate(ConsoleAction.Options); console.Activate(ConsoleAction.Settings);
                Require(console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Comfort options").gameObject.activeInHierarchy, "Prepared-context fixture did not open tools.");
                var spoken = new SessionView { Id = "synthetic-new-spoken-session", State = "review" };
                spoken.Items.Add(new Item { Id = "synthetic-spoken-account", Origin = "person", Status = "confirmed", Label = "Synthetic personal context", Statement = "Exact synthetic words.", Kind = "utterance", Grounding = new Grounding { Kind = "scene" } });
                spoken.Utterances.Add(new UtteranceRef { Id = "synthetic-spoken-turn", Text = "Exact synthetic words.", Kind = "ask" });
                console.Render(spoken);
                Only(console, ConsoleAction.Options);
                Require(!console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Comfort options").gameObject.activeInHierarchy, "New conversation inherited prior context tools.");
                console.Activate(ConsoleAction.Options);
                Require(Control(console, ConsoleAction.Review).gameObject.activeInHierarchy && !Control(console, ConsoleAction.Size).gameObject.activeInHierarchy, "New conversation inherited prior settings subpanel.");
                Debug.Log("Boopy adaptive conversation actions validation passed (synthetic grounded questions; optional evidence and explicit context preparation).");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }
        private static SpatialAction Control(ContextConsole console,ConsoleAction action)=>console.GetComponentsInChildren<SpatialAction>(true).Single(control=>control.Action==action);
        private static void AssertFootprint(ContextConsole console)
        {
            var center = console.transform.position + console.transform.up * console.LayoutCenterOffset;
            foreach (var surface in console.GetComponentsInChildren<SpatialSurface>(true).Where(surface => surface.gameObject.activeInHierarchy))
                foreach (var x in new[] { -1f, 1f }) foreach (var y in new[] { -1f, 1f })
                {
                    var world = surface.transform.TransformPoint(new Vector3(surface.Size.x * .5f * x, surface.Size.y * .5f * y, 0));
                    var at = Quaternion.Inverse(console.transform.rotation) * (world - center);
                    Require(Mathf.Abs(at.x) <= console.LayoutSize.x * .5f + .0001f && Mathf.Abs(at.y) <= console.LayoutSize.y * .5f + .0001f, "Current app bar and content exceed their actual reserved footprint.");
                }
        }
        private static void Fits(ContextConsole console, ConsoleAction action)
        {
            var control = Control(console, action);
            var text = control.GetComponentsInChildren<TextMeshPro>(true).Single(label => label.name == "Verb");
            text.ForceMeshUpdate(true, true);
            Require(!text.isTextOverflowing && text.fontSize == SpatialTheme.Body, "Question clips or shrinks its readable font.");
            var box = control.GetComponent<BoxCollider>();
            Require(box.size.y >= SpatialTheme.Target, "Question target shrank.");
            foreach (var character in text.textInfo.characterInfo.Where(character => character.isVisible))
            {
                var left = control.transform.InverseTransformPoint(text.transform.TransformPoint(character.bottomLeft));
                var right = control.transform.InverseTransformPoint(text.transform.TransformPoint(character.topRight));
                Require(left.x >= -box.size.x / 2f && right.x <= box.size.x / 2f && left.y >= -box.size.y / 2f && right.y <= box.size.y / 2f, "Question glyph extends outside its measured target.");
            }
        }
        private static string Label(ContextConsole console, ConsoleAction action) => console.GetComponentsInChildren<SpatialAction>(true).Single(control => control.Action == action).AccessibleLabel;
        private static void Hit(ContextConsole console, Transform eyes, ConsoleAction action)
        {
            console.RefreshVisuals(1f); Physics.SyncTransforms();
            var control = console.GetComponentsInChildren<SpatialAction>(true).Single(item => item.Action == action);
            var ray = new Ray(eyes.position, control.transform.position - eyes.position);
            Require(console.HitAction(ray, out _) == action && console.CanRelease(action, ray), "Contextual action hit area overlaps/disappears.");
        }
        private static void Only(ContextConsole console, params ConsoleAction[] expected)
        {
            var global = new[] { ConsoleAction.PauseScene, ConsoleAction.Settings, ConsoleAction.Options, ConsoleAction.Cancel, ConsoleAction.Talk, ConsoleAction.FinishTalk };
            expected = expected.Where(action => !global.Contains(action)).ToArray();
            var actual = console.GetComponentsInChildren<SpatialAction>(true).Where(control => control.gameObject.activeInHierarchy && !global.Contains(control.Action)).Select(control => control.Action).ToArray();
            Require(actual.Length == expected.Length && expected.All(actual.Contains), "Unexpected automatic action cluster.");
        }
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
