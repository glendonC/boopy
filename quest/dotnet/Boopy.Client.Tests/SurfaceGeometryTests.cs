using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class SurfaceGeometryTests
    {
        private static readonly Vector2[] Concave = { new Vector2(.1f,.1f),new Vector2(.7f,.1f),
            new Vector2(.7f,.3f),new Vector2(.3f,.3f),new Vector2(.3f,.7f),new Vector2(.1f,.7f) };

        [Test]
        public void ConcaveFillRetainsTheNotchInBothWindings()
        {
            foreach (var polygon in new[] { Concave, Concave.Reverse().ToArray() })
            {
                Assert.That(SurfaceGeometry.TryTriangulate(polygon, out var triangles), Is.True);
                Assert.That(triangles.Length, Is.EqualTo((polygon.Length-2)*3));
                var area=0f;
                for(var i=0;i<triangles.Length;i+=3)
                {
                    var a=polygon[triangles[i]];var b=polygon[triangles[i+1]];var c=polygon[triangles[i+2]];
                    area+=MathF.Abs((b.X-a.X)*(c.Y-a.Y)-(b.Y-a.Y)*(c.X-a.X))*.5f;
                    Assert.That(SurfaceGeometry.Contains(polygon,(a+b+c)/3f),Is.True);
                }
                Assert.That(area,Is.EqualTo(.2f).Within(.00001f));
                Assert.That(SurfaceGeometry.Contains(polygon,new Vector2(.6f,.6f)),Is.False);
            }
        }

        [Test]
        public void InvalidContoursCannotBecomeAFillFromTheFallbackBox()
        {
            var invalids=new[] {
                new[] {new Vector2(.1f,.1f),new Vector2(.8f,.8f),new Vector2(.1f,.8f),new Vector2(.8f,.1f)},
                new[] {new Vector2(.1f,.1f),new Vector2(.2f,.2f),new Vector2(.3f,.3f)},
                new[] {new Vector2(.1f,.1f),new Vector2(.8f,.1f),new Vector2(.8f,.1f),new Vector2(.1f,.8f)},
            };
            foreach(var polygon in invalids)
            {
                Assert.That(SurfaceGeometry.TryTriangulate(polygon,out _),Is.False);
                var grounding=new Grounding { Kind="box",Box=new Box2 { X0=.1f,Y0=.1f,X1=.8f,Y1=.8f },
                    Spatial=new SpatialEvidence {Outcome="contour"},Contour=polygon.Select(p=>new Point2 {X=p.X,Y=p.Y}).ToList() };
                Assert.That(Geometry.TryContour(grounding,out _),Is.False);
                Assert.That(Geometry.Outline(grounding),Is.EqualTo(Geometry.Corners(grounding.Box)));
            }
            Assert.That(Geometry.TryContour(new Grounding {Kind="box",Box=new Box2 {X1=1f,Y1=1f}},out _),Is.False);
        }

        [Test]
        public void CapturedCameraRayMatchesSdkCropAndTopLeftConvention()
        {
            var camera=new CameraInfo {FocalLength=new[]{500f,500f},PrincipalPoint=new[]{500f,400f},SensorResolution=new[]{1000,800}};
            Assert.That(SurfaceGeometry.CameraRay(new Vector2(.5f,.5f),1000,800,camera,out var center),Is.True);
            Assert.That(center,Is.EqualTo(Vector3.UnitZ));
            Assert.That(SurfaceGeometry.CameraRay(new Vector2(0f,.5f),1000,1000,camera,out var cropped),Is.True);
            Assert.That(Vector3.Distance(cropped,Vector3.Normalize(new Vector3(-.8f,0f,1f))),Is.LessThan(.00001f));
            SurfaceGeometry.CameraRay(new Vector2(.5f,0f),1000,800,camera,out var top);
            Assert.That(top.Y,Is.GreaterThan(0f));
            camera.FocalLength[0]=0f;
            Assert.That(SurfaceGeometry.CameraRay(Vector2.Zero,1000,800,camera,out _),Is.False);
        }

        private static List<Vector3> PlaneSamples() => (from x in new[]{-.3f,0f,.3f}
            from y in new[]{-.2f,0f,.2f} select new Vector3(x,y,1f+.5f*x+.1f*y)).ToList();

        [Test]
        public void DistributedCapturedDepthSupportsASlantedSurfaceWithoutFlatteningIt()
        {
            var samples=PlaneSamples();
            samples.Add(new Vector3(0f,0f,2f)); // One bounded outlier, at most ten percent.
            Assert.That(SurfaceGeometry.TryFitPlane(samples,out var plane),Is.True);
            var direction=Vector3.Normalize(new Vector3(.2f,.1f,1f));
            Assert.That(plane.Intersect(Vector3.Zero,direction,out var point),Is.True);
            Assert.That(point.Z-(1f+.5f*point.X+.1f*point.Y),Is.EqualTo(0f).Within(.00001f));
            Assert.That(plane.Intersect(Vector3.Zero,Vector3.UnitZ,out var middle),Is.True);
            Assert.That(point.Z,Is.GreaterThan(middle.Z));
        }

        [Test]
        public void SparseCollinearOrMixedForegroundBackgroundDepthDoesNotInventAPlane()
        {
            Assert.That(SurfaceGeometry.TryFitPlane(PlaneSamples().Take(6).ToList(),out _),Is.False);
            var line=Enumerable.Range(0,10).Select(i=>new Vector3(i*.02f,0f,1f)).ToList();
            Assert.That(SurfaceGeometry.TryFitPlane(line,out _),Is.False);
            var mixed=PlaneSamples();
            for(var i=0;i<mixed.Count;i++) if(i%2==0) mixed[i]+=new Vector3(0f,0f,.35f);
            Assert.That(SurfaceGeometry.TryFitPlane(mixed,out _),Is.False);
            Assert.That(new CapturedPlane(Vector3.UnitZ,1f).Intersect(Vector3.Zero,Vector3.UnitX,out _),Is.False);
        }

        [Test]
        public void RevealTracesReturnedEdgesByDistanceBeforeAnyFillAppears()
        {
            var boundary = new[] {Vector3.Zero,new Vector3(2f,0f,0f),new Vector3(2f,1f,0f),new Vector3(0f,1f,0f)};
            var half = SurfaceGeometry.TraceBoundary(boundary,.5f);
            Assert.That(half,Is.EqualTo(new[] {boundary[0],boundary[1],boundary[2],boundary[2]}));
            var partial = SurfaceGeometry.TraceBoundary(boundary,.25f);
            Assert.That(partial,Is.EqualTo(new[] {boundary[0],new Vector3(1.5f,0f,0f)}));
            var complete = SurfaceGeometry.TraceBoundary(boundary,1f);
            Assert.That(complete,Is.EqualTo(boundary.Append(boundary[0]).ToArray()));
            Assert.That(SurfaceGeometry.FillReveal(.44f),Is.Zero);
            Assert.That(SurfaceGeometry.FillReveal(.6f),Is.EqualTo(.5f).Within(.00001f));
            Assert.That(SurfaceGeometry.FillReveal(.75f),Is.EqualTo(1f));
            Assert.That(SurfaceGeometry.TraceBoundary(Array.Empty<Vector3>(),.5f),Is.Empty);
            Assert.That(SurfaceGeometry.FillReveal(float.NaN),Is.Zero);
        }
    }
}
