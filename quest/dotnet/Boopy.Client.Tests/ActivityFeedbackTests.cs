using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class ActivityFeedbackTests
    {
        [Test]
        public void StopsShowingActivityWhenNeitherRecordingNorRequestIsActive()
        {
            Assert.That(ActivityFeedback.From(false, false), Is.EqualTo(InteractionActivity.Ready));
            Assert.That(ActivityFeedback.From(false, true), Is.EqualTo(InteractionActivity.Thinking));
            Assert.That(ActivityFeedback.From(false, false), Is.EqualTo(InteractionActivity.Ready));
        }

        [Test]
        public void ShowsActualRecordingEvenIfARequestIsStillBeingCleared()
        {
            Assert.That(ActivityFeedback.From(true, false), Is.EqualTo(InteractionActivity.Listening));
            Assert.That(ActivityFeedback.From(true, true), Is.EqualTo(InteractionActivity.Listening));
            Assert.That(ActivityFeedback.From(false, true), Is.EqualTo(InteractionActivity.Thinking));
        }
    }
}
