using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class CompanionExpressionTests
    {
        [TestCase("idle")]
        [TestCase("listening")]
        [TestCase("processing")]
        [TestCase("review")]
        [TestCase("saved")]
        [TestCase("error")]
        [TestCase("heard")]
        [TestCase("not-heard")]
        [TestCase("unclear")]
        public void ReducedMotionKeepsStateExpressionWithoutTimeDrivenMovement(string state)
        {
            var first = CompanionExpression.At(state, 0f, 0f, true);
            var later = CompanionExpression.At(state, 13.1f, 8f, true);
            Assert.That(later.Lift, Is.EqualTo(first.Lift));
            Assert.That(later.Pitch, Is.EqualTo(first.Pitch));
            Assert.That(later.Roll, Is.EqualTo(first.Roll));
            Assert.That(later.LeftEye, Is.EqualTo(first.LeftEye));
            Assert.That(later.RightEye, Is.EqualTo(first.RightEye));
            Assert.That(later.LeftShoulder, Is.EqualTo(first.LeftShoulder));
            Assert.That(later.RightShoulder, Is.EqualTo(first.RightShoulder));
            Assert.That(later.RightElbow, Is.EqualTo(first.RightElbow));
            Assert.That(later.RightWrist, Is.EqualTo(first.RightWrist));
            Assert.That(later.Smile, Is.EqualTo(first.Smile));
        }

        [Test]
        public void AttentionAndTransientMotionRemainWithinCompanionEnvelope()
        {
            foreach (var state in new[] { "idle", "listening", "processing", "review", "saved", "error", "heard", "not-heard", "unclear" })
            for (var tick = 0; tick < 600; tick++)
            {
                var expression = CompanionExpression.At(state, tick / 30f, tick / 30f, false, 100f, -100f);
                Assert.That(expression.Lift, Is.InRange(-.002f, .011f));
                Assert.That(expression.Yaw, Is.InRange(-9f, 9f));
                Assert.That(expression.LeftEye, Is.InRange(.035f, 1f));
                Assert.That(expression.RightEye, Is.InRange(.035f, 1f));
                Assert.That(expression.LookX, Is.InRange(-.24f, .24f));
                Assert.That(expression.LookY, Is.InRange(-.18f, .18f));
            }
        }

        // What Boopy heard in an answer shows on its body (DESIGN): a hop when it heard the word, a point at the word when it
        // did not, a tilt toward the person when it heard no word of the language at all. Never a grade.
        [Test]
        public void HeardHopsOnceAndReducedMotionKeepsOnlyTheEyes()
        {
            var hop = CompanionExpression.At("heard", 3f, .25f, false);
            Assert.That(hop.Lift, Is.GreaterThan(.003f));
            Assert.That(hop.Smile, Is.EqualTo(1f));
            Assert.That(CompanionExpression.At("heard", 3f, 1f, false).Lift, Is.LessThan(.001f), "One hop, then still.");
            var reduced = CompanionExpression.At("heard", 3f, .25f, true);
            var rest = CompanionExpression.At("review", 3f, .25f, true);
            Assert.That((reduced.Lift, reduced.Pitch, reduced.Roll, reduced.RightShoulder), Is.EqualTo((rest.Lift, rest.Pitch, rest.Roll, rest.RightShoulder)));
            Assert.That(reduced.LeftEye, Is.LessThan(rest.LeftEye), "Reduced motion: only the eyes smile.");
        }

        [Test]
        public void NotHeardPointsAtTheWord()
        {
            var right = CompanionExpression.At("not-heard", 3f, .3f, false, .8f, .2f);
            Assert.That(right.RightShoulder, Is.GreaterThanOrEqualTo(100f));
            Assert.That(right.RightElbow, Is.LessThanOrEqualTo(30f));
            Assert.That(right.LookX, Is.GreaterThan(.1f), "It looks where it points.");
            Assert.That(right.Yaw, Is.GreaterThan(5f));
        }

        [Test]
        public void UnclearTiltsTowardThePerson()
        {
            var unsure = CompanionExpression.At("unclear", 3f, .3f, false, .8f, .2f);
            Assert.That(System.Math.Abs(unsure.Roll), Is.GreaterThanOrEqualTo(8f));
            Assert.That(unsure.LookX, Is.EqualTo(0f), "It looks at the person, not at the picture.");
            Assert.That(unsure.Yaw, Is.EqualTo(0f));
        }

        [Test]
        public void InvalidAttentionDoesNotProduceInvalidPoseAndUnknownStateIsRefused()
        {
            var expression = CompanionExpression.At("idle", float.NaN, float.PositiveInfinity, false,
                float.NaN, float.NegativeInfinity);
            Assert.That(expression.Yaw, Is.EqualTo(0f));
            Assert.That(expression.LookX, Is.EqualTo(0f));
            Assert.That(expression.LookY, Is.EqualTo(0f));
            Assert.Throws<System.ArgumentOutOfRangeException>(() => CompanionExpression.At("inferred success", 0, 0, true));
        }

        [Test]
        public void RealEnergyProducesBoundedSpeechPoseAndZeroRestoresActualState()
        {
            var baseline = CompanionExpression.At("review", 2f, 2f, false);
            var quiet = CompanionExpression.At("review", 2f, 2f, false, speakingActivity: .1f);
            var loud = CompanionExpression.At("review", 2f, 2f, false, speakingActivity: 1f);
            Assert.That(loud.Lift, Is.GreaterThan(quiet.Lift));
            Assert.That(loud.Lift, Is.LessThanOrEqualTo(.0025f + 1e-7f));
            Assert.That(loud.Pitch, Is.EqualTo(-9f));
            Assert.That(loud.LeftEye, Is.EqualTo(1f));
            Assert.That(loud.Smile, Is.EqualTo(.12f));
            var ended = CompanionExpression.At("review", 2f, 2f, false, speakingActivity: 0f);
            Assert.That(ended.Lift, Is.EqualTo(baseline.Lift));
            Assert.That(ended.Pitch, Is.EqualTo(baseline.Pitch));
            Assert.That(ended.Smile, Is.EqualTo(baseline.Smile));
        }
        [Test]
        public void ReducedSpeechPoseIgnoresTimeAndEnergyMagnitudeButIsDistinct()
        {
            var quiet = CompanionExpression.At("review", 0f, 0f, true, speakingActivity: .01f);
            var loudLater = CompanionExpression.At("review", 91f, 91f, true, speakingActivity: 1f);
            Assert.That(loudLater.Lift, Is.EqualTo(quiet.Lift));
            Assert.That(loudLater.Pitch, Is.EqualTo(quiet.Pitch));
            Assert.That(loudLater.Roll, Is.EqualTo(quiet.Roll));
            Assert.That(loudLater.Stretch, Is.EqualTo(quiet.Stretch));
            Assert.That(loudLater.Smile, Is.EqualTo(quiet.Smile));
            Assert.That(quiet.Pitch, Is.Not.EqualTo(CompanionExpression.At("review", 0f, 0f, true).Pitch));
        }
        [Test]
        public void InvalidAndNegativeEnergyNeverInventSpeechAndOversizeIsClamped()
        {
            var baseline = CompanionExpression.At("review", 2f, 2f, true);
            foreach (var invalid in new[] { float.NaN, float.PositiveInfinity, float.NegativeInfinity, -1f })
            {
                var pose = CompanionExpression.At("review", 2f, 2f, true, speakingActivity: invalid);
                Assert.That(pose.Smile, Is.EqualTo(baseline.Smile));
                Assert.That(pose.Pitch, Is.EqualTo(baseline.Pitch));
            }
            var bounded = CompanionExpression.At("review", 2f, 2f, false, speakingActivity: 1f);
            var huge = CompanionExpression.At("review", 2f, 2f, false, speakingActivity: 100f);
            Assert.That(huge.Lift, Is.EqualTo(bounded.Lift));
            Assert.That(huge.Pitch, Is.EqualTo(bounded.Pitch));
        }

        [Test]
        public void ResultNodIsBriefAndNeverWaves()
        {
            var arrived = CompanionExpression.At("review", .2f, .2f, false);
            var finished = CompanionExpression.At("review", 2f, 2f, false);
            Assert.That(arrived.Pitch, Is.LessThan(finished.Pitch));
            Assert.That(arrived.RightShoulder, Is.EqualTo(finished.RightShoulder));
            Assert.That(arrived.RightWrist, Is.EqualTo(0f));
        }

        [TestCase("listening")]
        [TestCase("processing")]
        public void ActualInputAndRequestOverrideStalePlayback(string state)
        {
            var current = CompanionExpression.At(state, 2f, 2f, false);
            var stale = CompanionExpression.At(state, 2f, 2f, false, speakingActivity: 1f);
            Assert.That(stale.Pitch, Is.EqualTo(current.Pitch));
            Assert.That(stale.LeftEye, Is.EqualTo(current.LeftEye));
            Assert.That(stale.RightEye, Is.EqualTo(current.RightEye));
        }

        [Test]
        public void ProcessingHoldsPoseAndListeningLooksAtWearerInsteadOfOldTarget()
        {
            var first = CompanionExpression.At("processing", 0f, 0f, false);
            var later = CompanionExpression.At("processing", 18f, 18f, false);
            Assert.That(later.Roll, Is.EqualTo(first.Roll));
            Assert.That(later.Lift, Is.EqualTo(first.Lift));
            var listening = CompanionExpression.At("listening", 0f, 0f, true, 1f, -1f);
            Assert.That(listening.Yaw, Is.EqualTo(0f));
            Assert.That(listening.LookX, Is.EqualTo(0f));
            Assert.That(listening.LookY, Is.EqualTo(0f));
        }

        [Test]
        public void SavedHappyEyesDifferFromThinkingAndKeepTheirShapeWithReducedMotion()
        {
            Assert.That(CompanionExpression.At("saved", 0f, 0f, true).Smile, Is.EqualTo(1f));
            Assert.That(CompanionExpression.At("processing", 0f, 0f, true).Smile, Is.EqualTo(0f));
            Assert.That(CompanionExpression.At("review", 0f, 0f, true).Smile, Is.EqualTo(0f));
            Assert.That(CompanionExpression.At("listening", 0f, 0f, true).RightShoulder, Is.EqualTo(48f));
        }
    }
}
