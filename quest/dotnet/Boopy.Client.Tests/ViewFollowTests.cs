using System;
using System.Numerics;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class ViewFollowTests
    {
        private static readonly HeadPose Head = new HeadPose(Vector3.Zero, Vector3.UnitZ);
        private static Vector3 At(float yaw) => ViewFollow.Target(Head, yaw, 0f);
        private static float Angle(Vector3 a, Vector3 b) => MathF.Acos(Math.Clamp(Vector3.Dot(Vector3.Normalize(a), Vector3.Normalize(b)), -1f, 1f)) * 180f / MathF.PI;
        [Test] public void SideTargetRetainsExplicitDistanceAndAngles()
        {
            var target = ViewFollow.Target(Head);
            Assert.That(target.Length(), Is.EqualTo(1f).Within(.00001f));
            Assert.That(MathF.Atan2(target.X, target.Z) * 180f / MathF.PI, Is.EqualTo(18f).Within(.0001f));
            Assert.That(MathF.Asin(target.Y) * 180f / MathF.PI, Is.EqualTo(-10f).Within(.0001f));
        }
        [Test] public void SmallDeadZoneHoldsButOrdinaryTurnMovesOnFirstFrameAndSettlesPromptly()
        {
            var follow = new ViewFollow(); var current = At(18f);
            Assert.That(follow.Step(Head, current, At(21f), false, .01f), Is.EqualTo(current));
            var next = follow.Step(Head, current, At(30f), false, .01f);
            Assert.That(next, Is.Not.EqualTo(current));
            Assert.That(Angle(current, next), Is.LessThanOrEqualTo(2.401f));
            current = next;
            for (var i = 0; i < 30; i++) current = follow.Step(Head, current, At(30f), false, .01f);
            Assert.That(Angle(current, At(30f)), Is.LessThanOrEqualTo(2.01f));
            Assert.That(follow.Following, Is.False);
        }
        [Test] public void LargeHeadTurnReanchorsAtPeripheralTargetWithoutLongChase()
        {
            var follow = new ViewFollow();
            var turned = new HeadPose(Vector3.Zero, Vector3.UnitX);
            var target = ViewFollow.Target(turned);
            Assert.That(follow.Step(turned, At(18f), target, false, .01f), Is.EqualTo(target));
            Assert.That(follow.Following, Is.False);
        }
        [Test] public void OppositeSideNeverSweepsThroughForwardCentre()
        {
            var follow = new ViewFollow();
            var target = At(12f);
            Assert.That(follow.Step(Head, At(-12f), target, false, .01f), Is.EqualTo(target));
        }
        [Test] public void FreezeIsExactAcrossTranslationAndTurnAndReleaseHasNoDwell()
        {
            var follow = new ViewFollow(); var current = At(18f);
            var moved = new HeadPose(new Vector3(.3f, .1f, .2f), Vector3.UnitX);
            var target = ViewFollow.Target(moved);
            Assert.That(follow.Step(moved, current, target, true, 2f), Is.EqualTo(current));
            Assert.That(follow.Following, Is.False);
            Assert.That(follow.Step(moved, current, target, false, .01f), Is.EqualTo(target));
        }
        [Test] public void TranslationRecoversRadiusWithBoundedDeltaSpikeAndInvalidDeltaHolds()
        {
            var follow = new ViewFollow(); var current = At(18f) * 1.5f; var target = At(18f);
            var next = follow.Step(Head, current, target, false, 10f);
            Assert.That(Vector3.Distance(current, next), Is.LessThanOrEqualTo(.0601f));
            Assert.That(next.Length(), Is.EqualTo(1.44f).Within(.0001f));
            current = next;
            for (var i = 0; i < 80; i++) current = follow.Step(Head, current, target, false, .01f);
            Assert.That(current.Length(), Is.LessThanOrEqualTo(1.021f));
            Assert.That(follow.Step(Head, current, target, false, float.NaN), Is.EqualTo(current));
        }
        [Test] public void SmallHeadTranslationRespondsImmediatelyWithoutMovingRoomEvidence()
        {
            var follow = new ViewFollow(); var current = ViewFollow.Target(Head);
            var moved = new HeadPose(new Vector3(.08f, 0f, 0f), Vector3.UnitZ);
            var target = ViewFollow.Target(moved);
            var next = follow.Step(moved, current, target, false, .01f);
            Assert.That(next, Is.Not.EqualTo(current));
            Assert.That(Vector3.Distance(next, target), Is.LessThan(Vector3.Distance(current, target)));
            Assert.That(Angle(current - moved.Position, next - moved.Position), Is.LessThanOrEqualTo(2.401f));
        }
        [Test] public void SmallAngularDeltaSpikeIsBoundedAndStopThresholdDoesNotChatter()
        {
            var follow = new ViewFollow(); var current = At(18f); var target = At(40f);
            var next = follow.Step(Head, current, target, false, 10f);
            Assert.That(Angle(current, next), Is.LessThanOrEqualTo(12.01f));
            current = next;
            for (var i = 0; i < 50; i++) current = follow.Step(Head, current, target, false, .01f);
            var stopped = current;
            Assert.That(follow.Following, Is.False);
            Assert.That(follow.Step(Head, stopped, At(41f), false, .01f), Is.EqualTo(stopped));
        }
    }
}
