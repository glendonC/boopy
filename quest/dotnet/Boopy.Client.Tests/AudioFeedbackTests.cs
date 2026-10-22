using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class AudioFeedbackTests
    {
        [Test]
        public void ANewGroundedInterpretationGetsAnArrivalToneWithoutClaimingConfirmation()
        {
            var view = new SessionView { Id = "synthetic-new", Model = new ModelRef { Id = "fixture" } };
            view.Observations.Add(new ObservationRef { Id = "frame" });
            view.Items.Add(new Item { Id = "object", Status = "proposed", Grounding = new Grounding { ObservationId = "frame" } });
            Assert.That(AudioFeedback.ForTransition(null, view), Is.EqualTo(AudioCue.Ready));
            Assert.That(view.Items[0].Status, Is.EqualTo("proposed"));
            Assert.That(AudioFeedback.ForTransition(view, view), Is.Null);
            view.Observations.Add(new ObservationRef { Id = "correction-frame" });
            Assert.That(AudioFeedback.ForTransition(null, view), Is.Null, "an ungrounded response is not a fresh interpretation");
        }

        [Test]
        public void PlaysSavedOnlyForANewCommittedPackageAndNeverForDuplicateResponses()
        {
            var previous = new SessionView { Id = "synthetic-session" };
            var saved = new SessionView { Id = previous.Id, State = "committed",
                Committed = new Committed { PackageId = "synthetic-package" } };
            Assert.That(AudioFeedback.ForTransition(previous, saved), Is.EqualTo(AudioCue.Saved));
            Assert.That(AudioFeedback.ForTransition(saved, saved), Is.Null);
            var repeated = Wire.Read<SessionView>(Wire.Write(saved));
            Assert.That(AudioFeedback.ForTransition(saved, repeated), Is.Null);
            var missingReceipt = new SessionView { Id = previous.Id, State = "committed" };
            Assert.That(AudioFeedback.ForTransition(previous, missingReceipt), Is.Null);
            missingReceipt.Committed = new Committed { PackageId = "" };
            Assert.That(AudioFeedback.ForTransition(previous, missingReceipt), Is.Null);
        }

        [Test]
        public void AcknowledgesOnlyAnExistingItemChangingFromProposedToConfirmed()
        {
            var previous = new SessionView { Id = "synthetic-session" };
            previous.Items.Add(new Item { Id = "synthetic-detail", Status = "proposed", Confidence = 1f });
            var returned = Wire.Read<SessionView>(Wire.Write(previous));
            Assert.That(AudioFeedback.ForTransition(previous, returned), Is.Null, "confidence is not confirmation");
            returned.Items[0].Status = "confirmed";
            Assert.That(AudioFeedback.ForTransition(previous, returned), Is.EqualTo(AudioCue.Confirm));
            Assert.That(AudioFeedback.ForTransition(returned, returned), Is.Null);
            var repeated = Wire.Read<SessionView>(Wire.Write(returned));
            Assert.That(AudioFeedback.ForTransition(returned, repeated), Is.Null);
        }

        [Test]
        public void DoesNotSoundSuccessForInitialDisplaysNewItemsOrDifferentSessions()
        {
            var previous = new SessionView { Id = "synthetic-session" };
            var returned = new SessionView { Id = previous.Id };
            returned.Items.Add(new Item { Id = "new-detail", Status = "confirmed", Origin = "person" });
            Assert.That(AudioFeedback.ForTransition(previous, returned), Is.Null);
            returned.Committed = new Committed { PackageId = "existing-package" };
            returned.State = "committed";
            Assert.That(AudioFeedback.ForTransition(null, returned), Is.Null);
            previous.Id = "different-session";
            Assert.That(AudioFeedback.ForTransition(previous, returned), Is.Null);
        }

        [Test]
        public void GivesTheSaveReceiptPriorityOverIndividualConfirmation()
        {
            var previous = new SessionView { Id = "synthetic-session" };
            previous.Items.Add(new Item { Id = "detail", Status = "proposed" });
            var returned = Wire.Read<SessionView>(Wire.Write(previous));
            returned.Items[0].Status = "confirmed";
            returned.State = "committed";
            returned.Committed = new Committed { PackageId = "new-package" };
            Assert.That(AudioFeedback.ForTransition(previous, returned), Is.EqualTo(AudioCue.Saved));
        }
    }
}
