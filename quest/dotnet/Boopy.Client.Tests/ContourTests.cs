using System.Collections.Generic;
using System.Numerics;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class ContourTests
    {
        [Test]
        public void ReadsSeparateGeometryEvidenceWithoutConfirmingTheItem()
        {
            var item = Wire.Read<Item>("""
                {"status":"proposed","confidence":0.4,"grounding":{"kind":"box",
                 "box":{"x0":0.2,"y0":0.2,"x1":0.8,"y1":0.8},
                 "contour":[{"x":0.2,"y":0.3},{"x":0.7,"y":0.2},{"x":0.8,"y":0.7},{"x":0.3,"y":0.8}],
                 "spatial":{"provider":"meta","model":"sam-3.1","outcome":"contour","verification":"proposed","confidence":0.9}}}
                """);
            Assert.That(Geometry.Outline(item.Grounding)[0], Is.EqualTo(new Vector2(0.2f, 0.3f)));
            Assert.That(Geometry.Outline(item.Grounding), Has.Length.EqualTo(4));
            Assert.That(item.Status, Is.EqualTo("proposed"));
            Assert.That(item.Confidence, Is.EqualTo(0.4f));
            Assert.That(item.Grounding.Spatial!.Confidence, Is.EqualTo(0.9f));
        }

        [TestCase(float.NaN)]
        [TestCase(float.PositiveInfinity)]
        [TestCase(-0.1f)]
        [TestCase(1.1f)]
        public void InvalidContoursFallBackToTheApproximateBox(float invalid)
        {
            var grounding = new Grounding
            {
                Box = new Box2 { X0 = 0.1f, Y0 = 0.2f, X1 = 0.9f, Y1 = 0.8f },
                Spatial = new SpatialEvidence { Outcome = "contour" },
                Contour = new List<Point2> { new Point2 { X = invalid, Y = 0.3f }, new Point2 { X = 0.8f, Y = 0.3f }, new Point2 { X = 0.4f, Y = 0.8f } },
            };
            Assert.That(Geometry.Outline(grounding), Is.EqualTo(Geometry.Corners(grounding.Box)));
        }

        [Test]
        public void DoesNotDrawAMissingOrUnsuccessfulContour()
        {
            var grounding = new Grounding
            {
                Spatial = new SpatialEvidence { Outcome = "ambiguous" },
                Contour = new List<Point2> { new Point2(), new Point2(), new Point2() },
            };
            Assert.That(Geometry.Outline(grounding), Is.Empty);
            grounding.Spatial.Outcome = "contour";
            grounding.Contour = new List<Point2> { new Point2(), new Point2() };
            Assert.That(Geometry.Outline(grounding), Is.Empty);
        }
    }
}
