using System;
using System.Collections.Generic;
using System.Numerics;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests;

public sealed class LiveSceneAttentionTests
{
    private const float SourceTime = 10f;
    private const float Now = 11f;
    private static readonly Vector2 Left = new(.2f, .5f);
    private static readonly Vector2 Right = new(.8f, .5f);

    [Test]
    public void HeadDirectionSelectsTheHitContourRatherThanTheFirstSortedBox()
    {
        var request = Request(); var source = Source(request);
        Assert.That(LiveSceneAttention.TrySelect(source, request, SourceTime, Now, Right, null,
            out var target), Is.True);
        Assert.That(target!.ObjectIndex, Is.EqualTo(1));
        Assert.That(target.FromPointer, Is.False);
        Assert.That(LiveSceneAttention.IsCurrent(target, source, request, SourceTime, Now), Is.True);
    }

    [Test]
    public void ActivePointerWinsOverHeadDirectionWithoutChangingTheSource()
    {
        var request = Request(); var source = Source(request);
        Assert.That(LiveSceneAttention.TrySelect(source, request, SourceTime, Now, Left, Right,
            out var target), Is.True);
        Assert.That(target!.ObjectIndex, Is.EqualTo(1));
        Assert.That(target.FromPointer, Is.True);
        Assert.That(source.Verification, Is.EqualTo("proposed"));
        Assert.That(source.Objects[1].Label, Is.EqualTo("Synthetic right"));
        Assert.That(source.Objects[1].Confidence, Is.EqualTo(.4f));
        Assert.That(source.Objects[1].MaskConfidence, Is.EqualTo(.8f));
    }

    [Test]
    public void PointerMissDoesNotFallBackToAnotherHeadTarget()
    {
        var request = Request(); var source = Source(request);
        Assert.That(LiveSceneAttention.TrySelect(source, request, SourceTime, Now, Left,
            new Vector2(.5f, .5f), out var target), Is.False);
        Assert.That(target, Is.Null);
    }

    [Test]
    public void OverlappingHitContoursRemainAmbiguousEvenWhenConfidenceDiffers()
    {
        var request = Request(); var source = Source(request);
        source.Objects[1] = Object(.1f, .4f, 'c'); source.Objects[1].Confidence = .99f;
        Assert.That(LiveSceneAttention.TrySelect(source, request, SourceTime, Now, Left, null,
            out var target), Is.False);
        Assert.That(target, Is.Null);
        Assert.That(LiveSceneAttention.TrySelect(source, request, SourceTime, Now, Right, Left,
            out target), Is.False);
        Assert.That(target, Is.Null);
    }

    [Test]
    public void BoxOverlapDoesNotSelectOutsideTheActualContour()
    {
        var request = Request(); var source = Source(request);
        source.Objects.RemoveAt(1);
        source.Objects[0].Contour = new List<Point2> {
            new() { X=.1f,Y=.2f }, new() { X=.4f,Y=.2f }, new() { X=.1f,Y=.8f }
        };
        Assert.That(source.Matches(request), Is.True);
        Assert.That(LiveSceneAttention.TrySelect(source, request, SourceTime, Now,
            new Vector2(.35f, .7f), null, out _), Is.False);
    }

    [Test]
    public void NoProjectedCueDoesNotInventPersonIntent()
    {
        var request = Request();
        Assert.That(LiveSceneAttention.TrySelect(Source(request), request, SourceTime, Now,
            null, null, out var target), Is.False);
        Assert.That(target, Is.Null);
    }

    [TestCase(float.NaN, .5f)]
    [TestCase(float.PositiveInfinity, .5f)]
    [TestCase(-.01f, .5f)]
    [TestCase(.2f, 1.01f)]
    public void InvalidPointerIsNotClampedOrReplacedByHeadDirection(float x, float y)
    {
        var request = Request();
        Assert.That(LiveSceneAttention.TrySelect(Source(request), request, SourceTime, Now, Left,
            new Vector2(x, y), out _), Is.False);
    }

    [TestCase(10f, 13.001f)]
    [TestCase(10f, 9.999f)]
    [TestCase(float.NaN, 11f)]
    [TestCase(10f, float.PositiveInfinity)]
    public void StaleFutureOrInvalidSourceTimesYieldNoAttention(float sourceTime, float now)
    {
        var request = Request(); var source = Source(request);
        Assert.That(LiveSceneAttention.TrySelect(source, request, SourceTime, Now, Left, null,
            out var target), Is.True);
        Assert.That(LiveSceneAttention.TrySelect(source, request, sourceTime, now, Left, null,
            out var expired), Is.False);
        Assert.That(expired, Is.Null);
        Assert.That(LiveSceneAttention.IsCurrent(target, source, request, sourceTime, now), Is.False);
    }

    [Test]
    public void ExistingThreeSecondBoundaryIsPreserved()
    {
        var request = Request(); var source = Source(request);
        Assert.That(LiveSceneAttention.TrySelect(source, request, SourceTime, 13f, Left, null,
            out _), Is.True);
    }

    [Test]
    public void ASelectedSourcesLifetimeCannotBeRenewedByChangingItsMonotonicTimestamp()
    {
        var request = Request(); var source = Source(request);
        Assert.That(LiveSceneAttention.TrySelect(source, request, SourceTime, Now, Left, null,
            out var selected), Is.True);
        Assert.That(LiveSceneAttention.IsCurrent(selected, source, request, 13f, 14f), Is.False);
        Assert.That(selected!.SourceTime, Is.EqualTo(SourceTime));
    }

    [Test]
    public void EmptyObservationsClearAttentionRatherThanKeepingAnOldTarget()
    {
        var request = Request(); var source = Source(request);
        Assert.That(LiveSceneAttention.TrySelect(source, request, SourceTime, Now, Left, null,
            out var selected), Is.True);
        source.Objects.Clear();
        Assert.That(source.Matches(request), Is.True);
        Assert.That(LiveSceneAttention.TrySelect(source, request, SourceTime, Now, Left, null,
            out var next), Is.False);
        Assert.That(next, Is.Null);
        Assert.That(LiveSceneAttention.IsCurrent(selected, source, request, SourceTime, Now), Is.False);
    }

    [TestCase("stream")]
    [TestCase("frame")]
    [TestCase("sequence")]
    [TestCase("capturedAt")]
    [TestCase("frameHash")]
    [TestCase("verification")]
    public void MismatchedSourceOrConfirmedOutputCannotBeSelected(string change)
    {
        var request = Request(); var source = Source(request);
        switch (change)
        {
            case "stream": source.StreamId = "other-stream"; break;
            case "frame": source.FrameId = "other-frame"; break;
            case "sequence": source.Sequence++; break;
            case "capturedAt": source.CapturedAt = "1970-01-01T16:00:01Z"; break;
            case "frameHash": source.FrameSha256 = new string('f', 64); break;
            case "verification": source.Verification = "confirmed"; break;
        }
        Assert.That(LiveSceneAttention.TrySelect(source, request, SourceTime, Now, Left, null,
            out var target), Is.False);
        Assert.That(target, Is.Null);
    }

    [TestCase("event")]
    [TestCase("stream")]
    [TestCase("frame")]
    [TestCase("sequence")]
    [TestCase("capturedAt")]
    [TestCase("frameHash")]
    [TestCase("mask")]
    [TestCase("order")]
    [TestCase("provider")]
    [TestCase("model")]
    public void SelectedIdentityDoesNotSurviveAReplacementSource(string change)
    {
        var request = Request(); var source = Source(request);
        Assert.That(LiveSceneAttention.TrySelect(source, request, SourceTime, Now, Left, null,
            out var selected), Is.True);
        switch (change)
        {
            case "event": source.EventId = "synthetic-other-event"; break;
            case "stream": source.StreamId = request.StreamId = Guid.NewGuid().ToString(); break;
            case "frame": source.FrameId = request.FrameId = Guid.NewGuid().ToString(); break;
            case "sequence": source.Sequence = ++request.Sequence; break;
            case "capturedAt": source.CapturedAt = request.Frame.CapturedAt = "1970-01-01T16:00:01Z"; break;
            case "frameHash": request.Frame.Jpeg = "AQ=="; source.FrameSha256 = "4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a"; break;
            case "mask": source.Objects[0].MaskSha256 = new string('d', 64); break;
            case "order": source.Objects.Reverse(); break;
            case "provider": source.Provider = "synthetic-other-provider"; break;
            case "model": source.Model = "synthetic-other-model"; break;
        }
        Assert.That(source.Matches(request), Is.True, "replacement itself must remain a valid source");
        Assert.That(LiveSceneAttention.IsCurrent(selected, source, request, SourceTime, Now), Is.False);
        Assert.That(LiveSceneAttention.TrySelect(source, request, SourceTime, Now, Left, null,
            out var next), Is.True, "fresh explicit cue can independently select the replacement");
        Assert.That(next, Is.Not.SameAs(selected));
    }

    [Test]
    public void CategoryChurnNeverBecomesVerificationOrAnIdentityGuess()
    {
        var request = Request(); var source = Source(request);
        foreach (var label in new[] { "window", "picture", "rectangle" })
        {
            source.Objects[0].Label = label;
            Assert.That(LiveSceneAttention.TrySelect(source, request, SourceTime, Now, Left, null,
                out var selected), Is.True);
            Assert.That(selected!.MaskSha256, Is.EqualTo(new string('b', 64)));
            Assert.That(source.Objects[0].Label, Is.EqualTo(label));
            Assert.That(source.Verification, Is.EqualTo("proposed"));
            Assert.That(source.Objects[0].Confidence, Is.EqualTo(.4f));
        }
    }

    [Test]
    public void AdmissionFreezesSourceAndProposalEvidenceWithoutRetainingMutableDtos()
    {
        var request = Request(); var source = Source(request);
        Assert.That(LiveSceneSource.TryCreate(source, request, SourceTime, Now, out var bound), Is.True);
        Assert.That(LiveSceneAttention.TrySelect(bound!, Now, Left, null, out var selected), Is.True);
        source.StreamId = "changed"; source.FrameId = "changed"; source.Sequence++;
        source.CapturedAt = "changed"; source.FrameSha256 = new string('f', 64);
        source.EventId = "changed"; source.Provider = "changed"; source.Model = "changed";
        source.Verification = "confirmed"; source.FrameRetained = true; source.LatencyMs = 999f;
        source.Objects[0].Label = "changed"; source.Objects[0].Confidence = .99f;
        source.Objects[0].MaskConfidence = .99f; source.Objects[0].MaskSha256 = new string('f', 64);
        source.Objects[0].MaskPixels = 1; source.Objects[0].Box.X0 = .9f;
        source.Objects[0].Contour[0].X = .9f; source.Objects.Reverse();
        request.Frame.Jpeg = "invalid-base64"; request.Frame.CapturedAt = "changed";
        Assert.That(bound!.EventId, Is.EqualTo("synthetic-event"));
        Assert.That(bound.Provider, Is.EqualTo("fixture")); Assert.That(bound.Model, Is.EqualTo("synthetic"));
        Assert.That(bound.Verification, Is.EqualTo("proposed")); Assert.That(bound.FrameRetained, Is.False);
        Assert.That(bound.LatencyMs, Is.EqualTo(0f)); Assert.That(bound.SourceTime, Is.EqualTo(SourceTime));
        Assert.That(bound.Objects[0].Label, Is.EqualTo("Synthetic left"));
        Assert.That(bound.Objects[0].Confidence, Is.EqualTo(.4f));
        Assert.That(bound.Objects[0].MaskConfidence, Is.EqualTo(.8f));
        Assert.That(bound.Objects[0].MaskPixels, Is.EqualTo(500));
        Assert.That(bound.Objects[0].Box.X0, Is.EqualTo(.1f));
        Assert.That(bound.Objects[0].Contour[0], Is.EqualTo(new Vector2(.1f, .2f)));
        Assert.That(LiveSceneAttention.IsCurrent(selected, bound, Now), Is.True);
        Assert.That(LiveSceneAttention.TrySelect(bound, Now, Left, null, out var again), Is.True);
        Assert.That(again!.MaskSha256, Is.EqualTo(new string('b', 64)));
        Assert.That(LiveSceneSource.TryCreate(source, request, SourceTime, Now, out _), Is.False);
    }

    [Test]
    public void MutablePresentationCopiesCannotRewriteAdmittedEvidence()
    {
        var request = Request(); var source = Source(request);
        Assert.That(LiveSceneSource.TryCreate(source, request, SourceTime, Now, out var bound), Is.True);
        var proposal = bound!.Objects[0];
        proposal.Box.X0 = .9f;
        var grounding = proposal.GroundingFor(bound);
        grounding.Box!.X0 = .9f; grounding.Contour![0].X = .9f;
        grounding.Spatial!.MaskSha256 = new string('f', 64); grounding.Spatial.Verification = "confirmed";
        Assert.That(proposal.Box.X0, Is.EqualTo(.1f));
        Assert.That(proposal.Contour[0], Is.EqualTo(new Vector2(.1f, .2f)));
        Assert.That(proposal.GroundingFor(bound).Spatial!.Verification, Is.EqualTo("proposed"));
        Assert.That(((IList<LiveSceneProposal>)bound.Objects).IsReadOnly, Is.True);
        Assert.That(((IList<Vector2>)proposal.Contour).IsReadOnly, Is.True);
        Assert.That(((IList<int>)proposal.Triangles).IsReadOnly, Is.True);
        Assert.That(LiveSceneAttention.TrySelect(bound, Now, Left, null, out var selected), Is.True);
        Assert.That(selected!.MaskSha256, Is.EqualTo(new string('b', 64)));
    }

    [TestCase("same")]
    [TestCase("event")]
    [TestCase("mask")]
    [TestCase("order")]
    [TestCase("time")]
    public void CachedTargetCannotTransferToAnotherAdmittedSource(string change)
    {
        var request = Request(); var source = Source(request);
        Assert.That(LiveSceneSource.TryCreate(source, request, SourceTime, Now, out var original), Is.True);
        Assert.That(LiveSceneAttention.TrySelect(original!, Now, Left, null, out var selected), Is.True);
        var sourceTime = SourceTime;
        switch (change)
        {
            case "event": source.EventId = "synthetic-next-event"; break;
            case "mask": source.Objects[0].MaskSha256 = new string('d', 64); break;
            case "order": source.Objects.Reverse(); break;
            case "time": sourceTime += .5f; break;
        }
        Assert.That(LiveSceneSource.TryCreate(source, request, sourceTime, Now, out var replacement), Is.True);
        Assert.That(LiveSceneAttention.IsCurrent(selected, replacement!, Now), Is.False);
        Assert.That(LiveSceneAttention.TrySelect(replacement!, Now, Left, null, out var next), Is.True);
        Assert.That(next, Is.Not.SameAs(selected));
        Assert.That(selected!.SourceTime, Is.EqualTo(SourceTime));
    }

    [TestCase("frame")]
    [TestCase("hash")]
    [TestCase("event")]
    [TestCase("confirmation")]
    [TestCase("mask")]
    [TestCase("contour")]
    public void ImmutableAdmissionRejectsInvalidSourceEvidence(string change)
    {
        var request = Request(); var source = Source(request);
        switch (change)
        {
            case "frame": source.FrameId = "another-frame"; break;
            case "hash": source.FrameSha256 = new string('f', 64); break;
            case "event": source.EventId = ""; break;
            case "confirmation": source.Verification = "confirmed"; break;
            case "mask": source.Objects[0].MaskSha256 = ""; break;
            case "contour": source.Objects[0].Contour[0].X = float.NaN; break;
        }
        Assert.That(LiveSceneSource.TryCreate(source, request, SourceTime, Now, out var bound), Is.False);
        Assert.That(bound, Is.Null);
    }

    [TestCase(13f, true)]
    [TestCase(13.001f, false)]
    [TestCase(9.999f, false)]
    [TestCase(float.NaN, false)]
    public void CachedSelectionAndRetentionUseOriginalThreeSecondLifetime(float now, bool expected)
    {
        var request = Request(); var source = Source(request);
        Assert.That(LiveSceneSource.TryCreate(source, request, SourceTime, Now, out var bound), Is.True);
        Assert.That(LiveSceneAttention.TrySelect(bound!, Now, Left, null, out var selected), Is.True);
        Assert.That(LiveSceneAttention.TrySelect(bound!, now, Left, null, out _), Is.EqualTo(expected));
        Assert.That(LiveSceneAttention.IsCurrent(selected, bound!, now), Is.EqualTo(expected));
        Assert.That(bound!.SourceTime, Is.EqualTo(SourceTime));
        Assert.That(selected!.SourceTime, Is.EqualTo(SourceTime));
    }

    [Test]
    public void CachedPointerMissAndOverlapStayUnknown()
    {
        var request = Request(); var source = Source(request);
        Assert.That(LiveSceneSource.TryCreate(source, request, SourceTime, Now, out var bound), Is.True);
        Assert.That(LiveSceneAttention.TrySelect(bound!, Now, Left, new Vector2(.5f, .5f), out _), Is.False);
        Assert.That(LiveSceneAttention.TrySelect(bound!, Now, Left, new Vector2(float.NaN, float.NaN), out _), Is.False);
        Assert.That(LiveSceneAttention.TrySelect(bound!, Now, Left, Right, out var pointer), Is.True);
        Assert.That(pointer!.ObjectIndex, Is.EqualTo(1)); Assert.That(pointer.FromPointer, Is.True);
        source.Objects[1] = Object(.1f, .4f, 'd');
        Assert.That(LiveSceneSource.TryCreate(source, request, SourceTime, Now, out var overlap), Is.True);
        Assert.That(LiveSceneAttention.TrySelect(overlap!, Now, Right, Left, out _), Is.False);
    }

    [Test]
    public void ExpiredEvidenceCannotBeAdmittedAtReceiptTime()
    {
        var request = Request();
        Assert.That(LiveSceneSource.TryCreate(Source(request), request, SourceTime, 13.001f, out var bound), Is.False);
        Assert.That(bound, Is.Null);
    }

    private static SceneObservationRequest Request() => new() {
        StreamId = Guid.NewGuid().ToString(), FrameId = Guid.NewGuid().ToString(), Sequence = 7,
        Frame = new FrameData { CapturedAt = "1970-01-01T16:00:00Z" }
    };
    private static SceneObservation Source(SceneObservationRequest request) => new() {
        StreamId=request.StreamId, FrameId=request.FrameId, Sequence=request.Sequence,
        CapturedAt=request.Frame.CapturedAt, EventId="synthetic-event", Provider="fixture", Model="synthetic",
        FrameSha256="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", Verification="proposed",
        Objects = new List<SceneObject> { Object(.1f, .4f, 'b'), Object(.6f, .9f, 'c') }
    };
    private static SceneObject Object(float left, float right, char mask) => new() {
        Label=left < .5f ? "Synthetic left" : "Synthetic right", Confidence=.4f, MaskConfidence=.8f,
        MaskSha256=new string(mask,64), MaskPixels=500, Box=new Box2 { X0=left,Y0=.2f,X1=right,Y1=.8f },
        Contour=new List<Point2> { new() { X=left,Y=.2f }, new() { X=right,Y=.2f },
            new() { X=right,Y=.8f }, new() { X=left,Y=.8f } }
    };
}
