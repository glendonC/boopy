using System.Collections.Generic;
using System.Numerics;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class SpatialLabelLayoutTests
    {
        private static readonly LabelRect View = new LabelRect(-0.7f, -0.5f, 0.7f, 0.5f);
        private static readonly Vector2 CaptionSize = new Vector2(0.20f, 0.08f);

        [Test]
        public void ProtectsAllCornersOfASlantedLargeObject()
        {
            var corners = new[]
            {
                new Vector2(-0.40f, -0.24f), new Vector2(0.32f, -0.32f),
                new Vector2(0.40f, 0.24f), new Vector2(-0.32f, 0.32f),
            };
            var envelope = LabelRect.Envelope(corners);
            Assert.That(envelope.MinX, Is.EqualTo(-0.40f));
            Assert.That(envelope.MaxY, Is.EqualTo(0.32f));
            Assert.That(SpatialLabelLayout.TryPlace(Vector2.Zero, CaptionSize,
                new[] { envelope }, new LabelRect[0], View, out var label), Is.True);
            Assert.That(label.Intersects(envelope, 0.02f), Is.False);
            Assert.That(View.Contains(label), Is.True);
        }

        [Test]
        public void ChoosesTheNearestSuitableSideAndAvoidsOtherGroundedObjects()
        {
            var referent = new LabelRect(-0.15f, -0.25f, 0.15f, 0.25f);
            var rightObject = new LabelRect(0.16f, -0.25f, 0.45f, 0.25f);
            Assert.That(SpatialLabelLayout.TryPlace(new Vector2(0.12f, 0f), CaptionSize,
                new[] { referent, rightObject }, new LabelRect[0], View, out var label), Is.True);
            Assert.That(label.Center.Y, Is.GreaterThan(referent.MaxY), "above is closer than going around both objects");
            Assert.That(label.Intersects(referent, 0.02f), Is.False);
            Assert.That(label.Intersects(rightObject, 0.02f), Is.False);
        }

        [Test]
        public void RepeatedLabelsNeverOverlapTheObjectOrEachOtherAndEventuallyOverflow()
        {
            var referent = new LabelRect(-0.30f, -0.20f, 0.30f, 0.20f);
            var occupied = new List<LabelRect>();
            var overflowed = false;
            for (var i = 0; i < 100; i++)
            {
                if (!SpatialLabelLayout.TryPlace(Vector2.Zero, CaptionSize,
                    new[] { referent }, occupied, View, out var label))
                {
                    overflowed = true;
                    break;
                }
                Assert.That(label.Intersects(referent, 0.02f), Is.False);
                Assert.That(View.Contains(label), Is.True);
                foreach (var previous in occupied)
                    Assert.That(label.Intersects(previous, 0.02f), Is.False);
                occupied.Add(label);
            }
            Assert.That(occupied.Count, Is.GreaterThan(5));
            Assert.That(overflowed, Is.True);
        }

        [Test]
        public void FullViewAndOversizedLabelsFailInsteadOfCoveringTheObject()
        {
            Assert.That(SpatialLabelLayout.TryPlace(Vector2.Zero, CaptionSize,
                new[] { View }, new LabelRect[0], View, out _), Is.False);
            Assert.That(SpatialLabelLayout.TryPlace(Vector2.Zero, new Vector2(2f, 1f),
                new LabelRect[0], new LabelRect[0], View, out _), Is.False);
        }

        [Test]
        public void PlacementIsStableAcrossCallsAndProtectedAreaOrdering()
        {
            var first = new LabelRect(-0.30f, -0.20f, 0.10f, 0.20f);
            var second = new LabelRect(0.20f, -0.20f, 0.35f, 0.20f);
            var occupied = new[] { new LabelRect(-0.45f, 0.28f, -0.20f, 0.40f) };
            Assert.That(SpatialLabelLayout.TryPlace(Vector2.Zero, CaptionSize,
                new[] { first, second }, occupied, View, out var a), Is.True);
            Assert.That(SpatialLabelLayout.TryPlace(Vector2.Zero, CaptionSize,
                new[] { second, first }, occupied, View, out var b), Is.True);
            Assert.That(a, Is.EqualTo(b));
            Assert.That(occupied[0], Is.EqualTo(new LabelRect(-0.45f, 0.28f, -0.20f, 0.40f)), "existing placements remain untouched");
        }

        [Test]
        public void ExpandedDetailBoundsAlsoStayClear()
        {
            var referent = new LabelRect(-0.20f, -0.25f, 0.20f, 0.25f);
            var expanded = new Vector2(0.192f, 0.32f) * 1.08f;
            Assert.That(SpatialLabelLayout.TryPlace(Vector2.Zero, expanded,
                new[] { referent }, new LabelRect[0], View, out var label), Is.True);
            Assert.That(label.Intersects(referent, 0.02f), Is.False);
            Assert.That(label.Size.X, Is.EqualTo(expanded.X).Within(0.00001f));
            Assert.That(label.Size.Y, Is.EqualTo(expanded.Y).Within(0.00001f));
        }

        [TestCase(.20f, .08f)]
        [TestCase(.40f, .16f)]
        public void ExplicitCenterKeepoutProtectsStandardAndLargeMeasuredGroups(float width, float height)
        {
            var center = new LabelRect(-.12f, -.10f, .12f, .10f);
            var objects = new[] { new LabelRect(-.65f, -.4f, -.35f, .4f) };
            var occupied = new[] { new LabelRect(.35f, -.4f, .65f, .4f) };
            var size = new Vector2(width, height);
            Assert.That(SpatialLabelLayout.TryPlace(Vector2.Zero, size, objects, occupied, View,
                center, out var label), Is.True);
            Assert.That(label.Intersects(center, .02f), Is.False);
            Assert.That(label.Intersects(objects[0], .02f), Is.False);
            Assert.That(label.Intersects(occupied[0], .02f), Is.False);
            Assert.That(View.Contains(label), Is.True);
            Assert.That(label.Size.X, Is.EqualTo(width).Within(.00001f));
            Assert.That(label.Size.Y, Is.EqualTo(height).Within(.00001f));
        }

        [TestCase(.20f, .08f)]
        [TestCase(.40f, .16f)]
        public void FullyProtectedCenterWithholdsTheWholeGroup(float width, float height)
        {
            Assert.That(SpatialLabelLayout.TryPlace(Vector2.Zero, new Vector2(width, height),
                new LabelRect[0], new LabelRect[0], View, View, out _), Is.False);
        }

        [Test]
        public void LargeGroupIsWithheldWhenOnlyTheSmallerGroupFits()
        {
            var center = new LabelRect(-.30f, -.5f, .30f, .5f);
            Assert.That(SpatialLabelLayout.TryPlace(Vector2.Zero, new Vector2(.25f, .15f),
                new LabelRect[0], new LabelRect[0], View, center, out var small), Is.True);
            Assert.That(small.Intersects(center, .02f), Is.False);
            Assert.That(SpatialLabelLayout.TryPlace(Vector2.Zero, new Vector2(.45f, .30f),
                new LabelRect[0], new LabelRect[0], View, center, out _), Is.False);
        }

        [Test]
        public void CenterKeepoutMustActuallyCoverTheViewCenter()
        {
            Assert.That(SpatialLabelLayout.TryPlace(Vector2.Zero, CaptionSize,
                new LabelRect[0], new LabelRect[0], View, new LabelRect(.2f, .2f, .3f, .3f), out _), Is.False);
            Assert.That(SpatialLabelLayout.TryPlace(Vector2.Zero, CaptionSize,
                new LabelRect[0], new LabelRect[0], View, default(LabelRect), out _), Is.False);
        }

        [Test]
        public void CenterKeepoutPlacementRetainsDeterministicObstacleOrdering()
        {
            var center = new LabelRect(-.12f, -.10f, .12f, .10f);
            var first = new LabelRect(-.30f, -.20f, -.15f, .20f);
            var second = new LabelRect(.15f, -.20f, .35f, .20f);
            Assert.That(SpatialLabelLayout.TryPlace(Vector2.Zero, CaptionSize, new[] { first, second },
                new LabelRect[0], View, center, out var a), Is.True);
            Assert.That(SpatialLabelLayout.TryPlace(Vector2.Zero, CaptionSize, new[] { second, first },
                new LabelRect[0], View, center, out var b), Is.True);
            Assert.That(a, Is.EqualTo(b));
            Assert.That(a.Intersects(center, .02f), Is.False);
        }
    }
}
