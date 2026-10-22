using System;
using System.Collections.Generic;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests;

public sealed class LiveSceneTests
{
    private static SceneObservationRequest Request() => new() {StreamId=Guid.NewGuid().ToString(),FrameId=Guid.NewGuid().ToString(),Sequence=7,Frame=new FrameData {CapturedAt="1970-01-01T12:00:00Z"}};
    private static SceneObservation Response(SceneObservationRequest request) => new() {
        StreamId=request.StreamId,FrameId=request.FrameId,Sequence=request.Sequence,CapturedAt=request.Frame.CapturedAt,
        FrameSha256="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",EventId="synthetic-event",Provider="local",Model="synthetic",Verification="proposed",
        Objects=new List<SceneObject> {new() {Label="Synthetic object",Confidence=.5f,MaskConfidence=.8f,MaskSha256=new string('b',64),MaskPixels=800,Box=new Box2 {X0=.1f,Y0=.1f,X1=.9f,Y1=.9f},
            Contour=new List<Point2> {new(){X=.1f,Y=.1f},new(){X=.9f,Y=.1f},new(){X=.9f,Y=.9f},new(){X=.1f,Y=.9f}}}}
    };
    [Test] public void RequiresExactSourceAndUnverifiedOutput()
    {
        var request=Request();var result=Response(request);Assert.That(result.Matches(request),Is.True);
        result.FrameId=Guid.NewGuid().ToString();Assert.That(result.Matches(request),Is.False);
        result=Response(request);result.Sequence--;Assert.That(result.Matches(request),Is.False);
        result=Response(request);result.Verification="confirmed";Assert.That(result.Matches(request),Is.False);
        result=Response(request);result.CapturedAt="1970-01-01T12:00:01Z";Assert.That(result.Matches(request),Is.False);
        result=Response(request);result.FrameSha256=new string('a',64);Assert.That(result.Matches(request),Is.False);
    }
    [Test] public void RejectsUnusableOrNonfiniteContours()
    {
        var request=Request();var result=Response(request);result.Objects[0].Contour[0].X=float.NaN;
        Assert.That(result.Matches(request),Is.False);
        result=Response(request);result.Objects[0].Confidence=float.NaN;Assert.That(result.Matches(request),Is.False);
        result=Response(request);result.Objects[0].Contour.Clear();Assert.That(result.Matches(request),Is.False);
    }
}
