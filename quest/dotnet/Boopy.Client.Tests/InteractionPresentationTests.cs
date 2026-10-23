#nullable enable
using System;
using System.Linq;
using Boopy.Client;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class InteractionPresentationTests
    {
        private const string Sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

        private static string OpenSave() => View(
            "tsk_sahara_later", "continue_saved_task", "src_sahara_still",
            "Sahara. Save it. Korean later.", 0, false,
            "[{ \"type\": \"status\", \"code\": \"not-sent\" }]");

        private static string Lesson() => View(
            "tsk_sahara_later", "continue_saved_task", "src_sahara_still",
            "Sahara. Save it. Korean later.", 1, false,
            "[" +
            "{ \"type\": \"subject\", \"sourceId\": \"src_sahara_still\", \"maskId\": \"msk_camel\" }," +
            "{ \"type\": \"annotation\", \"text\": \"Camel\", \"evidenceIds\": [\"ev_camel\"] }," +
            "{ \"type\": \"dialogue\", \"text\": \"이 사진에 뭐가 있어요?\", \"evidenceIds\": [\"ev_camel\"] }," +
            "{ \"type\": \"voice_reply\", \"prompt\": \"Answer aloud about this picture.\" }," +
            "{ \"type\": \"agent_presence\", \"mode\": \"engaged\" }," +
            "{ \"type\": \"status\", \"code\": \"not-sent\" }" +
            "]");

        private static string StepTask() => View(
            "tsk_manual", "consult_source", "src_device_label",
            "What does this label say?", 1, false,
            "[" +
            "{ \"type\": \"annotation\", \"text\": \"Label\", \"evidenceIds\": [\"ev_label\"] }," +
            "{ \"type\": \"task_step\", \"text\": \"Turn the box over.\", \"evidenceIds\": [\"ev_label\"] }," +
            "{ \"type\": \"status\", \"code\": \"not-sent\" }" +
            "]");

        private static string Manual() => View(
            "tsk_manual", "consult_source", "src_device_label",
            "What does this label say?", 1, false,
            "[" +
            "{ \"type\": \"subject\", \"sourceId\": \"src_device_label\", \"maskId\": null }," +
            "{ \"type\": \"annotation\", \"text\": \"Label\", \"evidenceIds\": [\"ev_label\"] }," +
            "{ \"type\": \"dialogue\", \"text\": \"The label is unread.\", \"evidenceIds\": [\"ev_label\"] }," +
            "{ \"type\": \"choice\", \"prompt\": \"Read it again?\", \"options\": [{ \"id\": \"opt_retry\", \"label\": \"Try again\" }] }," +
            "{ \"type\": \"status\", \"code\": \"not-sent\" }" +
            "]");

        private static string WrongItem() => View(
            "tsk_sahara_later", "continue_saved_task", "src_sahara_still",
            "Sahara. Save it. Korean later.", 2, true,
            "[{ \"type\": \"status\", \"code\": \"wrong-item\" }]");

        private static string View(
            string taskId, string intent, string sourceId, string utterance, int revision, bool subjectCorrected, string components,
            string attempts = "[]", string phase = "open") =>
            "{" +
            $"\"taskId\":\"{taskId}\",\"sessionId\":\"sess_owner\",\"revision\":{revision}," +
            $"{{\"sourceId\":\"{sourceId}\",\"sourceRevision\":1,\"sha256\":\"{Sha}\"}}".Insert(0, "\"source\":") +
            $",\"intent\":\"{intent}\",\"utterance\":\"{utterance}\",\"phase\":\"{phase}\"," +
            "\"continuity\":\"local-only\",\"delivery\":\"not-sent\"," +
            $"\"subjectCorrected\":{(subjectCorrected ? "true" : "false")}," +
            $"\"components\":{components},\"attempts\":{attempts},\"lastRejection\":null" +
            "}";

        private const string LessonComponents = "[" +
            "{ \"type\": \"subject\", \"sourceId\": \"src_sahara_still\", \"maskId\": \"msk_camel\" }," +
            "{ \"type\": \"annotation\", \"text\": \"Camel\", \"evidenceIds\": [\"ev_camel\"] }," +
            "{ \"type\": \"dialogue\", \"text\": \"이 사진에 뭐가 있어요?\", \"evidenceIds\": [\"ev_camel\"] }," +
            "{ \"type\": \"voice_reply\", \"prompt\": \"Answer aloud about this picture.\" }," +
            "{ \"type\": \"status\", \"code\": \"not-sent\" }" +
            "]";

        // The second answer is a whole timestamp on purpose: a person's words stay text, never a parsed date.
        private const string FirstAttempt =
            "{\"eventId\":\"evt_first\",\"text\":\"낙타예요\",\"recognitionUncertain\":false,\"kind\":\"practice-attempt\"}";
        private const string SecondAttempt =
            "{\"eventId\":\"evt_second\",\"text\":\"1970-01-01T00:00:00.000Z\",\"recognitionUncertain\":true,\"kind\":\"practice-attempt\"}";

        private static string Without(string json, string type)
        {
            var body = JObject.Parse(json);
            foreach (var component in ((JArray)body["components"]!).Where(component => (string?)component["type"] == type).ToList())
                component.Remove();
            return body.ToString();
        }

        private static string Answered(string attempts, int revision = 2) => View(
            "tsk_sahara_later", "continue_saved_task", "src_sahara_still",
            "Sahara. Save it. Korean later.", revision, false, LessonComponents, attempts);

        private static string WithPrompt(string prompt)
        {
            var body = JObject.Parse(Lesson());
            body["components"]![3]!["prompt"] = prompt;
            return body.ToString();
        }

        [Test]
        public void OpenSave_DoesNotInventALesson()
        {
            var view = InteractionPresentation.Read(OpenSave());
            Assert.That(view.TargetId, Is.EqualTo("src_sahara_still"));
            Assert.That(view.Utterance, Is.EqualTo("Sahara. Save it. Korean later."));
            Assert.That(view.Chip, Is.EqualTo(""));
            Assert.That(view.Dialogue, Is.EqualTo(""));
            Assert.That(view.Action, Is.Null);
            Assert.That(view.ChipItem(), Is.Null);
            Assert.That(view.StatusLine, Is.EqualTo("Not sent"));
            Assert.That(view.Continuity, Is.EqualTo("local-only"));
            Assert.That(view.Delivery, Is.EqualTo("not-sent"));
            Assert.That(view.Intent, Is.EqualTo("continue_saved_task"));
        }

        [Test]
        public void ProjectsSubjectChipDialogueAndVoiceReply()
        {
            var view = InteractionPresentation.Read(Lesson());
            Assert.That(view.TargetId, Is.EqualTo("src_sahara_still"));
            Assert.That(view.Chip, Is.EqualTo("Camel"));
            Assert.That(view.Dialogue, Is.EqualTo("이 사진에 뭐가 있어요?"));
            var chip = view.ChipItem();
            Assert.That(chip, Is.Not.Null);
            Assert.That(chip!.Id, Is.EqualTo("src_sahara_still"));
            Assert.That(chip.Label, Is.EqualTo("Camel"));
            Assert.That(chip.Status, Is.EqualTo("proposed"));
            Assert.That(chip.Origin, Is.EqualTo("model"));
            Assert.That(chip.Confidence, Is.Null);
            Assert.That(chip.Gloss, Is.Null);
            Assert.That(chip.Statement, Is.EqualTo(""));
            Assert.That(view.Action, Is.Not.Null);
            Assert.That(view.Action!.Type, Is.EqualTo("voice_reply"));
            Assert.That(view.Action.Label, Is.EqualTo("Answer aloud about this picture."));
            Assert.That(view.StatusLine, Is.EqualTo("Not sent"));
            Assert.That(view.Continuity, Is.EqualTo("local-only"));
            Assert.That(view.Delivery, Is.EqualTo("not-sent"));
        }

        [Test]
        public void ConsultSourceProjectsChoice()
        {
            var view = InteractionPresentation.Read(Manual());
            Assert.That(view.TargetId, Is.EqualTo("src_device_label"));
            Assert.That(view.Chip, Is.EqualTo("Label"));
            Assert.That(view.ChipItem()!.Label, Is.EqualTo("Label"));
            Assert.That(view.ChipItem()!.Id, Is.EqualTo(view.TargetId));
            Assert.That(view.Dialogue, Is.EqualTo("The label is unread."));
            Assert.That(view.Action, Is.Not.Null);
            Assert.That(view.Action!.Type, Is.EqualTo("choice"));
            Assert.That(view.Action.Label, Is.EqualTo("Try again"));
            Assert.That(view.Utterance, Is.EqualTo("What does this label say?"));
            Assert.That(view.Intent, Is.EqualTo("consult_source"));
        }

        [Test]
        public void ChoiceKeepsUpToThreeOptions()
        {
            var one = InteractionPresentation.Read(Manual());
            Assert.That(one.Action, Is.Not.Null);
            Assert.That(one.Action!.Type, Is.EqualTo("choice"));
            Assert.That(one.Action.Label, Is.EqualTo("Try again"));
            Assert.That(one.Action.OptionLabels, Is.EqualTo(new[] { "Try again" }));

            var two = InteractionPresentation.Read(ChoiceWith("Try again", "Check the seal"));
            Assert.That(two.Action, Is.Not.Null);
            Assert.That(two.Action!.Type, Is.EqualTo("choice"));
            Assert.That(two.Action.OptionLabels, Is.EqualTo(new[] { "Try again", "Check the seal" }));

            var three = InteractionPresentation.Read(ChoiceWith("Try again", "Check the seal", "Stop here"));
            Assert.That(three.Action, Is.Not.Null);
            Assert.That(three.Action!.Type, Is.EqualTo("choice"));
            Assert.That(three.Action.OptionLabels, Is.EqualTo(new[] { "Try again", "Check the seal", "Stop here" }));

            Assert.Throws<ArgumentException>(() => InteractionPresentation.Read(ChoiceWith()));
            Assert.Throws<ArgumentException>(() => InteractionPresentation.Read(ChoiceWith("One", "Two", "Three", "Four")));
        }

        private static string ChoiceWith(params string[] labels)
        {
            var options = new JArray();
            for (var index = 0; index < labels.Length; index++)
                options.Add(new JObject { ["id"] = "opt_" + (index + 1), ["label"] = labels[index] });
            var body = JObject.Parse(Manual());
            foreach (var component in (JArray)body["components"]!)
            {
                if (component?["type"]?.Value<string>() == "choice")
                    component["options"] = options;
            }
            return body.ToString();
        }

        [Test]
        public void SameSourceKeepsTheSameTarget()
        {
            var first = InteractionPresentation.Read(Lesson());
            var body = JObject.Parse(Lesson());
            body["components"]![1]!["text"] = "Dune";
            body["components"]![2]!["text"] = "What is in this picture?";
            var changed = InteractionPresentation.Read(body.ToString());
            Assert.That(changed.TargetId, Is.EqualTo(first.TargetId));
            Assert.That(changed.TargetId, Is.EqualTo("src_sahara_still"));
            Assert.That(changed.Chip, Is.EqualTo("Dune"));
            Assert.That(changed.Dialogue, Is.EqualTo("What is in this picture?"));
            Assert.That(changed.Sha256, Is.EqualTo(first.Sha256));
            Assert.That(changed.SourceRevision, Is.EqualTo(first.SourceRevision));
        }

        [Test]
        public void WrongSubjectClearsDependentTextAndKeepsDigest()
        {
            var view = InteractionPresentation.Read(WrongItem());
            Assert.That(view.TargetId, Is.EqualTo("src_sahara_still"));
            Assert.That(view.SourceRevision, Is.EqualTo(1));
            Assert.That(view.Sha256, Is.EqualTo(Sha));
            Assert.That(view.Chip, Is.EqualTo(""));
            Assert.That(view.Dialogue, Is.EqualTo(""));
            Assert.That(view.Action, Is.Null);
            Assert.That(view.ChipItem(), Is.Null);
            Assert.That(view.StatusLine, Is.EqualTo("Wrong item"));
            Assert.That(view.Utterance, Is.EqualTo("Sahara. Save it. Korean later."));
        }

        [Test]
        public void RejectsClaimedContinuityAndASecondDialogue()
        {
            var claimed = JObject.Parse(Lesson());
            claimed["continuity"] = "grok-bot";
            Assert.Throws<ArgumentException>(() => InteractionPresentation.Read(claimed.ToString()));

            var twoLines = JObject.Parse(Lesson());
            ((JArray)twoLines["components"]!).Add(JObject.Parse("{ \"type\": \"dialogue\", \"text\": \"Another line.\", \"evidenceIds\": [\"ev_camel\"] }"));
            Assert.Throws<ArgumentException>(() => InteractionPresentation.Read(twoLines.ToString()));

            var twoSubjects = JObject.Parse(Lesson());
            ((JArray)twoSubjects["components"]!).Add(JObject.Parse("{ \"type\": \"subject\", \"sourceId\": \"src_sahara_still\", \"maskId\": null }"));
            Assert.Throws<ArgumentException>(() => InteractionPresentation.Read(twoSubjects.ToString()));

            var twoActions = JObject.Parse(Lesson());
            ((JArray)twoActions["components"]!).Add(JObject.Parse("{ \"type\": \"choice\", \"prompt\": \"Read it again?\", \"options\": [{ \"id\": \"opt_retry\", \"label\": \"Try again\" }] }"));
            Assert.Throws<ArgumentException>(() => InteractionPresentation.Read(twoActions.ToString()));

            var widget = JObject.Parse(Lesson());
            ((JArray)widget["components"]!).Add(JObject.Parse("{ \"type\": \"korean_widget\", \"text\": \"lesson\" }"));
            Assert.Throws<ArgumentException>(() => InteractionPresentation.Read(widget.ToString()));
        }

        [Test]
        public void BothIntentsShareOneProjectionShape()
        {
            var practice = InteractionPresentation.Read(Lesson());
            var manual = InteractionPresentation.Read(Manual());
            Assert.That(practice.Intent, Is.EqualTo("continue_saved_task"));
            Assert.That(manual.Intent, Is.EqualTo("consult_source"));
            Assert.That(practice.Action, Is.Not.Null);
            Assert.That(manual.Action, Is.Not.Null);
            Assert.That(practice.Action!.Type, Is.EqualTo("voice_reply"));
            Assert.That(manual.Action!.Type, Is.EqualTo("choice"));
            Assert.That(practice.Action.Label, Is.EqualTo("Answer aloud about this picture."));
            Assert.That(manual.Action.Label, Is.EqualTo("Try again"));
            Assert.That(practice.Chip, Is.Not.Empty);
            Assert.That(manual.Chip, Is.Not.Empty);
            Assert.That(practice.Dialogue, Is.Not.Empty);
            Assert.That(manual.Dialogue, Is.Not.Empty);
            Assert.That(practice.Continuity, Is.EqualTo(manual.Continuity));
            Assert.That(practice.Delivery, Is.EqualTo(manual.Delivery));
            Assert.That(practice.StatusLine, Is.EqualTo("Not sent"));
            Assert.That(manual.StatusLine, Is.EqualTo("Not sent"));
            Assert.That(practice.Action.GetType(), Is.EqualTo(manual.Action.GetType()));
        }

        [Test]
        public void ExposesTheTaskIdentityRevisionAndPhase()
        {
            var view = InteractionPresentation.Read(Lesson());
            Assert.That(view.TaskId, Is.EqualTo("tsk_sahara_later"));
            Assert.That(view.SessionId, Is.EqualTo("sess_owner"));
            Assert.That(view.Revision, Is.EqualTo(1));
            Assert.That(view.Phase, Is.EqualTo("open"));
            Assert.That(InteractionPresentation.Read(WrongItem()).Revision, Is.EqualTo(2));
            var cancelled = InteractionPresentation.Read(View(
                "tsk_sahara_later", "continue_saved_task", "src_sahara_still",
                "Sahara. Save it. Korean later.", 3, false, LessonComponents, phase: "cancelled"));
            Assert.That(cancelled.Phase, Is.EqualTo("cancelled"));
        }

        [Test]
        public void TheAnnotationEvidenceNamesTheChipSubject()
        {
            Assert.That(InteractionPresentation.Read(Lesson()).AnnotationEvidenceIds, Is.EqualTo(new[] { "ev_camel" }));
            Assert.That(InteractionPresentation.Read(Manual()).AnnotationEvidenceIds, Is.EqualTo(new[] { "ev_label" }));
            Assert.That(InteractionPresentation.Read(OpenSave()).AnnotationEvidenceIds, Is.Empty, "No annotation, no chip subject.");
            Assert.That(InteractionPresentation.Read(WrongItem()).AnnotationEvidenceIds, Is.Empty, "A wrong item names no subject.");
        }

        [Test]
        public void TheLastAttemptIsTheNewestAnswerKeptExactly()
        {
            Assert.That(InteractionPresentation.Read(Lesson()).LastAttempt, Is.Null);
            var view = InteractionPresentation.Read(Answered("[" + FirstAttempt + "," + SecondAttempt + "]", 3));
            Assert.That(view.LastAttempt, Is.Not.Null);
            Assert.That(view.LastAttempt!.Text, Is.EqualTo("1970-01-01T00:00:00.000Z"), "The words are text, never a parsed date.");
            Assert.That(view.LastAttempt.RecognitionUncertain, Is.True);
            var certain = InteractionPresentation.Read(Answered("[" + FirstAttempt + "]"));
            Assert.That(certain.LastAttempt!.Text, Is.EqualTo("낙타예요"));
            Assert.That(certain.LastAttempt.RecognitionUncertain, Is.False);
        }

        [Test]
        public void ATaskViewReadsBoopyNotSentWithItsDialogueAndOneAnswerControl()
        {
            var view = InteractionPresentation.Read(Lesson());
            Assert.That(view.SpeakerLine, Is.EqualTo("Boopy · Not sent"));
            Assert.That(view.Caption, Is.EqualTo("이 사진에 뭐가 있어요?"));
            Assert.That(view.AnswerLabel, Is.EqualTo("Answer aloud about this picture"));
            var save = InteractionPresentation.Read(OpenSave());
            Assert.That(save.SpeakerLine, Is.EqualTo("Boopy · Not sent"), "An open save still says it was not sent.");
            Assert.That(save.Caption, Is.EqualTo(""));
            Assert.That(save.AnswerLabel, Is.Null);
        }

        [Test]
        public void AnUncertainAnswerReadsYouAsHeardNotSentWithTheWordsExactly()
        {
            var view = InteractionPresentation.Read(Answered("[" + FirstAttempt + "," + SecondAttempt + "]", 3));
            Assert.That(view.SpeakerLine, Is.EqualTo("You, as heard · Not sent"), "Uncertain recognition stays visible.");
            Assert.That(view.Caption, Is.EqualTo("1970-01-01T00:00:00.000Z"));
            Assert.That(view.AnswerLabel, Is.Null, "The line shows the person's answer, so the answer control goes away.");
            Assert.That(view.Dialogue, Is.EqualTo("이 사진에 뭐가 있어요?"), "Boopy's line stays on the task.");
            Assert.That(view.ChipItem()!.Status, Is.EqualTo("proposed"), "Answering does not confirm the annotation.");
        }

        [Test]
        public void ACertainAnswerReadsYouNotSent()
        {
            var view = InteractionPresentation.Read(Answered("[" + SecondAttempt + "," + FirstAttempt + "]", 3));
            Assert.That(view.SpeakerLine, Is.EqualTo("You · Not sent"));
            Assert.That(view.Caption, Is.EqualTo("낙타예요"));
        }

        [Test]
        public void OnlyAChipWithBoopysLineOrARecordedAnswerIsPresented()
        {
            Assert.That(InteractionPresentation.Read(Lesson()).Presentable, Is.True);
            Assert.That(InteractionPresentation.Read(Manual()).Presentable, Is.True);
            Assert.That(InteractionPresentation.Read(Without(Lesson(), "dialogue")).Presentable, Is.False,
                "Boopy's line was too long for the task: the session keeps its own line.");
            Assert.That(InteractionPresentation.Read(Without(Lesson(), "annotation")).Presentable, Is.False,
                "The label was too long for the task: the session keeps its own chip and outline.");
            Assert.That(InteractionPresentation.Read(OpenSave()).Presentable, Is.False);
            Assert.That(InteractionPresentation.Read(WrongItem()).Presentable, Is.False);
            foreach (var partial in new[] { Without(Lesson(), "dialogue"), Without(Lesson(), "annotation"), OpenSave(), WrongItem() })
            {
                var answered = JObject.Parse(partial);
                answered["attempts"] = JArray.Parse("[" + FirstAttempt + "]");
                Assert.That(InteractionPresentation.Read(answered.ToString()).Presentable, Is.True, "A recorded answer is the task's own line.");
            }
        }

        [Test]
        public void AWrongItemReadsWrongItemWithNoChipAndNoControl()
        {
            var body = JObject.Parse(WrongItem());
            body["attempts"] = JArray.Parse("[" + FirstAttempt + "]");
            var view = InteractionPresentation.Read(body.ToString());
            Assert.That(view.Caption, Is.EqualTo("Wrong item."));
            Assert.That(view.SpeakerLine, Is.EqualTo("Boopy · Not sent"));
            Assert.That(view.AnswerLabel, Is.Null);
            Assert.That(view.ChipItem(), Is.Null);
            Assert.That(view.LastAttempt!.Text, Is.EqualTo("낙타예요"), "The recorded answer stays on the task.");
        }

        [TestCase("Answer aloud.", "Answer aloud")]
        [TestCase("Answer aloud", "Answer aloud")]
        [TestCase("Answer aloud..", "Answer aloud.")]
        [TestCase("이 사진에 대해 말해 보세요.", "이 사진에 대해 말해 보세요")]
        [TestCase("What do you see?", "What do you see?")]
        public void TheAnswerControlDropsOneTrailingPeriod(string prompt, string label)
        {
            var view = InteractionPresentation.Read(WithPrompt(prompt));
            Assert.That(view.AnswerLabel, Is.EqualTo(label));
            Assert.That(view.Action!.Label, Is.EqualTo(prompt), "The prompt itself is kept as sent.");
        }

        [Test]
        public void OnlyAnOpenVoiceReplyGetsAControl()
        {
            Assert.That(InteractionPresentation.Read(Manual()).AnswerLabel, Is.Null, "A choice has no person action in protocol v1.");
            var step = InteractionPresentation.Read(StepTask());
            Assert.That(step.Action!.Type, Is.EqualTo("task_step"));
            Assert.That(step.AnswerLabel, Is.Null, "A task step has no person action in protocol v1.");
            var cancelled = InteractionPresentation.Read(View(
                "tsk_sahara_later", "continue_saved_task", "src_sahara_still",
                "Sahara. Save it. Korean later.", 3, false, LessonComponents, phase: "cancelled"));
            Assert.That(cancelled.AnswerLabel, Is.Null, "A cancelled task takes no answer.");
            Assert.That(cancelled.Caption, Is.EqualTo("이 사진에 뭐가 있어요?"));
        }

        private static readonly Action<JObject>[] MalformedTaskFields =
        {
            view => view.Remove("taskId"),
            view => view["taskId"] = 7,
            view => view["taskId"] = "",
            view => view.Remove("sessionId"),
            view => view.Remove("revision"),
            view => view["revision"] = -1,
            view => view["revision"] = "1",
            view => view["revision"] = 1.5,
            view => view["revision"] = 1_000_001,
            view => view["revision"] = 1L << 40,
            view => view.Remove("phase"),
            view => view["phase"] = "closed",
            view => view.Remove("attempts"),
            view => view["attempts"] = new JObject(),
            view => view["attempts"] = JArray.Parse("[{\"eventId\":\"evt_x\",\"recognitionUncertain\":false,\"kind\":\"practice-attempt\"}]"),
            view => view["attempts"] = JArray.Parse("[{\"eventId\":\"evt_x\",\"text\":\"\",\"recognitionUncertain\":false,\"kind\":\"practice-attempt\"}]"),
            view => view["attempts"] = JArray.Parse("[{\"eventId\":\"evt_x\",\"text\":\"Camel\",\"recognitionUncertain\":\"no\",\"kind\":\"practice-attempt\"}]"),
            view => view["attempts"] = JArray.Parse("[{\"eventId\":\"evt_x\",\"text\":\"Camel\",\"recognitionUncertain\":false,\"kind\":\"verified-answer\"}]"),
            view => view["attempts"] = JArray.Parse("[{\"text\":\"Camel\",\"recognitionUncertain\":false,\"kind\":\"practice-attempt\"}]"),
            view => view["attempts"] = JArray.Parse("[\"Camel\"]"),
            view => ((JObject)view["components"]![1]!).Remove("evidenceIds"),
            view => view["components"]![1]!["evidenceIds"] = new JArray(),
            view => view["components"]![1]!["evidenceIds"] = new JArray(7),
            view => view["components"]![1]!["evidenceIds"] = new JArray(""),
            view => view["components"]![1]!["evidenceIds"] = new JArray("a", "b", "c", "d", "e"),
        };

        [Test]
        public void RejectsMalformedTaskFields([Range(0, 24)] int change)
        {
            var body = JObject.Parse(Lesson());
            MalformedTaskFields[change](body);
            Assert.Throws<ArgumentException>(() => InteractionPresentation.Read(body.ToString()));
        }

        [Test]
        public void RejectsAmbiguousOrTrailingJson()
        {
            var twice = Lesson().Replace("\"delivery\":\"not-sent\"", "\"delivery\":\"sent\",\"delivery\":\"not-sent\"");
            Assert.That(twice, Does.Contain("\"delivery\":\"sent\""));
            Assert.Throws<ArgumentException>(() => InteractionPresentation.Read(twice), "A repeated field is refused, never resolved.");
            Assert.Throws<ArgumentException>(() => InteractionPresentation.Read(Lesson() + " {}"));
            Assert.Throws<ArgumentException>(() => InteractionPresentation.Read("[" + Lesson() + "]"));
            Assert.Throws<ArgumentException>(() => InteractionPresentation.Read("null"));
            Assert.Throws<ArgumentException>(() => InteractionPresentation.Read("<html>busy</html>"));
        }
    }
}
