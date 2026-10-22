#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
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
using N = System.Numerics;

namespace Boopy.Quest.Editor
{
    /// <summary>
    /// The production task presentation, driven through BoopyApp with synthetic session and task
    /// views over synthetic HTTP. No camera, microphone, service or private frame. In batch mode
    /// any failure exits non-zero.
    /// </summary>
    public static class TaskPresentationValidation
    {
        private const BindingFlags Flags = BindingFlags.Instance | BindingFlags.NonPublic;
        internal const string SessionId = "synthetic-task-session";
        internal const string SubjectId = "synthetic-stone";
        internal const string ObservationId = "synthetic-observation";
        internal const string TaskId = "tsk_0000000000000000000000000000a001";
        internal const string Line = "It looks like a stone marker.";
        internal const string Annotation = "Stone marker";
        internal const string FirstAnswer = "A stone marker by the trail.";
        internal const string SecondAnswer = "어제 본 돌이에요.";
        private const string Health = "{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}}";
        private static readonly ConsoleAction[] Global = { ConsoleAction.Talk, ConsoleAction.FinishTalk, ConsoleAction.PauseScene,
            ConsoleAction.Options, ConsoleAction.Settings, ConsoleAction.Cancel };

        public static void Run()
        {
            var context = SynchronizationContext.Current;
            try
            {
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                HangulFont.Install();
                // Synthetic transport completes inline; production continuations then run on this thread.
                SynchronizationContext.SetSynchronizationContext(null);
                foreach (var large in new[] { false, true }) Validate(large);
                NotOffered();
                Debug.Log("Boopy task presentation validation passed: one chip on the outlined subject at its session placement, " +
                    "the dialogue line with \"Boopy · Not sent\", one \"Answer aloud\" control under it and no follow-ups, no overlap, " +
                    "answers as \"You · Not sent\", wrong item, retry with the same ids, standard and large text (synthetic).");
            }
            catch (Exception error)
            {
                Debug.LogException(error);
                if (Application.isBatchMode) EditorApplication.Exit(1);
                else throw;
            }
            finally { SynchronizationContext.SetSynchronizationContext(context); }
        }

        private static void Validate(bool large)
        {
            Vector3 sessionHome;
            using (var reference = new Fixture(large))
            {
                // No task-ready turn: today's presentation, no error.
                reference.Transport.Open.Enqueue(() => Reply(HttpStatusCode.Conflict, Refusal("task_unavailable")));
                reference.Start();
                Require(reference.Transport.Count("/v1/sessions/" + SessionId + "/task") == 1, "A task-ready first turn did not ask for its task.");
                Require(Get(reference.App, "task") == null && !reference.Console.TaskShown, "An unavailable task changed the presentation.");
                Require(reference.Strip.Stage == DialogueStage.Response && reference.Strip.FullText == Line && reference.Strip.SpeakerText == "Boopy",
                    "An unavailable task showed an error or changed the session line.");
                Only(reference.Console, ConsoleAction.FollowUpOne, ConsoleAction.FollowUpTwo);
                sessionHome = SingleChip(reference).Home;
            }

            // Boopy's line or the label too long for the task: the task leaves it out, so the
            // session's own presentation stays and nothing it shows vanishes.
            foreach (var parts in new[] { Parts(dialogue: false), Parts(annotation: false) })
                using (var partial = new Fixture(large))
                {
                    partial.Transport.Open.Enqueue(() => Reply(HttpStatusCode.OK, TaskView(components: parts)));
                    partial.Start();
                    Require(partial.Transport.Count(OpenPath) == 1, "The partial task was not asked for.");
                    SessionShown(partial, sessionHome, "A task without its chip or its line");
                }

            // The task arriving while a recording runs leaves the session's own presentation.
            using (var recording = new Fixture(large))
            {
                var talk = (ButtonTalk)Get(recording.App, "buttonTalk")!;
                recording.Transport.Open.Enqueue(() =>
                {
                    talk.Begin(0f); recording.Console.ShowListening(false); recording.Console.SetButtonRecording(true);
                    return Reply(HttpStatusCode.OK, TaskView());
                });
                recording.Start();
                Require(recording.Transport.Count(OpenPath) == 1 && Get(recording.App, "task") == null && !recording.Console.TaskShown,
                    "A task arriving during a recording took over the presentation.");
                Invoke(recording.App, "DiscardRecording"); Invoke(recording.App, "RestoreConsole");
                SessionShown(recording, sessionHome, "A task arriving during a recording");
            }

            using var f = new Fixture(large);
            // A lost reply is asked again with the same ids, which is the same open.
            f.Transport.Open.Enqueue(Drop);
            f.Transport.Open.Enqueue(() => Reply(HttpStatusCode.OK, TaskView()));
            f.Start();
            var opens = f.Transport.Bodies("/v1/sessions/" + SessionId + "/task");
            Require(opens.Count == 2 && opens[0] == opens[1], "The open retry was not the same event.");
            var open = JObject.Parse(opens[0]);
            Require(open.Properties().Select(property => property.Name).SequenceEqual(new[] { "eventId", "taskId" })
                && Regex.IsMatch((string?)open["eventId"] ?? "", "^evt_[0-9a-f]{32}$") && Regex.IsMatch((string?)open["taskId"] ?? "", "^tsk_[0-9a-f]{32}$"),
                "The open request does not carry headset-made ids only.");
            Presented(f, Line, "Boopy · Not sent", true, sessionHome);

            // Focus lost and regained keeps the same task on the same session view.
            Invoke(f.App, "OnFocusLost"); Invoke(f.App, "OnFocusAcquired");
            Presented(f, Line, "Boopy · Not sent", true, sessionHome);

            // A Talk recording cancelled with the bar's Cancel gives back the task's line. No microphone opens.
            var buttonTalk = (ButtonTalk)Get(f.App, "buttonTalk")!;
            buttonTalk.Begin(0f); f.Console.ShowListening(false); f.Console.SetButtonRecording(true);
            f.Strip.Show(DialogueStage.Listening, "Listening… Tap Finish when done.");
            Settle(f);
            var cancel = Control(f.Console, ConsoleAction.Cancel);
            var hand = new HandInput(true, null, null);
            typeof(HandInput).GetProperty("Ray")!.SetValue(hand, new Ray(f.Eyes.position, cancel.transform.position - f.Eyes.position));
            typeof(HandInput).GetProperty("RayActive")!.SetValue(hand, true);
            Set(f.App, "pendingControl", ConsoleAction.Cancel); Set(f.App, "pendingUsesHandRay", true);
            Invoke(f.App, "ReleaseControl", hand);
            Require(!buttonTalk.Recording, "Cancel kept the recording.");
            Presented(f, Line, "Boopy · Not sent", true, sessionHome);

            // Finish with no audio: the answer's own words, nothing sent, the control stays.
            buttonTalk.Begin(0f); Set(f.App, "answeringTask", true); f.Console.ShowListening(false); f.Console.SetButtonRecording(true);
            Invoke(f.App, "FinishRecording");
            Require(!buttonTalk.Recording && f.Transport.Count("/v1/tasks/" + TaskId + "/answers") == 0, "An empty answer was sent.");
            Require(f.Strip.Stage == DialogueStage.Error && f.Strip.FullText == "No speech recorded. Tap Answer aloud to try again.",
                "An empty answer lacks its retry words.");
            Settle(f); Only(f.Console, ConsoleAction.AnswerTask);

            // An answer: the current revision, base64 audio, no frame. A lost reply is the same event again.
            var current = (InteractionPresentation)Get(f.App, "task")!;
            f.Transport.Answers.Enqueue(Drop);
            f.Transport.Answers.Enqueue(() => Reply(HttpStatusCode.OK, TaskView(2, Attempts(FirstAnswer))));
            Answer(f, current);
            var answers = f.Transport.Bodies("/v1/tasks/" + TaskId + "/answers");
            Require(answers.Count == 2 && answers[0] == answers[1], "The answer retry was not the same event.");
            var answer = JObject.Parse(answers[0]);
            Require(answer.Properties().Select(property => property.Name).SequenceEqual(new[] { "eventId", "sessionId", "expectedRevision", "speech" })
                && (int)answer["expectedRevision"]! == 1 && (string?)answer["sessionId"] == SessionId
                && Regex.IsMatch((string?)answer["eventId"] ?? "", "^evt_[0-9a-f]{32}$")
                && ((JObject)answer["speech"]!).Properties().Select(property => property.Name).SequenceEqual(new[] { "wav" })
                && (string?)answer["speech"]!["wav"] == Convert.ToBase64String(SpeechValidation.SyntheticWav()),
                "The answer is not this recording against the current revision, or it carries more than audio.");
            Require(f.Transport.Count("/v1/sessions") == 1, "An answer sent the frame or the capture again.");
            Presented(f, FirstAnswer, "You · Not sent", true, sessionHome);

            // The Mac heard no words: the retry line, the same task, the control stays.
            f.Transport.Answers.Enqueue(() => Reply((HttpStatusCode)422, Refusal("no_words")));
            Answer(f, (InteractionPresentation)Get(f.App, "task")!);
            Require(f.Strip.Stage == DialogueStage.Error && f.Strip.FullText == "No speech recorded. Tap Answer aloud to try again.",
                "No words lacks its retry line.");
            Require(((InteractionPresentation)Get(f.App, "task")!).Revision == 2, "No words changed the task.");
            Settle(f); Only(f.Console, ConsoleAction.AnswerTask);
            Require(SingleChip(f).ItemId == SubjectId, "No words removed the chip.");

            // Any other refusal shows the Mac's words. The task is not read again and stays as it was.
            foreach (var (status, code) in new[] { (422, "answer_unusable"), (503, "recognizer_unavailable"), (502, "speech_failed"), (409, "cancelled") })
            {
                f.Transport.Answers.Enqueue(() => Reply((HttpStatusCode)status, Refusal(code)));
                Answer(f, (InteractionPresentation)Get(f.App, "task")!);
                Require(f.Strip.Stage == DialogueStage.Error && f.Strip.FullText == "Synthetic refusal for " + code + ".", code + " lacks the Mac's words.");
                Require(((InteractionPresentation)Get(f.App, "task")!).Revision == 2 && f.Transport.Count("/v1/tasks/" + TaskId) == 0,
                    code + " changed or read the task again.");
                Settle(f); Only(f.Console, ConsoleAction.AnswerTask);
            }

            // Stale: the Mac's current task is read and presented.
            f.Transport.Answers.Enqueue(() => Reply(HttpStatusCode.Conflict, Refusal("stale_revision")));
            f.Transport.Read.Enqueue(() => Reply(HttpStatusCode.OK, TaskView(3, Attempts(FirstAnswer, SecondAnswer))));
            Answer(f, (InteractionPresentation)Get(f.App, "task")!);
            Require(f.Transport.Count("/v1/tasks/" + TaskId) == 1, "A stale answer did not read the task.");
            Require(((InteractionPresentation)Get(f.App, "task")!).Revision == 3, "A stale answer did not present the Mac's task.");
            Presented(f, SecondAnswer, "You · Not sent", true, sessionHome);

            // The connection is lost twice: the existing failure words, the task stays.
            f.Transport.Answers.Enqueue(Drop); f.Transport.Answers.Enqueue(Drop);
            Answer(f, (InteractionPresentation)Get(f.App, "task")!);
            Require(f.Strip.Stage == DialogueStage.Error && f.Strip.FullText == "The Mac connection was interrupted. Your answer may still be recorded there.",
                "A lost answer hid its uncertainty.");
            Settle(f); Only(f.Console, ConsoleAction.AnswerTask);

            // Choice and task step have no person action in protocol v1; a cancelled task takes no answer.
            foreach (var view in new[] { TaskView(4, components: Components(Choice)), TaskView(4, components: Components(Step)), TaskView(4, phase: "cancelled") })
            {
                f.App.PresentTask(view);
                Settle(f);
                Only(f.Console);
                Require(f.Strip.SpeakerText == "Boopy · Not sent" && SingleChip(f).ItemId == SubjectId, "A task without an answer lost its line or chip.");
            }

            // An open save without parts: the speaker line still says Not sent; no chip, no control.
            f.App.PresentTask(TaskView(4, components: "[{\"type\":\"status\",\"code\":\"not-sent\"}]"));
            Settle(f);
            Require(f.Strip.gameObject.activeInHierarchy && f.Strip.SpeakerText == "Boopy · Not sent" && f.Strip.FullText == "",
                "An empty task line hid Not sent.");
            Require(ActiveChips(f).Length == 0 && Overlays(f) == 0, "A task without an annotation kept a chip or an outline.");
            Only(f.Console);

            // Wrong item: no chip, no outline, no control, "Wrong item.", and still Not sent.
            f.App.PresentTask(TaskView(5, Attempts(FirstAnswer), "[{\"type\":\"status\",\"code\":\"wrong-item\"}]"));
            Settle(f);
            Require(ActiveChips(f).Length == 0 && Overlays(f) == 0, "A wrong item kept its chip or outline.");
            Require(f.Strip.FullText == "Wrong item." && f.Strip.SpeakerText == "Boopy · Not sent", "A wrong item lacks its line.");
            Only(f.Console);

            // A later Talk turn returns to the session's own presentation.
            var later = Session();
            later.Utterances.Add(new UtteranceRef { Id = "synthetic-later", Text = "Who placed it?", Kind = "ask" });
            later.Dialogue = new DialogueView { Speaker = "boopy", UtteranceId = "synthetic-later", At = "1970-01-01T12:00:05Z", Text = "The record does not say who placed it." };
            later.Dialogue.Actions.Add(new ContextualAction { Id = "question-later", Question = "What would identify it?", TargetItemId = SubjectId, ObservationId = ObservationId });
            Invoke(f.App, "Apply", later);
            Settle(f);
            Require(Get(f.App, "task") == null && !f.Console.TaskShown, "A later turn kept the task.");
            Require(f.Strip.FullText == later.Dialogue.Text && f.Strip.SpeakerText == "Boopy", "A later turn kept the task's line.");
            Only(f.Console, ConsoleAction.FollowUpOne);
            Require(Label(SingleChip(f)) == Annotation && SingleChip(f).ItemId == SubjectId, "A later turn lost the session's chip.");
            Require(f.Transport.Count("/v1/sessions/" + SessionId + "/actions") == 0, "The task confirmed or changed the subject.");
        }

        // A turn without a referent grounded on an observation never asks for a task.
        private static void NotOffered()
        {
            using var f = new Fixture(false);
            f.Transport.SessionView = Session(grounded: false);
            f.Start();
            Require(f.Transport.Count("/v1/sessions/" + SessionId + "/task") == 0 && !f.Console.TaskShown, "An ungrounded turn asked for a task.");
            Only(f.Console, ConsoleAction.FollowUpOne, ConsoleAction.FollowUpTwo);
        }

        private static void Presented(Fixture f, string caption, string speaker, bool control, Vector3 sessionHome)
        {
            Settle(f);
            Require(Get(f.App, "task") != null && f.Console.TaskShown, "The task was not presented.");
            var chip = SingleChip(f);
            Require(chip.ItemId == SubjectId && Label(chip) == Annotation && State(chip).EndsWith("proposed", StringComparison.Ordinal),
                "The chip is not the annotation, proposed, on its subject.");
            Require((chip.Home - sessionHome).sqrMagnitude < 1e-8f, "The chip left the placement of that item's session chip.");
            var anchor = (Vector3?)typeof(SessionScene).GetMethod("AnchorOf", Flags)!.Invoke(f.Scene, new object[] { Session().Items[0] });
            Require(chip.Placed && chip.Anchor != null && anchor != null && (chip.Anchor.Value - anchor.Value).sqrMagnitude < 1e-8f
                && chip.GetComponentsInChildren<LineRenderer>(true).Single(line => line.name == "Evidence attachment").enabled,
                "The chip is not attached to its grounded subject.");
            Require(Overlays(f) == 1, "The subject lost its outline.");
            Require(f.Scene.TaskSubjectId == SubjectId, "The scene presents another subject.");

            Require(f.Strip.gameObject.activeInHierarchy && f.Strip.Stage == DialogueStage.Response, "The dialogue line is hidden.");
            Require(f.Strip.FullText == caption && f.Strip.VisibleText == caption, "The caption is not the task's text exactly.");
            Require(f.Strip.SpeakerText == speaker, "The speaker line is not " + speaker + ".");
            Require(!f.Status.gameObject.activeInHierarchy, "The task used the floating status line.");
            var texts = f.Strip.GetComponentsInChildren<TextMeshPro>(true);
            var speakerText = texts.Single(text => text.name == "Actual speaker and state");
            var captionText = texts.Single(text => text.name == "Actual response");
            Require(Mathf.Approximately(speakerText.fontSize, SpatialTheme.Utility) && Mathf.Approximately(captionText.fontSize, SpatialTheme.Body)
                && !captionText.isTextOverflowing, "The strip's type changed.");

            Only(f.Console, control ? new[] { ConsoleAction.AnswerTask } : Array.Empty<ConsoleAction>());
            Require(f.Console.SuggestedAction(ConsoleAction.FollowUpOne) == null, "A follow-up stays selectable under a task.");
            foreach (var global in new[] { ConsoleAction.Talk, ConsoleAction.PauseScene, ConsoleAction.Options, ConsoleAction.Settings })
                Require(Control(f.Console, global).gameObject.activeInHierarchy, "The global bar changed: " + global);
            if (!control) return;

            var action = Control(f.Console, ConsoleAction.AnswerTask);
            Require(action.AccessibleLabel == "Answer aloud", "The control is not labeled Answer aloud.");
            var verb = action.GetComponentsInChildren<TextMeshPro>(true).Single(text => text.name == "Verb");
            verb.ForceMeshUpdate(true, true);
            var box = action.GetComponent<BoxCollider>();
            Require(Mathf.Approximately(verb.fontSize, SpatialTheme.Body) && !verb.isTextOverflowing && box.size.y >= SpatialTheme.Target,
                "The control's type or hit target shrank.");
            foreach (var glyph in verb.textInfo.characterInfo.Take(verb.textInfo.characterCount).Where(glyph => glyph.isVisible))
            {
                var low = action.transform.InverseTransformPoint(verb.transform.TransformPoint(glyph.bottomLeft));
                var high = action.transform.InverseTransformPoint(verb.transform.TransformPoint(glyph.topRight));
                Require(low.x >= -box.size.x / 2f && high.x <= box.size.x / 2f && low.y >= -box.size.y / 2f && high.y <= box.size.y / 2f,
                    "A label glyph leaves its target.");
            }
            Require(action.transform.parent == f.Strip.transform.parent, "The control left the answer's group.");
            var bounds = box.bounds;
            var lineBottom = f.Strip.transform.TransformPoint(new Vector3(0f, f.Strip.ConversationAnswerBottom, 0f)).y;
            Require(Mathf.Abs((lineBottom - bounds.max.y) / f.Console.ComfortScale - .016f) < .002f, "The control is not directly under the dialogue line.");
            var backing = f.Strip.GetComponentsInChildren<MeshRenderer>(true).Single(renderer => renderer.name == "Speech contrast backing").bounds;
            Require(bounds.min.x >= backing.min.x - .001f && bounds.max.x <= backing.max.x + .001f && bounds.min.y >= backing.min.y - .001f
                && bounds.max.y <= backing.max.y + .001f, "The control left the answer's backing.");
            Require(!f.Strip.GetComponent<BoxCollider>().bounds.Intersects(bounds), "The caption pager overlaps the control.");
            var ray = new Ray(f.Eyes.position, action.transform.position - f.Eyes.position);
            Require(f.Console.HitAction(ray, out _) == ConsoleAction.AnswerTask && f.Console.CanRelease(ConsoleAction.AnswerTask, ray), "The control cannot be pinched.");

            // The chip is measured against the line and the control with the production keepout
            // projection from the eyes, and against the console's whole reserved footprint.
            var viewer = new HeadPose(Num(f.Eyes.position), Num(f.Eyes.forward));
            var lineCorners = TextCorners(speakerText).Concat(TextCorners(captionText)).ToArray();
            var chipArea = Area(viewer, ChipCorners(chip));
            Require(!chipArea.Intersects(Area(viewer, lineCorners), 0f), "The chip overlaps the dialogue line: " + Describe(chipArea, Area(viewer, lineCorners)));
            Require(!chipArea.Intersects(Area(viewer, BoxCorners(box)), 0f), "The chip overlaps the control: " + Describe(chipArea, Area(viewer, BoxCorners(box))));
            var occupied = new List<LabelRect>();
            f.Scene.AppendPresentationKeepouts(occupied, f.Console);
            Require(occupied.Count >= 2 && !chipArea.Intersects(occupied[occupied.Count - 1], 0f), "The chip overlaps the console's footprint.");
            // The line and the control share one plane: measure them in it, where the 16 mm gap is.
            var plane = action.transform.parent;
            var lineRect = PlaneRect(plane, lineCorners);
            var controlRect = PlaneRect(plane, BoxCorners(box));
            Require(!lineRect.Intersects(controlRect, 0f), "The dialogue line overlaps the control: " + Describe(lineRect, controlRect));
        }

        private static LabelRect PlaneRect(Transform plane, IEnumerable<Vector3> corners) => LabelRect.Envelope(corners
            .Select(corner => plane.InverseTransformPoint(corner)).Select(local => new N.Vector2(local.x, local.y)).ToArray());
        private static string Describe(LabelRect a, LabelRect b) =>
            $"[{a.MinX:0.0000},{a.MinY:0.0000} to {a.MaxX:0.0000},{a.MaxY:0.0000}] and [{b.MinX:0.0000},{b.MinY:0.0000} to {b.MaxX:0.0000},{b.MaxY:0.0000}]";

        private static void Answer(Fixture f, InteractionPresentation current)
        {
            ((Task)typeof(BoopyApp).GetMethod("SendAnswer", Flags)!.Invoke(f.App, new object[] { current, SpeechValidation.SyntheticWav() })!)
                .GetAwaiter().GetResult();
            Require(!(bool)Get(f.App, "busy")! && Get(f.App, "captureRequest") == null, "The answer wait did not end.");
        }

        internal static void Settle(Fixture f)
        {
            foreach (var text in f.Root.GetComponentsInChildren<TextMeshPro>()) text.ForceMeshUpdate(true, true);
            foreach (var chip in ActiveChips(f)) chip.Face(f.Eyes);
            f.Console.RefreshVisuals(1f); f.Strip.RefreshVisuals(1f);
            Physics.SyncTransforms();
        }

        internal static Chip[] ActiveChips(Fixture f) => f.Scene.GetComponentsInChildren<Chip>(true).Where(chip => chip.gameObject.activeInHierarchy).ToArray();
        private static Chip SingleChip(Fixture f)
        {
            var chips = ActiveChips(f);
            Require(chips.Length == 1, "Expected one chip, found " + chips.Length + ".");
            return chips[0];
        }
        private static int Overlays(Fixture f) => f.Scene.GetComponentsInChildren<GroundedOverlay>(true).Count(overlay => overlay.gameObject.activeInHierarchy);
        private static string Label(Chip chip) => chip.GetComponentsInChildren<TextMeshPro>(true).Single(text => text.name == "Label").text;
        private static string State(Chip chip) => chip.GetComponentsInChildren<TextMeshPro>(true).Single(text => text.name == "State").text;
        // The console's own control; the docked strip keeps its fallback Stop under the same key.
        private static SpatialAction Control(ContextConsole console, ConsoleAction action) =>
            console.GetComponentsInChildren<SpatialAction>(true)
                .Single(control => control.Action == action && control.GetComponentInParent<DialogueStrip>(true) == null);

        // Exactly these controls outside the global bar; the bar itself is checked separately.
        private static void Only(ContextConsole console, params ConsoleAction[] expected)
        {
            var actual = console.GetComponentsInChildren<SpatialAction>(true)
                .Where(control => control.gameObject.activeInHierarchy && !Global.Contains(control.Action)).Select(control => control.Action).ToArray();
            Require(actual.Length == expected.Length && expected.All(actual.Contains),
                "Expected controls [" + string.Join(", ", expected) + "], found [" + string.Join(", ", actual) + "].");
        }

        private static LabelRect Area(HeadPose viewer, IEnumerable<Vector3> corners)
        {
            Require(ProjectedKeepout.TryEnvelope(corners.Select(Num).ToArray(), viewer, out var area), "A presented part is behind the viewer.");
            return area;
        }
        private static IEnumerable<Vector3> ChipCorners(Chip chip)
        {
            var half = chip.LayoutSize * .5f;
            foreach (var x in new[] { -1f, 1f }) foreach (var y in new[] { -1f, 1f })
                yield return chip.transform.TransformPoint(new Vector3(half.x * x, half.y * y, 0f));
        }
        private static IEnumerable<Vector3> TextCorners(TextMeshPro text)
        {
            var ink = text.textBounds;
            foreach (var x in new[] { ink.min.x, ink.max.x }) foreach (var y in new[] { ink.min.y, ink.max.y })
                yield return text.transform.TransformPoint(new Vector3(x, y, 0f));
        }
        private static IEnumerable<Vector3> BoxCorners(BoxCollider box)
        {
            foreach (var x in new[] { -.5f, .5f }) foreach (var y in new[] { -.5f, .5f })
                yield return box.transform.TransformPoint(box.center + new Vector3(box.size.x * x, box.size.y * y, 0f));
        }
        private static N.Vector3 Num(Vector3 value) => new N.Vector3(value.x, value.y, value.z);

        internal static SessionView Session(bool grounded = true)
        {
            var view = new SessionView
            {
                Id = SessionId, State = "review", ReferentId = SubjectId, Model = new ModelRef { Provider = "fixture", Id = "synthetic" },
                Dialogue = new DialogueView { Speaker = "boopy", UtteranceId = "synthetic-turn", At = "1970-01-01T12:00:00Z", Text = Line },
            };
            view.Dialogue.Actions.Add(new ContextualAction { Id = "question-origin", Question = "Who placed this marker?", TargetItemId = SubjectId, ObservationId = ObservationId });
            view.Dialogue.Actions.Add(new ContextualAction { Id = "question-sign", Question = "What does the nearby sign say?", ObservationId = ObservationId });
            view.Utterances.Add(new UtteranceRef { Id = "synthetic-turn", Text = "What is this?", Kind = "ask" });
            view.Observations.Add(new ObservationRef { Id = ObservationId, CapturedAt = "1970-01-01T12:00:00Z" });
            // Unknown confidence stays unknown: the session chip and the task chip read the same.
            view.Items.Add(new Item
            {
                Id = SubjectId, Kind = "object", Label = Annotation, Statement = "It may be a stone marker.", Origin = "model", Status = "proposed",
                Grounding = grounded
                    ? new Grounding { Kind = "box", ObservationId = ObservationId, Box = new Box2 { X0 = .34f, Y0 = .42f, X1 = .49f, Y1 = .605f } }
                    : new Grounding { Kind = "scene" },
            });
            return view;
        }

        private const string StandIn =
            "{\"type\":\"subject\",\"sourceId\":\"src_synthetic-observation\",\"maskId\":null}," +
            "{\"type\":\"annotation\",\"text\":\"" + Annotation + "\",\"evidenceIds\":[\"" + SubjectId + "\"]}," +
            "{\"type\":\"dialogue\",\"text\":\"" + Line + "\",\"evidenceIds\":[\"" + SubjectId + "\"]}";
        private const string Choice = "{\"type\":\"choice\",\"prompt\":\"Which one?\",\"options\":[{\"id\":\"opt_a\",\"label\":\"The stone\"}]}";
        private const string Step = "{\"type\":\"task_step\",\"text\":\"Look at the base.\",\"evidenceIds\":[\"" + SubjectId + "\"]}";
        private static string Components(string action) => "[" + StandIn + "," + action + ",{\"type\":\"status\",\"code\":\"not-sent\"}]";

        internal static string Attempts(params string[] words) => new JArray(words.Select((text, index) => new JObject
        {
            ["eventId"] = "evt_synthetic" + index, ["text"] = text, ["recognitionUncertain"] = index % 2 == 1, ["kind"] = "practice-attempt",
        })).ToString(Newtonsoft.Json.Formatting.None);

        /// <summary>The view the service's stand-in result produces for the synthetic first turn.</summary>
        internal static string TaskView(int revision = 1, string attempts = "[]", string? components = null, string phase = "open") =>
            "{\"taskId\":\"" + TaskId + "\",\"sessionId\":\"" + SessionId + "\",\"revision\":" + revision +
            ",\"source\":{\"sourceId\":\"src_synthetic-observation\",\"sourceRevision\":1,\"sha256\":\"" + new string('c', 64) + "\"}" +
            ",\"intent\":\"consult_source\",\"utterance\":\"What is this?\",\"phase\":\"" + phase + "\"" +
            ",\"continuity\":\"local-only\",\"delivery\":\"not-sent\",\"subjectCorrected\":false" +
            ",\"components\":" + (components ?? Components("{\"type\":\"voice_reply\",\"prompt\":\"Answer aloud.\"}")) +
            ",\"attempts\":" + attempts + ",\"lastRejection\":null}";

        internal static Task<HttpResponseMessage> Reply(HttpStatusCode status, string body) =>
            Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        private static Task<HttpResponseMessage> Drop() => Task.FromException<HttpResponseMessage>(new HttpRequestException("Synthetic dropped reply."));
        private static string Refusal(string code) => "{\"error\":{\"code\":\"" + code + "\",\"message\":\"Synthetic refusal for " + code + ".\"}}";

        /// <summary>The objects BoopyApp builds, over a synthetic grounded subject and synthetic transport.</summary>
        internal sealed class Fixture : IDisposable
        {
            public readonly GameObject Root;
            public readonly Transform Eyes;
            public readonly SessionScene Scene;
            public readonly ContextConsole Console;
            public readonly DialogueStrip Strip;
            public readonly StatusLine Status;
            public readonly BoopyApp App;
            public readonly Transport Transport = new Transport();
            private readonly ServiceClient client;
            private readonly string directory = Path.Combine(Path.GetTempPath(), "boopy-task-validation-" + Guid.NewGuid().ToString("N"));

            public Fixture(bool large)
            {
                Directory.CreateDirectory(directory);
                Root = new GameObject("Synthetic task presentation");
                Eyes = new GameObject("Synthetic eyes").transform; Eyes.SetParent(Root.transform, false);
                var room = Root.AddComponent<RoomCamera>();
                Scene = SessionScene.Create(Root.transform, room, Eyes);
                Console = ContextConsole.Create(Root.transform, Eyes);
                if (large) Console.Activate(ConsoleAction.Size);
                Scene.MoveConsole(Console, new Vector3(.42f, .08f, 1f));
                Strip = DialogueStrip.Create(Root.transform, Eyes); Console.DockDialogue(Strip);
                Status = StatusLine.Create(Root.transform, Eyes, Visuals.Quad());
                App = Root.AddComponent<BoopyApp>();
                client = new ServiceClient(handler: Transport);
                Set(App, "client", client); Set(App, "scene", Scene); Set(App, "console", Console); Set(App, "dialogue", Strip);
                Set(App, "room", room); Set(App, "head", Eyes); Set(App, "status", Status);
                Set(App, "recoveryStore", new CaptureRecoveryStore(Path.Combine(directory, "pending-id")));
                Set(App, "handoffRecoveryStore", new HandoffRecoveryStore(Path.Combine(directory, "preparation-identity")));
            }

            /// <summary>The production first turn: capture sent, view applied, the task asked for and presented.</summary>
            public void Start()
            {
                Set(App, "pending", Snapshot()); Set(App, "pendingEvidence", new EvidenceTurn(false));
                ((Task)typeof(BoopyApp).GetMethod("Send", Flags)!.Invoke(App, new object[] { SpeechValidation.SyntheticWav() })!).GetAwaiter().GetResult();
                Require(Get(App, "session") is SessionView view && view.Id == SessionId, "The synthetic first turn was not applied.");
                Settle(this);
            }

            public void Dispose()
            {
                client.Dispose();
                UnityEngine.Object.DestroyImmediate(Root);
                Directory.Delete(directory, true);
            }
        }

        // A recorded camera pose and coarse depth that place the subject 2 m ahead, left of center.
        internal static Snapshot Snapshot() => new Snapshot(new byte[] { 255, 216, 255, 217 }, 80, 80,
            new DateTime(1970, 1, 1, 12, 0, 0, DateTimeKind.Utc), new Pose(Vector3.zero, Quaternion.identity),
            new DepthGrid { Columns = 1, Rows = 1, Meters = new float?[] { 2f } },
            new CameraInfo { FocalLength = new float[] { 40, 40 }, PrincipalPoint = new float[] { 40, 40 }, SensorResolution = new[] { 80, 80 } });

        internal sealed class Transport : HttpMessageHandler
        {
            public SessionView SessionView = Session();
            public readonly Queue<Func<Task<HttpResponseMessage>>> Open = new Queue<Func<Task<HttpResponseMessage>>>();
            public readonly Queue<Func<Task<HttpResponseMessage>>> Answers = new Queue<Func<Task<HttpResponseMessage>>>();
            public readonly Queue<Func<Task<HttpResponseMessage>>> Read = new Queue<Func<Task<HttpResponseMessage>>>();
            private readonly List<(string Path, string? Body)> requests = new List<(string, string?)>();
            public int Count(string path) => requests.Count(request => request.Path == path);
            public List<string> Bodies(string path) => requests.Where(request => request.Path == path).Select(request => request.Body ?? "").ToList();

            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel)
            {
                var path = request.RequestUri!.AbsolutePath;
                if (path == "/v1/health") return Reply(HttpStatusCode.OK, Health);
                requests.Add((path, request.Content?.ReadAsStringAsync().GetAwaiter().GetResult()));
                if (request.Method == HttpMethod.Post && path == "/v1/sessions") return Reply(HttpStatusCode.OK, Wire.Write(SessionView));
                if (request.Method == HttpMethod.Post && path == "/v1/sessions/" + SessionId + "/task") return Open.Dequeue()();
                if (request.Method == HttpMethod.Post && path == "/v1/tasks/" + TaskId + "/answers") return Answers.Dequeue()();
                if (request.Method == HttpMethod.Get && path == "/v1/tasks/" + TaskId) return Read.Dequeue()();
                throw new InvalidOperationException("Unexpected synthetic request: " + request.Method + " " + path);
            }
        }

        private static object? Invoke(object target, string name, params object[] args) => target.GetType().GetMethod(name, Flags)!.Invoke(target, args);
        private static void Set(object target, string name, object? value) => target.GetType().GetField(name, Flags)!.SetValue(target, value);
        private static object? Get(object target, string name) => target.GetType().GetField(name, Flags)!.GetValue(target);
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
