#nullable enable
using System;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class InteractionPresentationTests
    {
        private const string Sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

        private static string View(string components, string attempts = "[]", string delivery = "not-sent") =>
            "{" +
            "\"taskId\":\"tsk_picture\",\"sessionId\":\"sess_owner\",\"revision\":1," +
            "\"source\":{\"sourceId\":\"src_picture\",\"sourceRevision\":1,\"sha256\":\"" + Sha + "\"}," +
            "\"intent\":\"consult_source\",\"utterance\":\"What is in this picture?\",\"phase\":\"open\"," +
            "\"continuity\":\"local-only\",\"delivery\":\"" + delivery + "\",\"subjectCorrected\":false," +
            "\"components\":" + components + ",\"attempts\":" + attempts + ",\"lastRejection\":null}";

        private const string Proposal =
            "[" +
            "{\"type\":\"subject\",\"sourceId\":\"src_picture\",\"maskId\":null}," +
            "{\"type\":\"annotation\",\"text\":\"Camel\",\"evidenceIds\":[\"ev_picture\"]}," +
            "{\"type\":\"dialogue\",\"text\":\"A camel is in this picture.\",\"evidenceIds\":[\"ev_picture\"]}," +
            "{\"type\":\"voice_reply\",\"prompt\":\"Answer aloud.\"}," +
            "{\"type\":\"status\",\"code\":\"not-sent\"}" +
            "]";

        [Test]
        public void ProposalStaysProposedAndSaysNotSent()
        {
            var view = InteractionPresentation.Read(View(Proposal));
            Assert.That(view.Delivery, Is.EqualTo("not-sent"));
            Assert.That(view.Continuity, Is.EqualTo("local-only"));
            Assert.That(view.Chip, Is.EqualTo("Camel"));
            Assert.That(view.Dialogue, Is.EqualTo("A camel is in this picture."));
            Assert.That(view.SpeakerLine, Is.EqualTo("Boopy · Not sent"));
            Assert.That(view.StatusLine, Is.EqualTo("Not sent"));
            Assert.That(view.AnswerLabel, Is.EqualTo("Answer aloud"));
            var chip = view.ChipItem();
            Assert.That(chip, Is.Not.Null);
            Assert.That(chip!.Status, Is.EqualTo("proposed"));
            Assert.That(chip.Origin, Is.EqualTo("model"));
            Assert.That(view.Action, Is.Not.Null);
            Assert.That(view.Action!.Type, Is.EqualTo("voice_reply"));
        }

        [Test]
        public void ARecordedAnswerStaysNotSent()
        {
            var attempts = "[{\"eventId\":\"evt_answer\",\"text\":\"A camel is in this picture.\",\"recognitionUncertain\":true,\"kind\":\"practice-attempt\"}]";
            var view = InteractionPresentation.Read(View(Proposal, attempts));
            Assert.That(view.Delivery, Is.EqualTo("not-sent"));
            Assert.That(view.SpeakerLine, Is.EqualTo("You · Not sent"));
            Assert.That(view.Caption, Is.EqualTo("A camel is in this picture."));
            Assert.That(view.LastAttempt, Is.Not.Null);
            Assert.That(view.LastAttempt!.RecognitionUncertain, Is.True);
            Assert.That(view.ChipItem()!.Status, Is.EqualTo("proposed"));
        }

        [Test]
        public void ASentDeliveryIsRefused()
        {
            Assert.Throws<ArgumentException>(() => InteractionPresentation.Read(View(Proposal, "[]", "sent")));
        }
    }
}
