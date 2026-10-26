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
        // A task that offers a voice reply asks the person something, as the Mac's stand-in does; a statement offers none.
        internal const string Asked = "What do you think it marks?";
        internal const string Annotation = "Stone marker";
        internal const string FirstAnswer = "A stone marker by the trail.";
        internal const string SecondAnswer = "어제 본 돌이에요.";
        internal const string SubjectKind = "text";
        internal const string SubjectGloss = "Trail marker";
        // The app's thinking phrases come in this seeded order, so the working line is exact under test.
        internal const int PhraseSeed = 17;
        private const string OpenPath = "/v1/sessions/" + SessionId + "/task";
        private const string AnswerPath = "/v1/tasks/" + TaskId + "/answers";
        private const string Health = "{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}}";
        private static readonly ConsoleAction[] Global = { ConsoleAction.Talk, ConsoleAction.FinishTalk, ConsoleAction.PauseScene,
            ConsoleAction.Options, ConsoleAction.Settings, ConsoleAction.Cancel, ConsoleAction.More, ConsoleAction.ShelfBack };

        public static void Run()
        {
            var context = SynchronizationContext.Current;
            try
            {
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                ScriptCoverage.Install();
                // Synthetic transport completes inline; production continuations then run on this thread.
                SynchronizationContext.SetSynchronizationContext(null);
                foreach (var large in new[] { false, true }) Validate(large);
                NotOffered();
                ThinkingWithoutPictureOrMotion();
                Debug.Log("Boopy task presentation validation passed: one chip on the outlined subject at its session placement, " +
                    "the dialogue line with \"Boopy · Not sent to your AI\", one \"Answer\" control with Talk's mic under it and no follow-ups, no overlap, " +
                    "no control under the line and Talk as the primary when the task offers no reply or the line shows the person's answer, " +
                    "answers as \"You, as heard · Not sent to your AI\" and \"You · Not sent to your AI\" after \"Saving on your Mac…\", the stale notice and its unread case, " +
                    "no task for a partial view or any choice turn, the item's kind, gloss and confidence, wrong item with and without an answer, " +
                    "one primary control (Answer while it shows, otherwise Talk, Finish while recording), retry with the same ids, " +
                    "standard and large text (synthetic).");
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
                Require(reference.Strip.Stage == DialogueStage.Response && reference.Strip.FullText == Line && reference.Strip.SpeakerText == "Boopy · 1 of 3",
                    "An unavailable task showed an error or changed the session line.");
                Questions(reference, SessionQuestions);
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

            // Boopy's line asks the person nothing, so the task offers no reply: its chip and its line, no control in
            // the dialogue box, and Talk as the one primary.
            using (var lineOnly = new Fixture(large))
            {
                lineOnly.Transport.Open.Enqueue(() => Reply(HttpStatusCode.OK, TaskView(components: Parts(action: null))));
                lineOnly.Start();
                Presented(lineOnly, Line, "Boopy · Not sent to your AI", false, sessionHome);
                Require(lineOnly.Root.GetComponentsInChildren<SpatialAction>(true)
                    .All(control => control.Action != ConsoleAction.AnswerTask || !control.gameObject.activeInHierarchy),
                    "A task that asks nothing shows a reply control.");
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
            // While the first turn is on its way: Boopy's thinking phrase from its first frame, the next one after
            // a while, and no timer.
            var order = new ThinkingPhrases(PhraseSeed);
            var (firstPhrase, nextPhrase) = (order.Next(), order.Next());
            string? startWait = "The first turn never reached the Mac.";
            f.Transport.OnStart = () => startWait = WorkingProblem(f, firstPhrase, "Sending…", nextPhrase);
            f.Start();
            f.Transport.OnStart = null;
            Require(startWait == null, "The first turn's working line: " + startWait);
            var opens = f.Transport.Bodies("/v1/sessions/" + SessionId + "/task");
            Require(opens.Count == 2 && opens[0] == opens[1], "The open retry was not the same event.");
            var open = JObject.Parse(opens[0]);
            Require(open.Properties().Select(property => property.Name).SequenceEqual(new[] { "eventId", "taskId" })
                && Regex.IsMatch((string?)open["eventId"] ?? "", "^evt_[0-9a-f]{32}$") && Regex.IsMatch((string?)open["taskId"] ?? "", "^tsk_[0-9a-f]{32}$"),
                "The open request does not carry headset-made ids only.");
            Presented(f, Asked, "Boopy · Not sent to your AI", true, sessionHome);

            // The eyes step back: each frame the outline keeps its angle, and the leader follows the rule
            // from the new eyes: hidden once the chip's bottom is seen on the outline, otherwise drawn and stopping outside it.
            foreach (var step in new[] { .2f, .8f })
            {
                f.Eyes.position += Vector3.back * step;
                Invoke(f.Scene, "LateUpdate");
                var stepped = SingleChip(f);
                var steppedOutline = f.Scene.GetComponentsInChildren<GroundedOverlay>().Single(overlay => overlay.gameObject.activeInHierarchy)
                    .GetComponentsInChildren<LineRenderer>(true).Single(line => line.name == "Observed boundary");
                var steppedLeader = stepped.GetComponentsInChildren<LineRenderer>(true).Single(line => line.name == "Evidence attachment");
                Require(WidthAngle(f, steppedOutline) >= .00179f, "After the eyes step back " + step + " m the outline lost its 1.8 mrad: "
                    + (WidthAngle(f, steppedOutline) * 1000f).ToString("0.00") + ".");
                var (bottomInside, bottomGap) = AgainstOutline(f, steppedOutline, steppedLeader.GetPosition(0));
                Debug.Log("Boopy task validation: after the eyes step back " + step + " m the chip's bottom is " + (bottomInside ? "inside" : "outside")
                    + " the outline, " + (bottomGap * 1000f).ToString("0.0") + " mm from it; the leader is " + (steppedLeader.forceRenderingOff ? "hidden." : "drawn."));
                if (bottomInside) Require(steppedLeader.forceRenderingOff, "After the eyes step back a leader starting inside the outline is drawn.");
                else if (steppedLeader.forceRenderingOff) Require(bottomGap <= .005f, "After the eyes step back a leader starting clear of the outline is hidden.");
                else LinesHold(f, stepped, "After the eyes step back " + step + " m");
                f.Eyes.position -= Vector3.back * step;
                Invoke(f.Scene, "LateUpdate");
            }

            // Focus lost and regained keeps the same task on the same session view.
            Invoke(f.App, "OnFocusLost"); Invoke(f.App, "OnFocusAcquired");
            Presented(f, Asked, "Boopy · Not sent to your AI", true, sessionHome);

            // A Talk recording cancelled with the bar's Cancel gives back the task's line. No microphone opens.
            var buttonTalk = (ButtonTalk)Get(f.App, "buttonTalk")!;
            buttonTalk.Begin(0f); f.Console.ShowListening(false); f.Console.SetButtonRecording(true);
            f.Strip.Show(DialogueStage.Listening, "Listening… Tap Finish when done.");
            Settle(f);
            FirstTile(f, ConsoleAction.FinishTalk, "A recording under a task");
            var cancel = Control(f.Console, ConsoleAction.Cancel);
            var hand = new HandInput(true, null, null);
            typeof(HandInput).GetProperty("Ray")!.SetValue(hand, new Ray(f.Eyes.position, cancel.transform.position - f.Eyes.position));
            typeof(HandInput).GetProperty("RayActive")!.SetValue(hand, true);
            Set(f.App, "pendingControl", ConsoleAction.Cancel); Set(f.App, "pendingUsesHandRay", true);
            Invoke(f.App, "ReleaseControl", hand);
            Require(!buttonTalk.Recording, "Cancel kept the recording.");
            Presented(f, Asked, "Boopy · Not sent to your AI", true, sessionHome);

            // Finish with no audio: the answer's own words, nothing sent, the control stays.
            buttonTalk.Begin(0f); Set(f.App, "answeringTask", true); f.Console.ShowListening(false); f.Console.SetButtonRecording(true);
            Invoke(f.App, "FinishRecording");
            Require(!buttonTalk.Recording && f.Transport.Count("/v1/tasks/" + TaskId + "/answers") == 0, "An empty answer was sent.");
            Require(f.Strip.Stage == DialogueStage.Error && f.Strip.FullText == "No speech recorded. Tap Answer to try again.",
                "An empty answer lacks its retry words.");
            Settle(f); Only(f.Console, ConsoleAction.AnswerTask);

            // The answer recording runs out: the answer's retry words, nothing sent, the control stays.
            buttonTalk.Begin(0f); Set(f.App, "answeringTask", true); f.Console.ShowListening(false); f.Console.SetButtonRecording(true);
            f.Strip.Show(DialogueStage.Listening, "Listening… Tap Finish when done.");
            Invoke(f.App, "ExpireButtonRecording", 30f);
            Require(!buttonTalk.Recording && !(bool)Get(f.App, "answeringTask")! && f.Transport.Count(AnswerPath) == 0,
                "An expired answer recording was kept or sent.");
            Require(f.Strip.Stage == DialogueStage.Error && f.Strip.FullText == "Recording stopped. Tap Answer to try again.",
                "An expired answer lacks its retry words.");
            Settle(f); Only(f.Console, ConsoleAction.AnswerTask);

            // Answers the Mac does not record, while Boopy's line still asks: each keeps the task and the control.
            // The Mac heard no words: the retry line, the same task, the control stays.
            f.Transport.Answers.Enqueue(() => Reply((HttpStatusCode)422, Refusal("no_words")));
            Answer(f, (InteractionPresentation)Get(f.App, "task")!);
            Require(f.Strip.Stage == DialogueStage.Error && f.Strip.FullText == "No speech recorded. Tap Answer to try again.",
                "No words lacks its retry line.");
            Require(((InteractionPresentation)Get(f.App, "task")!).Revision == 1, "No words changed the task.");
            Settle(f); Only(f.Console, ConsoleAction.AnswerTask);
            Require(SingleChip(f).ItemId == SubjectId, "No words removed the chip.");

            // Any other refusal shows the Mac's words. The task is not read again and stays as it was.
            foreach (var (status, code) in new[] { (422, "answer_unusable"), (503, "recognizer_unavailable"), (502, "speech_failed"), (409, "cancelled") })
            {
                f.Transport.Answers.Enqueue(() => Reply((HttpStatusCode)status, Refusal(code)));
                Answer(f, (InteractionPresentation)Get(f.App, "task")!);
                Require(f.Strip.Stage == DialogueStage.Error && f.Strip.FullText == "Synthetic refusal for " + code + ".", code + " lacks the Mac's words.");
                Require(((InteractionPresentation)Get(f.App, "task")!).Revision == 1 && f.Transport.Count("/v1/tasks/" + TaskId) == 0,
                    code + " changed or read the task again.");
                Settle(f); Only(f.Console, ConsoleAction.AnswerTask);
            }

            // A failure that is not the Mac's refusal: the answer's own uncertainty words, the task stays.
            f.Transport.Answers.Enqueue(Fail);
            Answer(f, (InteractionPresentation)Get(f.App, "task")!);
            Require(f.Strip.Stage == DialogueStage.Error
                && f.Strip.FullText == "Couldn't confirm the answer. The Mac may still record it. Reconnect before answering again.",
                "An unconfirmed answer lacks the answer's words: " + f.Strip.FullText);
            Require(((InteractionPresentation)Get(f.App, "task")!).Revision == 1, "An unconfirmed answer changed the task.");
            Settle(f); Only(f.Console, ConsoleAction.AnswerTask);

            // Focus lost while an answer is on its way: a late reply is not applied; the wait's words return with focus.
            f.Transport.OnAnswer = () => Invoke(f.App, "OnFocusLost");
            f.Transport.Answers.Enqueue(() => Reply(HttpStatusCode.OK, TaskView(2, Attempts((FirstAnswer, true)))));
            Answer(f, (InteractionPresentation)Get(f.App, "task")!);
            f.Transport.OnAnswer = null;
            Require(((InteractionPresentation)Get(f.App, "task")!).Revision == 1, "A reply that arrived after focus loss was applied.");
            Invoke(f.App, "OnFocusAcquired");
            Require(f.Strip.Stage == DialogueStage.Error && f.Strip.FullText == "Stopped waiting. The Mac may still record this answer.",
                "Focus came back without the answer's uncertainty.");
            Settle(f); Only(f.Console, ConsoleAction.AnswerTask);
            Require(SingleChip(f).ItemId == SubjectId, "Focus loss during an answer removed the chip.");

            // Stale, then the Mac's task cannot be read (lost, failed, or focus lost while reading):
            // the answer was refused, so it was not recorded, and the task stays as it was.
            foreach (var (unread, focusLost) in new (Func<Task<HttpResponseMessage>>, bool)[] { (Drop, false), (Fail, false),
                (() => Reply(HttpStatusCode.OK, TaskView(2, Attempts((FirstAnswer, true)))), true) })
            {
                f.Transport.Answers.Enqueue(() => Reply(HttpStatusCode.Conflict, Refusal("stale_revision")));
                f.Transport.Read.Enqueue(unread);
                if (focusLost) f.Transport.OnRead = () => Invoke(f.App, "OnFocusLost");
                Answer(f, (InteractionPresentation)Get(f.App, "task")!);
                f.Transport.OnRead = null;
                if (focusLost) Invoke(f.App, "OnFocusAcquired");
                Require(f.Strip.Stage == DialogueStage.Error && f.Strip.FullText == "That answer was not recorded. Reconnect before answering again.",
                    "A stale answer whose task was not read lacks its words: " + f.Strip.FullText);
                Require(((InteractionPresentation)Get(f.App, "task")!).Revision == 1, "A stale answer whose task was not read changed the task.");
                Settle(f); Only(f.Console, ConsoleAction.AnswerTask);
                Require(SingleChip(f).ItemId == SubjectId, "A stale answer whose task was not read removed the chip.");
            }

            // The connection is lost twice: the existing failure words, the task stays.
            f.Transport.Answers.Enqueue(Drop); f.Transport.Answers.Enqueue(Drop);
            Answer(f, (InteractionPresentation)Get(f.App, "task")!);
            Require(f.Strip.Stage == DialogueStage.Error && f.Strip.FullText == "The Mac connection was interrupted. Your answer may still be recorded there.",
                "A lost answer hid its uncertainty.");
            Settle(f); Only(f.Console, ConsoleAction.AnswerTask);

            // An answer: the wait line, the current revision, base64 audio, no frame. A lost reply is the same event again.
            var current = (InteractionPresentation)Get(f.App, "task")!;
            var waits = new List<string>();
            string? answerWait = null;
            f.Transport.OnAnswer = () =>
            {
                waits.Add(f.Strip.Stage + ": " + f.Strip.FullText);
                if (waits.Count == 1) answerWait = WorkingProblem(f, "Saving on your Mac…", "Saving on your Mac…");
            };
            var earlier = f.Transport.Bodies(AnswerPath).Count;
            f.Transport.Answers.Enqueue(Drop);
            f.Transport.Answers.Enqueue(() => Reply(HttpStatusCode.OK, TaskView(2, Attempts((FirstAnswer, true)))));
            // Whatever time has passed on the line before, its working state starts the shimmer on the first glyph.
            f.Strip.RefreshVisuals(.7f);
            Answer(f, current);
            f.Transport.OnAnswer = null;
            Require(waits.Count == 2 && waits.All(wait => wait == "Working: Saving on your Mac…"),
                "The answer's wait line is not Saving on your Mac: " + string.Join(" | ", waits));
            Require(answerWait == null, "The answer's working line: " + answerWait);
            var answers = f.Transport.Bodies(AnswerPath).Skip(earlier).ToList();
            Require(answers.Count == 2 && answers[0] == answers[1], "The answer retry was not the same event.");
            var answer = JObject.Parse(answers[0]);
            Require(answer.Properties().Select(property => property.Name).SequenceEqual(new[] { "eventId", "sessionId", "expectedRevision", "speech" })
                && (int)answer["expectedRevision"]! == 1 && (string?)answer["sessionId"] == SessionId
                && Regex.IsMatch((string?)answer["eventId"] ?? "", "^evt_[0-9a-f]{32}$")
                && ((JObject)answer["speech"]!).Properties().Select(property => property.Name).SequenceEqual(new[] { "wav" })
                && (string?)answer["speech"]!["wav"] == Convert.ToBase64String(SpeechValidation.SyntheticWav()),
                "The answer is not this recording against the current revision, or it carries more than audio.");
            Require(f.Transport.Count("/v1/sessions") == 1, "An answer sent the frame or the capture again.");
            // The Mac's recognizer gives no confidence, so its words are uncertain and say so. The line now shows the
            // person's answer, not Boopy asking, so the answer control is gone and Talk is the one primary.
            Presented(f, FirstAnswer, "You, as heard · Not sent to your AI", false, sessionHome);

            // Boopy asks again (a later revision whose line asks, with no answer yet): the control is back. The Mac's
            // task moved on meanwhile, so the answer is stale: its current task is read and presented, with a short
            // notice that this answer was not recorded, and with its answer on the line there is no control.
            f.App.PresentTask(TaskView(3));
            Presented(f, Asked, "Boopy · Not sent to your AI", true, sessionHome);
            var reads = f.Transport.Count("/v1/tasks/" + TaskId);
            f.Transport.Answers.Enqueue(() => Reply(HttpStatusCode.Conflict, Refusal("stale_revision")));
            f.Transport.Read.Enqueue(() => Reply(HttpStatusCode.OK, TaskView(4, Attempts((FirstAnswer, true), (SecondAnswer, false)))));
            Answer(f, (InteractionPresentation)Get(f.App, "task")!);
            Require(f.Transport.Count("/v1/tasks/" + TaskId) == reads + 1, "A stale answer did not read the task.");
            Require(((InteractionPresentation)Get(f.App, "task")!).Revision == 4, "A stale answer did not present the Mac's task.");
            Require(f.Strip.FullText == "That answer was not recorded.", "A stale answer did not say it was not recorded.");
            f.Strip.ClearNotice();
            Presented(f, SecondAnswer, "You · Not sent to your AI", false, sessionHome);

            // Choice and task step have no person action in protocol v1; a cancelled task takes no answer.
            foreach (var view in new[] { TaskView(4, components: Parts(action: Choice)), TaskView(4, components: Parts(action: Step)), TaskView(4, phase: "cancelled") })
            {
                f.App.PresentTask(view);
                Settle(f);
                Only(f.Console);
                Require(f.Strip.SpeakerText == "Boopy · Not sent to your AI" && SingleChip(f).ItemId == SubjectId, "A task without an answer lost its line or chip.");
            }

            // A view with neither its chip and line nor an answer: the session's own presentation returns.
            f.App.PresentTask(TaskView(4, components: "[{\"type\":\"status\",\"code\":\"not-sent\"}]"));
            SessionShown(f, sessionHome, "A task without parts");

            // Wrong item before any answer: the session's chip does not come back on the wrong item.
            f.App.PresentTask(TaskView(5, "[]", "[{\"type\":\"status\",\"code\":\"wrong-item\"}]"));
            Settle(f);
            Require(Get(f.App, "task") != null && f.Console.TaskShown, "A wrong item without an answer was not presented.");
            Require(ActiveChips(f).Length == 0 && Overlays(f) == 0, "A wrong item without an answer kept a chip or outline.");
            Require(f.Strip.FullText == "Wrong item." && f.Strip.SpeakerText == "Boopy · Not sent to your AI", "A wrong item without an answer lacks its line.");
            Only(f.Console);
            FirstTile(f, ConsoleAction.Talk, "A wrong item");

            // Wrong item after an answer: no chip, no outline, no control, "Wrong item.", and still Not sent.
            f.App.PresentTask(TaskView(5, Attempts((FirstAnswer, true)), "[{\"type\":\"status\",\"code\":\"wrong-item\"}]"));
            Settle(f);
            Require(ActiveChips(f).Length == 0 && Overlays(f) == 0, "A wrong item kept its chip or outline.");
            Require(f.Strip.FullText == "Wrong item." && f.Strip.SpeakerText == "Boopy · Not sent to your AI", "A wrong item lacks its line.");
            Only(f.Console);

            // An annotation that is not the item's label keeps the item's kind and drops the item's gloss and confidence.
            f.App.PresentTask(TaskView(6, components: Parts(annotationText: "Trail stone")));
            Settle(f);
            var renamed = SingleChip(f);
            Require(Label(renamed) == "Trail stone" && State(renamed) == SubjectKind + " / proposed" && !Gloss(renamed).gameObject.activeSelf,
                "A renamed chip lost its item's kind or kept a gloss for another label.");

            // A later Talk turn returns to the session's own presentation.
            var later = Session();
            later.Utterances.Add(new UtteranceRef { Id = "synthetic-later", Text = "Who placed it?", Kind = "ask" });
            later.Dialogue = new DialogueView { Speaker = "boopy", UtteranceId = "synthetic-later", At = "1970-01-01T12:00:05Z", Text = "The record does not say who placed it." };
            later.Dialogue.Actions.Add(new ContextualAction { Id = "question-later", Question = "What would identify it?", TargetItemId = SubjectId, ObservationId = ObservationId });
            Invoke(f.App, "Apply", later);
            Settle(f);
            Require(Get(f.App, "task") == null && !f.Console.TaskShown, "A later turn kept the task.");
            Require(f.Strip.FullText == later.Dialogue.Text && f.Strip.SpeakerText == "Boopy · 1 of 2", "A later turn kept the task's line.");
            Questions(f, "What would identify it?");
            FirstTile(f, ConsoleAction.Talk, "A later turn");
            Require(Label(SingleChip(f)) == Annotation && SingleChip(f).ItemId == SubjectId, "A later turn lost the session's chip.");
            Require(f.Transport.Count("/v1/sessions/" + SessionId + "/actions") == 0, "The task confirmed or changed the subject.");
        }

        private static void ThinkingWithoutPictureOrMotion()
        {
            // A "Without a photo" turn shows the picture-free phrases only: it never says Boopy is looking.
            using (var spoken = new Fixture(false))
            {
                var order = new ThinkingPhrases(PhraseSeed, picture: false);
                var (first, next) = (order.Next(), order.Next());
                spoken.Transport.Open.Enqueue(() => Reply(HttpStatusCode.Conflict, Refusal("task_unavailable")));
                string? wait = "The turn without a photo never reached the Mac.";
                spoken.Transport.OnStart = () => wait = WorkingProblem(spoken, first, "Sending…", next);
                spoken.Start(picture: false);
                Require(wait == null, "A turn without a photo: " + wait);
                Require(!ThinkingPhrases.Looking.Contains(first) && !ThinkingPhrases.Looking.Contains(next), "A turn without a photo says Boopy is looking.");
            }

            // Reduced motion: the phrase is whole and still, and the next phrase arrives as a cut, whole on its first frame.
            using var still = new Fixture(false);
            still.Console.SetReducedMotion(true);
            var phrases = new ThinkingPhrases(PhraseSeed);
            var (shown, after) = (phrases.Next(), phrases.Next());
            still.Console.ShowProcessing(); still.Strip.ShowThinking(new ThinkingPhrases(PhraseSeed));
            var problem = FirstFrameProblem(still, shown, sweep: false);
            Require(problem == null, "Reduced motion, the first phrase: " + problem);
            typeof(DialogueStrip).GetField("stageStartedAt", Flags)!.SetValue(still.Strip, Time.unscaledTime - ThinkingPhrases.Seconds - .1f);
            still.Strip.RefreshVisuals(0f);
            problem = FirstFrameProblem(still, after, sweep: false);
            Require(problem == null, "Reduced motion, the next phrase: " + problem);
        }

        // A turn without a referent grounded on an observation, or with a choice on its line, never asks for a task.
        private static void NotOffered()
        {
            using (var choosing = new Fixture(false))
            {
                choosing.Transport.SessionView = Session(choice: true);
                choosing.Start();
                Require(choosing.Transport.Count(OpenPath) == 0 && !choosing.Console.TaskShown, "A turn with a choice asked for a task.");
                Only(choosing.Console, ConsoleAction.SendChoice);
            }
            // A choice card the console cannot draw still makes the turn a choice, not a task.
            using (var unsupported = new Fixture(false))
            {
                unsupported.Transport.SessionView = Session(choice: true);
                unsupported.Transport.SessionView.Dialogue!.Choice!.Options.RemoveAt(1);
                unsupported.Start();
                Require(unsupported.Transport.Count(OpenPath) == 0 && !unsupported.Console.TaskShown, "A turn with an unsupported choice asked for a task.");
            }
            using var f = new Fixture(false);
            f.Transport.SessionView = Session(grounded: false);
            f.Start();
            Require(f.Transport.Count(OpenPath) == 0 && !f.Console.TaskShown, "An ungrounded turn asked for a task.");
            Questions(f, SessionQuestions);
        }

        private static void Presented(Fixture f, string caption, string speaker, bool control, Vector3 sessionHome)
        {
            Settle(f);
            Require(Get(f.App, "task") != null && f.Console.TaskShown, "The task was not presented.");
            var chip = SingleChip(f);
            Require(chip.ItemId == SubjectId && Label(chip) == Annotation && State(chip) == SubjectKind + " / unsure",
                "The chip is not the annotation under its item's kind, with its item's low confidence: " + State(chip));
            Require(Gloss(chip).gameObject.activeSelf && Gloss(chip).text == SubjectGloss, "The chip lost its item's gloss for the same label.");
            Require((chip.Home - sessionHome).sqrMagnitude < 1e-8f, "The chip left the placement of that item's session chip.");
            var anchor = (Vector3?)typeof(SessionScene).GetMethod("AnchorOf", Flags)!.Invoke(f.Scene, new object[] { Session().Items[0] });
            Require(chip.Placed && chip.Anchor != null && anchor != null && (chip.Anchor.Value - anchor.Value).sqrMagnitude < 1e-8f
                && chip.GetComponentsInChildren<LineRenderer>(true).Single(line => line.name == "Evidence attachment").enabled,
                "The chip is not attached to its grounded subject.");
            Require(Overlays(f) == 1, "The subject lost its outline.");
            LinesHold(f, chip, "A presented task");
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
            // One row: the speak tile first (Answer while Boopy's line asks, otherwise Talk, never both), then Pause and More.
            foreach (var global in new[] { control ? ConsoleAction.AnswerTask : ConsoleAction.Talk, ConsoleAction.PauseScene, ConsoleAction.More })
                Require(Control(f.Console, global).gameObject.activeInHierarchy, "The global bar changed: " + global);
            Require(!control || !Control(f.Console, ConsoleAction.Talk).gameObject.activeInHierarchy, "Talk shows beside Answer.");
            FirstTile(f, control ? ConsoleAction.AnswerTask : ConsoleAction.Talk, "A presented task");
            if (!control) return;

            var action = Control(f.Console, ConsoleAction.AnswerTask);
            Require(action.AccessibleLabel == "Answer", "The control is not labeled with the prompt, Answer: " + action.AccessibleLabel);
            var verb = action.GetComponentsInChildren<TextMeshPro>(true).Single(text => text.name == "Verb");
            verb.ForceMeshUpdate(true, true);
            var box = action.GetComponent<BoxCollider>();
            Require(Mathf.Approximately(verb.fontSize, SpatialTheme.Body) && !verb.isTextOverflowing && box.size.y >= SpatialTheme.Target,
                "The control's type or hit target shrank.");
            Require(verb.font == BoopyTypography.Load() && Mathf.Approximately(box.size.x, SpatialTheme.ShelfSlot) && verb.textInfo.lineCount == 1,
                "The Answer tile lost the Regular face, the row's slot, or its one line.");
            foreach (var glyph in verb.textInfo.characterInfo.Take(verb.textInfo.characterCount).Where(glyph => glyph.isVisible))
            {
                var low = action.transform.InverseTransformPoint(verb.transform.TransformPoint(glyph.bottomLeft));
                var high = action.transform.InverseTransformPoint(verb.transform.TransformPoint(glyph.topRight));
                Require(low.x >= -box.size.x / 2f && high.x <= box.size.x / 2f && low.y >= -box.size.y / 2f && high.y <= box.size.y / 2f,
                    "A label glyph leaves its target.");
            }
            // Talk's mic sits at the label's left, inside the target: answering is speaking.
            var mic = action.GetComponentsInChildren<SpatialActionIcon>(true).SingleOrDefault();
            Require(mic != null && mic.gameObject.activeInHierarchy && mic.Kind == "talk", "The answer control lacks Talk's mic glyph.");
            var labelLeft = verb.textInfo.characterInfo.Take(verb.textInfo.characterCount).Where(glyph => glyph.isVisible)
                .Min(glyph => action.transform.InverseTransformPoint(verb.transform.TransformPoint(glyph.bottomLeft)).x);
            var micPoints = mic!.GetComponentsInChildren<LineRenderer>(true).SelectMany(line =>
            {
                var points = new Vector3[line.positionCount]; line.GetPositions(points);
                return points.Select(point => action.transform.InverseTransformPoint(line.transform.TransformPoint(point)));
            }).ToArray();
            Require(micPoints.Length > 0 && micPoints.Max(point => point.x) < labelLeft
                && micPoints.All(point => Mathf.Abs(point.x) <= box.size.x / 2f && Mathf.Abs(point.y) <= box.size.y / 2f),
                "The mic is not at the label's left inside the target.");
            // The Answer tile is the row's first tile under the panel; the panel holds only Boopy's line.
            Require(action.transform.parent.name == "Control bar", "The Answer tile is not in the row under the panel.");
            Require(!f.Strip.GetComponent<BoxCollider>().bounds.Intersects(box.bounds), "The caption pager overlaps the control.");
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
            // The line and the tile lie in the console's plane: measure them in it.
            var plane = f.Console.transform;
            var lineRect = PlaneRect(plane, lineCorners);
            var controlRect = PlaneRect(plane, BoxCorners(box));
            Require(!lineRect.Intersects(controlRect, 0f), "The dialogue line overlaps the control: " + Describe(lineRect, controlRect));
        }

        // The session's own presentation: Boopy's line under "Boopy", its follow-ups, and its chip on the outlined subject.
        private static void SessionShown(Fixture f, Vector3 sessionHome, string cause)
        {
            Settle(f);
            Require(Get(f.App, "task") == null && !f.Console.TaskShown, cause + " took over the session's presentation.");
            Require(f.Strip.gameObject.activeInHierarchy && f.Strip.FullText == Line && f.Strip.SpeakerText == "Boopy · 1 of 3", cause + " hid Boopy's answer.");
            var chip = SingleChip(f);
            Require(chip.ItemId == SubjectId && Label(chip) == Annotation && (chip.Home - sessionHome).sqrMagnitude < 1e-8f && Overlays(f) == 1,
                cause + " moved or hid the session's chip or outline.");
            LinesHold(f, chip, cause);
            Questions(f, SessionQuestions);
            FirstTile(f, ConsoleAction.Talk, cause);
        }

        // With no anti-aliasing, a line under about one pixel draws nothing where it falls between pixel
        // centers. The subject's outline and the chip's leader hold 1.25 mrad at their farthest point, and
        // the leader stops just outside the outline as seen from the eyes, never on the object's face.
        private static void LinesHold(Fixture f, Chip chip, string when)
        {
            var outline = f.Scene.GetComponentsInChildren<GroundedOverlay>().Single(overlay => overlay.gameObject.activeInHierarchy)
                .GetComponentsInChildren<LineRenderer>(true).Single(line => line.name == "Observed boundary");
            var leader = chip.GetComponentsInChildren<LineRenderer>(true).Single(line => line.name == "Evidence attachment");
            foreach (var line in new[] { outline, leader })
            {
                Require(line.enabled && !line.forceRenderingOff, when + ": the " + line.name + " is hidden.");
                var angle = WidthAngle(f, line);
                Require(angle >= .00125f, when + ": the " + line.name + " is " + (angle * 1000f).ToString("0.00") + " mrad wide, under 1.25.");
            }
            var (inside, gap) = AgainstOutline(f, outline, leader.GetPosition(1));
            Require(!inside && gap <= .008f,
                when + ": the leader ends " + (inside ? "inside" : "outside") + " the outline, " + (gap * 1000f).ToString("0.0") + " mm from it.");
        }

        // The working line on the first frame of the working state: fully visible, one line, its shimmer already
        // on its first glyph and not on its last. After 12 s there is no timer: the strip shows the same words, or
        // the next thinking phrase on its own first frame, and the console header its working words. Returns what
        // is wrong, or null; it runs inside a request, so it never throws.
        private static string? WorkingProblem(Fixture f, string words, string headerWords, string? next = null)
        {
            var first = FirstFrameProblem(f, words);
            if (first != null) return first;
            typeof(DialogueStrip).GetField("stageStartedAt", Flags)!.SetValue(f.Strip, Time.unscaledTime - 12f);
            f.Strip.RefreshVisuals(0f); f.Console.RefreshVisuals(0f);
            if (next != null)
            {
                var after = FirstFrameProblem(f, next);
                if (after != null) return "after a while, the next phrase: " + after;
            }
            else if (f.Strip.VisibleText != words) return "after 12 s the strip shows: " + f.Strip.VisibleText;
            var header = (SpatialSurface)Get(f.Console, "header")!;
            if (header.BodyText != headerWords) return "after 12 s the console header shows: " + header.BodyText;
            return null;
        }

        // With motion the band is on the first glyph and not the last; with reduced motion there is no sweep at all.
        private static string? FirstFrameProblem(Fixture f, string words, bool sweep = true)
        {
            if (f.Strip.Stage != DialogueStage.Working || f.Strip.FullText != words) return "it is " + f.Strip.Stage + ": " + f.Strip.FullText;
            var caption = f.Strip.GetComponentsInChildren<TextMeshPro>(true).Single(text => text.name == "Actual response");
            var info = caption.textInfo;
            var glyphs = Enumerable.Range(0, info.characterCount).Select(index => info.characterInfo[index]).Where(glyph => glyph.isVisible).ToArray();
            if (glyphs.Length < 2) return "it has no glyphs.";
            Color32 Of(TMP_CharacterInfo glyph) => info.meshInfo[glyph.materialReferenceIndex].colors32[glyph.vertexIndex];
            var first = Of(glyphs[0]); var last = Of(glyphs[glyphs.Length - 1]);
            if (caption.alpha < .99f || first.a < 250) return "it is not fully visible on its first frame (alpha " + caption.alpha.ToString("0.00") + ").";
            if (sweep && first.r < last.r + 60) return "it has no shimmer on its first frame (first glyph " + first.r + ", last " + last.r + ").";
            if (!sweep && glyphs.Select(Of).Any(glyph => Mathf.Abs(glyph.r - first.r) > 2))
                return "it sweeps under reduced motion (glyphs " + string.Join(",", glyphs.Select(glyph => Of(glyph).r)) + ").";
            if (f.Strip.VisibleText != words) return "it is not one line: " + f.Strip.VisibleText;
            // Boopy stays whole while it works, from the first frame.
            var companion = (CompanionOrb)Get(f.Console, "companion")!;
            var body = (Transform?)Get(companion, "body");
            var drawn = (float)Get(companion, "opacity")!;
            if (body == null || !body.gameObject.activeInHierarchy || drawn < .99f)
                return "Boopy is not whole on the first working frame (opacity " + drawn.ToString("0.00") + ").";
            return null;
        }

        private static float WidthAngle(Fixture f, LineRenderer line) =>
            line.widthMultiplier / Enumerable.Range(0, line.positionCount).Max(index => Vector3.Distance(f.Eyes.position, line.GetPosition(index)));

        // Whether a point lies inside the drawn outline as seen from the eyes, and its distance from the outline there.
        private static (bool Inside, float Gap) AgainstOutline(Fixture f, LineRenderer outline, Vector3 point)
        {
            N.Vector2 Seen(Vector3 world) { var local = f.Eyes.InverseTransformPoint(world); return new N.Vector2(local.x / local.z, local.y / local.z); }
            var polygon = Enumerable.Range(0, outline.positionCount).Select(index => Seen(outline.GetPosition(index))).ToArray();
            var at = Seen(point);
            var inside = false;
            var nearest = float.PositiveInfinity;
            for (int index = 0, previous = polygon.Length - 1; index < polygon.Length; previous = index++)
            {
                var a = polygon[previous]; var b = polygon[index];
                if ((a.Y > at.Y) != (b.Y > at.Y) && at.X < (b.X - a.X) * (at.Y - a.Y) / (b.Y - a.Y) + a.X) inside = !inside;
                var along = Mathf.Clamp01(N.Vector2.Dot(at - a, b - a) / Mathf.Max(1e-12f, (b - a).LengthSquared()));
                nearest = Mathf.Min(nearest, N.Vector2.Distance(at, a + (b - a) * along));
            }
            return (inside, nearest * Vector3.Distance(f.Eyes.position, point));
        }

        // The recommended action is the row's first tile; every tile has the same style, so position is the only difference.
        private static void FirstTile(Fixture f, ConsoleAction expected, string when)
        {
            var bar = f.Console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Control bar");
            var first = bar.GetComponentsInChildren<SpatialAction>().Where(control => control.gameObject.activeInHierarchy)
                .OrderBy(control => control.transform.localPosition.x).Select(control => control.Action).FirstOrDefault();
            Require(first == expected, when + ": expected " + expected + " as the first tile, found " + first + ".");
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
        private static TextMeshPro Gloss(Chip chip) => chip.GetComponentsInChildren<TextMeshPro>(true).Single(text => text.name == "Gloss");
        // The console's own control; the docked strip keeps its fallback Stop under the same key.
        private static SpatialAction Control(ContextConsole console, ConsoleAction action) =>
            console.GetComponentsInChildren<SpatialAction>(true)
                .Single(control => control.Action == action && control.GetComponentInParent<DialogueStrip>(true) == null);

        // Exactly these controls outside the global bar; the bar itself is checked separately.
        private static readonly string[] SessionQuestions = { "Who placed this marker?", "What does the nearby sign say?" };
        // The line's questions page behind it, one per page; the line's own page offers nothing to ask.
        private static void Questions(Fixture f, params string[] questions)
        {
            Require(f.Strip.Items.SequenceEqual(questions) && f.Strip.ShownItem < 0, "The line's questions do not page behind it: [" + string.Join(", ", f.Strip.Items) + "].");
            Only(f.Console);
        }
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

        internal static SessionView Session(bool grounded = true, bool choice = false)
        {
            var view = new SessionView
            {
                Id = SessionId, State = "review", ReferentId = SubjectId, Model = new ModelRef { Provider = "fixture", Id = "synthetic" },
                Dialogue = new DialogueView { Speaker = "boopy", UtteranceId = "synthetic-turn", At = "1970-01-01T12:00:00Z", Text = Line },
            };
            view.Dialogue.Actions.Add(new ContextualAction { Id = "question-origin", Question = "Who placed this marker?", TargetItemId = SubjectId, ObservationId = ObservationId });
            view.Dialogue.Actions.Add(new ContextualAction { Id = "question-sign", Question = "What does the nearby sign say?", ObservationId = ObservationId });
            if (choice)
            {
                view.Dialogue.Text = "Which one do you mean?";
                view.Dialogue.Choice = new ChoiceCard
                {
                    Id = "choice-subject", Kind = "choice", Prompt = "Which one do you mean?",
                    Options = new List<ChoiceOption>
                    {
                        new ChoiceOption { Id = "option-stone", Label = "The stone", Value = "The stone" },
                        new ChoiceOption { Id = "option-sign", Label = "The sign", Value = "The sign" },
                    },
                };
            }
            view.Utterances.Add(new UtteranceRef { Id = "synthetic-turn", Text = "What is this?", Kind = "ask" });
            view.Observations.Add(new ObservationRef { Id = ObservationId, CapturedAt = "1970-01-01T12:00:00Z" });
            // Low confidence stays visible: the session chip and the task chip read the same.
            view.Items.Add(new Item
            {
                Id = SubjectId, Kind = SubjectKind, Label = Annotation, Gloss = SubjectGloss, Statement = "It may be a stone marker.",
                Origin = "model", Status = "proposed", Confidence = .4f,
                Grounding = grounded
                    ? new Grounding { Kind = "box", ObservationId = ObservationId, Box = new Box2 { X0 = .34f, Y0 = .42f, X1 = .49f, Y1 = .605f } }
                    : new Grounding { Kind = "scene" },
            });
            return view;
        }

        private const string VoiceReply = "{\"type\":\"voice_reply\",\"prompt\":\"Answer.\"}";
        private const string Choice = "{\"type\":\"choice\",\"prompt\":\"Which one?\",\"options\":[{\"id\":\"opt_a\",\"label\":\"The stone\"}]}";
        private const string Step = "{\"type\":\"task_step\",\"text\":\"Look at the base.\",\"evidenceIds\":[\"" + SubjectId + "\"]}";

        /// <summary>The stand-in's parts. The service leaves out a label over 80 or a line over 200 characters.</summary>
        internal static string Parts(bool annotation = true, bool dialogue = true, string? annotationText = null, string? action = VoiceReply) =>
            "[" + string.Join(",", new[]
            {
                "{\"type\":\"subject\",\"sourceId\":\"src_synthetic-observation\",\"maskId\":null}",
                annotation ? "{\"type\":\"annotation\",\"text\":\"" + (annotationText ?? Annotation) + "\",\"evidenceIds\":[\"" + SubjectId + "\"]}" : null,
                dialogue ? "{\"type\":\"dialogue\",\"text\":\"" + (action == VoiceReply ? Asked : Line) + "\",\"evidenceIds\":[\"" + SubjectId + "\"]}" : null,
                action,
                "{\"type\":\"status\",\"code\":\"not-sent\"}",
            }.Where(part => part != null)) + "]";

        internal static string Attempts(params (string Text, bool Uncertain)[] answers) => new JArray(answers.Select((answer, index) => new JObject
        {
            ["eventId"] = "evt_synthetic" + index, ["text"] = answer.Text, ["recognitionUncertain"] = answer.Uncertain, ["kind"] = "practice-attempt",
        })).ToString(Newtonsoft.Json.Formatting.None);

        /// <summary>The view the service's stand-in result produces for the synthetic first turn.</summary>
        internal static string TaskView(int revision = 1, string attempts = "[]", string? components = null, string phase = "open") =>
            "{\"taskId\":\"" + TaskId + "\",\"sessionId\":\"" + SessionId + "\",\"revision\":" + revision +
            ",\"source\":{\"sourceId\":\"src_synthetic-observation\",\"sourceRevision\":1,\"sha256\":\"" + new string('c', 64) + "\"}" +
            ",\"intent\":\"consult_source\",\"utterance\":\"What is this?\",\"phase\":\"" + phase + "\"" +
            ",\"continuity\":\"local-only\",\"delivery\":\"not-sent\",\"subjectCorrected\":false" +
            ",\"components\":" + (components ?? Parts()) +
            ",\"attempts\":" + attempts + ",\"lastRejection\":null}";

        internal static Task<HttpResponseMessage> Reply(HttpStatusCode status, string body) =>
            Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        private static Task<HttpResponseMessage> Drop() => Task.FromException<HttpResponseMessage>(new HttpRequestException("Synthetic dropped reply."));
        // Not a refusal and not a lost connection: the answer's outcome is unknown.
        private static Task<HttpResponseMessage> Fail() => Task.FromException<HttpResponseMessage>(new InvalidOperationException("Synthetic failure."));
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
                Set(App, "thinking", new ThinkingPhrases(PhraseSeed));
                Set(App, "thinkingWithoutPicture", new ThinkingPhrases(PhraseSeed, picture: false));
                Set(App, "recoveryStore", new CaptureRecoveryStore(Path.Combine(directory, "pending-id")));
                Set(App, "handoffRecoveryStore", new HandoffRecoveryStore(Path.Combine(directory, "preparation-identity")));
            }

            /// <summary>The production first turn: capture sent, view applied, the task asked for and presented.
            /// Without a picture it is the person's "Without a photo" turn.</summary>
            public void Start(bool picture = true)
            {
                Set(App, "pending", Snapshot()); Set(App, "pendingEvidence", new EvidenceTurn(!picture));
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
            // Runs as an answer reaches the Mac, before its reply: what the person sees while it waits.
            public Action? OnAnswer;
            // Runs as a task read reaches the Mac, before its reply.
            public Action? OnRead;
            // Runs as the first turn reaches the Mac, before its reply.
            public Action? OnStart;
            // Runs as a later turn reaches the Mac, before its reply (the same session view comes back).
            public Action? OnUtter;
            private readonly List<(string Path, string? Body)> requests = new List<(string, string?)>();
            public int Count(string path) => requests.Count(request => request.Path == path);
            public List<string> Bodies(string path) => requests.Where(request => request.Path == path).Select(request => request.Body ?? "").ToList();

            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel)
            {
                var path = request.RequestUri!.AbsolutePath;
                if (path == "/v1/health") return Reply(HttpStatusCode.OK, Health);
                requests.Add((path, request.Content?.ReadAsStringAsync().GetAwaiter().GetResult()));
                if (request.Method == HttpMethod.Post && path == "/v1/sessions") { OnStart?.Invoke(); return Reply(HttpStatusCode.OK, Wire.Write(SessionView)); }
                if (request.Method == HttpMethod.Post && path == "/v1/sessions/" + SessionId + "/task") return Open.Dequeue()();
                if (request.Method == HttpMethod.Post && path == "/v1/sessions/" + SessionId + "/utterances") { OnUtter?.Invoke(); return Reply(HttpStatusCode.OK, Wire.Write(SessionView)); }
                if (request.Method == HttpMethod.Post && path == "/v1/tasks/" + TaskId + "/answers") { OnAnswer?.Invoke(); return Answers.Dequeue()(); }
                if (request.Method == HttpMethod.Get && path == "/v1/tasks/" + TaskId) { OnRead?.Invoke(); return Read.Dequeue()(); }
                throw new InvalidOperationException("Unexpected synthetic request: " + request.Method + " " + path);
            }
        }

        private static object? Invoke(object target, string name, params object[] args) => target.GetType().GetMethod(name, Flags)!.Invoke(target, args);
        private static void Set(object target, string name, object? value) => target.GetType().GetField(name, Flags)!.SetValue(target, value);
        private static object? Get(object target, string name) => target.GetType().GetField(name, Flags)!.GetValue(target);
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
