using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Reflection;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests;

public sealed class AuditLiveSceneSourceTests
{
    [TestCase("stream")]
    [TestCase("frame")]
    [TestCase("sequence")]
    [TestCase("time")]
    [TestCase("pixels")]
    public void IndependentRequestTamperingCannotEnterTheCache(string change)
    {
        var (request, result) = Fixture();
        switch (change)
        {
            case "stream": request.StreamId = Guid.NewGuid().ToString(); break;
            case "frame": request.FrameId = Guid.NewGuid().ToString(); break;
            case "sequence": request.Sequence++; break;
            case "time": request.Frame.CapturedAt = "1970-01-01T00:00:01Z"; break;
            case "pixels": request.Frame.Jpeg = "Ag=="; break;
        }
        Assert.That(LiveSceneSource.TryCreate(result, request, 10f, 11f, out var admission), Is.False);
        Assert.That(admission, Is.Null);
    }

    [Test]
    public void EveryPublicCollectionRejectsWritesAndTrianglesKeepOriginalIndices()
    {
        var (request, result) = Fixture();
        Assert.That(LiveSceneSource.TryCreate(result, request, 10f, 11f, out var admission), Is.True);
        var proposal = admission!.Objects.Single();
        var contour = (IList<Vector2>)proposal.Contour;
        var triangles = (IList<int>)proposal.Triangles;
        var objects = (IList<LiveSceneProposal>)admission.Objects;
        Assert.Throws<NotSupportedException>(() => contour[0] = Vector2.Zero);
        Assert.Throws<NotSupportedException>(() => triangles[0] = 99);
        Assert.Throws<NotSupportedException>(() => objects.Clear());
        Assert.That(triangles.Count, Is.EqualTo(6));
        Assert.That(triangles.All(index => index >= 0 && index < contour.Count), Is.True);
        Assert.That(LiveSceneAttention.TrySelect(admission, 11f, new Vector2(.25f, .5f), null, out _), Is.True);
    }

    [Test]
    public void ReorderingOriginalContainersAndReplacingPointsCannotRewriteAdmission()
    {
        var (request, result) = Fixture();
        Assert.That(LiveSceneSource.TryCreate(result, request, 10f, 11f, out var admission), Is.True);
        var expected = admission!.Objects[0].Contour.ToArray();
        result.Objects[0].Contour.Clear();
        result.Objects[0].Contour = new List<Point2>();
        result.Objects.Clear();
        request.Frame = new FrameData { CapturedAt = "changed", Jpeg = "Ag==" };
        Assert.That(admission.Objects[0].Contour, Is.EqualTo(expected));
        Assert.That(LiveSceneAttention.TrySelect(admission, 13f, new Vector2(.25f, .5f), null, out var target), Is.True);
        Assert.That(target!.ObjectIndex, Is.Zero);
        Assert.That(target.EventId, Is.EqualTo("audit-synthetic-event"));
        Assert.That(target.MaskSha256, Is.EqualTo(new string('b', 64)));
        Assert.That(LiveSceneAttention.IsCurrent(target, admission, 13.001f), Is.False);
    }

    [Test]
    public void AdmissionTypesRetainNoCaptureOrMutableTransportObjects()
    {
        var forbidden = new[] { typeof(byte[]), typeof(FrameData), typeof(SceneObservation),
            typeof(SceneObservationRequest), typeof(SceneObject), typeof(Grounding), typeof(Point2), typeof(Box2) };
        foreach (var type in new[] { typeof(LiveSceneSource), typeof(LiveSceneProposal), typeof(LiveSceneTarget) })
        foreach (var field in type.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            Assert.That(forbidden.Contains(field.FieldType), Is.False, type.Name + "." + field.Name);
    }

    [TestCase("null-object")]
    [TestCase("null-box")]
    [TestCase("null-point")]
    [TestCase("null-hash")]
    [TestCase("nan-box")]
    [TestCase("reversed-box")]
    [TestCase("outside-contour")]
    [TestCase("duplicate-point")]
    [TestCase("self-crossing")]
    [TestCase("too-many")]
    public void MalformedMutableEvidenceFailsClosedWithoutThrowing(string change)
    {
        var (request, result) = Fixture(); var item = result.Objects[0];
        switch (change)
        {
            case "null-object": result.Objects[0] = null!; break;
            case "null-box": item.Box = null!; break;
            case "null-point": item.Contour[0] = null!; break;
            case "null-hash": item.MaskSha256 = null!; break;
            case "nan-box": item.Box.X0 = float.NaN; break;
            case "reversed-box": item.Box.X0 = .9f; break;
            case "outside-contour": item.Contour[0].Y = -.01f; break;
            case "duplicate-point": item.Contour[1] = item.Contour[0]; break;
            case "self-crossing": (item.Contour[1], item.Contour[2]) = (item.Contour[2], item.Contour[1]); break;
            case "too-many": while (result.Objects.Count < 5) result.Objects.Add(item); break;
        }
        LiveSceneSource? admission = null;
        Assert.DoesNotThrow(() => Assert.That(LiveSceneSource.TryCreate(result, request, 10f, 11f, out admission), Is.False));
        Assert.That(admission, Is.Null);
    }

    private static (SceneObservationRequest, SceneObservation) Fixture()
    {
        var request = new SceneObservationRequest {
            StreamId = "11111111-1111-4111-8111-111111111111",
            FrameId = "22222222-2222-4222-8222-222222222222", Sequence = 4,
            Frame = new FrameData { Jpeg = "AQ==", CapturedAt = "1970-01-01T00:00:00Z" }
        };
        return (request, new SceneObservation {
            StreamId = request.StreamId, FrameId = request.FrameId, Sequence = request.Sequence,
            CapturedAt = request.Frame.CapturedAt, Verification = "proposed", EventId = "audit-synthetic-event",
            Provider = "audit-fixture", Model = "synthetic",
            FrameSha256 = "4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a",
            Objects = new List<SceneObject> { new() {
                Label = "Synthetic proposal", Confidence = .2f, MaskConfidence = .3f, MaskPixels = 100,
                MaskSha256 = new string('b', 64), Box = new Box2 { X0 = .1f, X1 = .4f, Y0 = .2f, Y1 = .8f },
                Contour = new List<Point2> { new() { X=.1f, Y=.2f }, new() { X=.4f, Y=.2f },
                    new() { X=.4f, Y=.8f }, new() { X=.1f, Y=.8f } }
            } }
        });
    }
}
