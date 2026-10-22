using System.Numerics;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class ProjectedKeepoutTests
    {
        private static readonly HeadPose Viewer = new HeadPose(Vector3.Zero, Vector3.UnitZ);
        [TestCase(true, true, FollowPlacement.Move)]
        [TestCase(true, false, FollowPlacement.Move)]
        [TestCase(false, true, FollowPlacement.Hold)]
        [TestCase(false, false, FollowPlacement.Hide)]
        public void HoldsOnlyAClearCurrentSheetAndHidesAnAlreadyUnsafeSheet(bool candidateClear,
            bool currentClear, FollowPlacement expected)
        {
            Assert.That(ProjectedKeepout.Decide(candidateClear, currentClear), Is.EqualTo(expected));
        }
        [Test]
        public void PanelEdgeCannotCoverAnObjectEvenWhenPanelCenterIsOutside()
        {
            var subject = new LabelRect(-0.2f, -0.2f, 0.2f, 0.2f);
            var partial = LabelRect.Around(new Vector2(0.3f, 0f), new Vector2(0.44f, 0.3f));
            Assert.That(partial.Center.X, Is.GreaterThan(subject.MaxX));
            Assert.That(ProjectedKeepout.IsClear(partial, new[] { subject }), Is.False);
            var clear = LabelRect.Around(new Vector2(0.5f, 0f), new Vector2(0.44f, 0.3f));
            Assert.That(ProjectedKeepout.IsClear(clear, new[] { subject }), Is.True);
        }
        [Test]
        public void ReprojectsTheSameCapturedBoundaryFromTheCurrentHeadPose()
        {
            var objectCorners = new[] { new Vector3(-0.2f, -0.2f, 1f), new Vector3(0.2f, -0.2f, 1f),
                new Vector3(0.2f, 0.2f, 1f), new Vector3(-0.2f, 0.2f, 1f) };
            Assert.That(ProjectedKeepout.TryEnvelope(objectCorners, Viewer, out var initial), Is.True);
            Assert.That(initial.MinX, Is.EqualTo(-0.2f).Within(0.00001f));
            var turned = new HeadPose(Vector3.Zero, -Vector3.UnitZ);
            Assert.That(ProjectedKeepout.TryEnvelope(objectCorners, turned, out _), Is.False,
                "looking away does not retain obsolete capture-view keepouts");
            var translated = new HeadPose(new Vector3(0.3f, 0f, 0f), Vector3.UnitZ);
            Assert.That(ProjectedKeepout.TryEnvelope(objectCorners, translated, out var shifted), Is.True);
            Assert.That(shifted.MaxX, Is.EqualTo(-0.1f).Within(0.00001f));
        }
        [Test]
        public void ClipsCrossingEdgesRatherThanDroppingTheVisibleExtent()
        {
            var crossing = new[] { new Vector3(-0.3f, -0.1f, -0.2f), new Vector3(0.3f, -0.1f, 0.2f),
                new Vector3(0.3f, 0.1f, 0.2f), new Vector3(-0.3f, 0.1f, -0.2f) };
            Assert.That(ProjectedKeepout.TryEnvelope(crossing, Viewer, out var extent), Is.True);
            Assert.That(extent.MinY, Is.EqualTo(-2f).Within(0.0001f));
            Assert.That(extent.MaxY, Is.EqualTo(2f).Within(0.0001f));
            Assert.That(ProjectedKeepout.IsClear(LabelRect.Around(new Vector2(1.5f, 0.7f),
                new Vector2(0.2f, 0.2f)), new[] { extent }), Is.False);
        }
    }
}
