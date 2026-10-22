using System;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests;

public sealed class CameraFrameTimeTests
{
    private static readonly DateTime ImageAt = new(1970, 1, 1, 12, 0, 0, DateTimeKind.Utc);

    [Test]
    public void CachedImageCannotGainFreshnessWhenSampledAgain()
    {
        Assert.That(CameraFrameTime.TrySourceTime(ImageAt, ImageAt.AddSeconds(.2), 100.2f, out var first), Is.True);
        Assert.That(CameraFrameTime.TrySourceTime(ImageAt, ImageAt.AddSeconds(2.8), 102.8f, out var repeated), Is.True);
        Assert.That(repeated, Is.EqualTo(first).Within(.0001));
        Assert.That(CameraFrameTime.IsFresh(repeated, 103.01f), Is.False);
        Assert.That(CameraFrameTime.TrySourceTime(ImageAt, ImageAt.AddSeconds(30), 130, out _), Is.False);
    }

    [Test]
    public void InferenceTimeConsumesRemainingSourceLifetime()
    {
        Assert.That(CameraFrameTime.TrySourceTime(ImageAt, ImageAt.AddSeconds(2.8), 102.8f, out var source), Is.True);
        // A fast 300ms request is still too late for an already 2.8s-old image.
        Assert.That(CameraFrameTime.IsFresh(source, 103.1f), Is.False);
        Assert.That(CameraFrameTime.IsFresh(source, 103f), Is.True);
    }

    [Test]
    public void ExpiryAfterCaptureDoesNotConsultAChangedWallClock()
    {
        Assert.That(CameraFrameTime.TrySourceTime(ImageAt, ImageAt.AddSeconds(.5), 50, out var source), Is.True);
        Assert.That(CameraFrameTime.IsFresh(source, 52.5f), Is.True);
        Assert.That(CameraFrameTime.IsFresh(source, 52.501f), Is.False);
        Assert.That(CameraFrameTime.IsFresh(source, 49), Is.False);
    }

    [Test]
    public void MissingUnspecifiedFutureAndStaleImageTimesAreRejected()
    {
        foreach (var timestamp in new[] { default(DateTime), DateTime.UnixEpoch, DateTime.SpecifyKind(ImageAt, DateTimeKind.Unspecified), ImageAt.AddTicks(1), ImageAt.AddSeconds(-3.001) })
            Assert.That(CameraFrameTime.TrySourceTime(timestamp, ImageAt, 10, out _), Is.False, timestamp.ToString("o"));
        Assert.That(CameraFrameTime.TrySourceTime(ImageAt, ImageAt, float.NaN, out _), Is.False);
        Assert.That(CameraFrameTime.IsFresh(float.NaN, 10), Is.False);
        Assert.That(CameraFrameTime.IsFresh(0, float.PositiveInfinity), Is.False);
    }
}
