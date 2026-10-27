using System;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Numerics;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace Boopy.Client.Tests;

public sealed class RecordedSceneTests
{
    private const string Recording = "rec_0123456789abcdef0123456789abcdef";
    private const string Frame = "rfr_fedcba9876543210fedcba9876543210";
    private const string Other = "rfr_00000000000000000000000000000001";
    // Synthetic bytes shaped like a JPEG (start and end markers); no picture.
    private static readonly byte[] Jpeg = { 0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 0xff, 0xd9 };
    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static string SceneJson(string? capturedAt = "\"1970-01-01T00:00:00Z\"", string trust = "unverified", string kind = "video",
        int width = 957, int height = 1280, string? sha = null, string frames = null!) =>
        $"{{\"scene\":{{\"recordingId\":\"{Recording}\",\"frameId\":\"{Frame}\",\"kind\":\"{kind}\",\"width\":{width},\"height\":{height}," +
        $"\"sourceTimeSeconds\":4.2,\"capturedAt\":{{\"value\":{capturedAt ?? "null"},\"trust\":\"{trust}\"}},\"frameSha256\":\"{sha ?? Sha(Jpeg)}\"," +
        $"\"frames\":{frames ?? $"[{{\"frameId\":\"{Frame}\",\"seconds\":4.2,\"frameSha256\":\"{Sha(Jpeg)}\"}}]"}}}}}";

    private sealed class Transport : HttpMessageHandler
    {
        public HttpStatusCode Status = HttpStatusCode.OK;
        public string Body = "{\"scene\":null}";
        public byte[]? Bytes;
        public string MediaType = "application/json";
        public int Requests;
        public string? Path;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel)
        {
            Requests++;
            Assert.That(request.Method, Is.EqualTo(HttpMethod.Get));
            Path = request.RequestUri!.AbsolutePath;
            HttpContent content = Bytes != null ? new ByteArrayContent(Bytes) : new StringContent(Body);
            content.Headers.ContentType = new MediaTypeHeaderValue(MediaType);
            return Task.FromResult(new HttpResponseMessage(Status) { Content = content });
        }
    }

    [Test] public void ReadsTheScenesWireShapeWithItsCaptureTimeAsGiven()
    {
        var scene = Wire.Read<RecordedSceneEnvelope>(SceneJson()).Scene!;
        Assert.That(scene.RecordingId, Is.EqualTo(Recording));
        Assert.That(scene.FrameId, Is.EqualTo(Frame));
        Assert.That(scene.Kind, Is.EqualTo("video"));
        Assert.That((scene.Width, scene.Height), Is.EqualTo((957, 1280)));
        Assert.That(scene.SourceTimeSeconds, Is.EqualTo(4.2f));
        Assert.That(scene.CapturedAt.Value, Is.EqualTo("1970-01-01T00:00:00Z"));
        Assert.That(scene.CapturedAt.Trust, Is.EqualTo("unverified"));
        Assert.That(scene.Frames.Single().FrameId, Is.EqualTo(Frame));
        Assert.That(RecordedScenes.Valid(scene), Is.True);
        Assert.That(Wire.Read<RecordedSceneEnvelope>("{\"scene\":null}").Scene, Is.Null);
    }

    [Test] public void AnUnknownCaptureTimeStaysUnknown()
    {
        var scene = Wire.Read<RecordedSceneEnvelope>(SceneJson(capturedAt: null, trust: "unknown")).Scene!;
        Assert.That(scene.CapturedAt.Value, Is.Null);
        Assert.That(RecordedScenes.Valid(scene), Is.True);
    }

    [TestCase("rec_0123456789abcdef0123456789abcdef", true)]
    [TestCase("rec_0123456789ABCDEF0123456789ABCDEF", false)]
    [TestCase("rec_0123456789abcdef0123456789abcde", false)]
    [TestCase("rec_0123456789abcdef0123456789abcdef0", false)]
    [TestCase("rfr_0123456789abcdef0123456789abcdef", false)]
    [TestCase("rec_../../0123456789abcdef0123456789", false)]
    [TestCase("", false)]
    [TestCase(null, false)]
    public void RecordingIdsMatchTheMacsPatternExactly(string? id, bool valid) => Assert.That(RecordedScenes.IsRecordingId(id), Is.EqualTo(valid));

    [TestCase("rfr_fedcba9876543210fedcba9876543210", true)]
    [TestCase("rec_fedcba9876543210fedcba9876543210", false)]
    [TestCase("rfr_fedcba9876543210fedcba987654321g", false)]
    [TestCase("rfr_fedcba9876543210fedcba9876543210\n", false)]
    [TestCase(null, false)]
    public void FrameIdsMatchTheMacsPatternExactly(string? id, bool valid) => Assert.That(RecordedScenes.IsFrameId(id), Is.EqualTo(valid));

    [Test] public void AScenePromisingAnythingElseIsNotShown()
    {
        Assert.That(RecordedScenes.Valid(null), Is.False);
        Assert.That(RecordedScenes.Valid(Wire.Read<RecordedSceneEnvelope>(SceneJson(kind: "live")).Scene), Is.False);
        Assert.That(RecordedScenes.Valid(Wire.Read<RecordedSceneEnvelope>(SceneJson(width: 0)).Scene), Is.False);
        Assert.That(RecordedScenes.Valid(Wire.Read<RecordedSceneEnvelope>(SceneJson(height: 4097)).Scene), Is.False);
        Assert.That(RecordedScenes.Valid(Wire.Read<RecordedSceneEnvelope>(SceneJson(sha: new string('A', 64))).Scene), Is.False);
        Assert.That(RecordedScenes.Valid(Wire.Read<RecordedSceneEnvelope>(SceneJson(sha: "abc")).Scene), Is.False);
        Assert.That(RecordedScenes.Valid(Wire.Read<RecordedSceneEnvelope>(SceneJson(trust: "trusted")).Scene), Is.False);
        Assert.That(RecordedScenes.Valid(Wire.Read<RecordedSceneEnvelope>(SceneJson(capturedAt: "\"1970-01-01T00:00:00Z\"", trust: "unknown")).Scene), Is.False,
            "A capture time the Mac calls unknown cannot carry a value.");
        Assert.That(RecordedScenes.Valid(Wire.Read<RecordedSceneEnvelope>(SceneJson(frames: "[{\"frameId\":\"../x\",\"seconds\":1,\"frameSha256\":\"" + Sha(Jpeg) + "\"}]")).Scene), Is.False);
        var photo = Wire.Read<RecordedSceneEnvelope>(SceneJson(kind: "photo", frames: "[]")).Scene!;
        photo.SourceTimeSeconds = null;
        Assert.That(RecordedScenes.Valid(photo), Is.True);
    }

    [Test] public void AClipsStillShowsWhereItIsHeldInTheClipAndAPhotoShowsNothing()
    {
        var clip = Wire.Read<RecordedSceneEnvelope>(SceneJson()).Scene!;
        Assert.That(RecordedScenes.Progress(clip), Is.Null, "With no clip length, no bar.");
        clip.DurationSeconds = 12.232f;
        Assert.That(RecordedScenes.Valid(clip), Is.True);
        Assert.That(RecordedScenes.Progress(clip), Is.EqualTo(4.2f / 12.232f).Within(1e-6f));
        clip.SourceTimeSeconds = 0f;
        Assert.That(RecordedScenes.Progress(clip), Is.EqualTo(0f));
        clip.SourceTimeSeconds = 12.232f;
        Assert.That(RecordedScenes.Progress(clip), Is.EqualTo(1f));
        clip.DurationSeconds = 0f; clip.SourceTimeSeconds = 0f;
        Assert.That(RecordedScenes.Progress(clip), Is.Null, "A clip of no length has no bar.");
        clip.DurationSeconds = 10f; clip.SourceTimeSeconds = 11f;
        Assert.That(RecordedScenes.Valid(clip), Is.False, "A still past the clip's end.");
        clip.DurationSeconds = float.NaN;
        Assert.That(RecordedScenes.Valid(clip), Is.False);
        var photo = Wire.Read<RecordedSceneEnvelope>(SceneJson(kind: "photo", frames: "[]")).Scene!;
        photo.SourceTimeSeconds = null; photo.DurationSeconds = 3f;
        Assert.That(RecordedScenes.Progress(photo), Is.Null);
        Assert.That(Wire.Read<RecordedSceneEnvelope>(SceneJson().Replace("\"sourceTimeSeconds\":4.2", "\"sourceTimeSeconds\":4.2,\"durationSeconds\":12.232")).Scene!.DurationSeconds,
            Is.EqualTo(12.232f));
    }

    private const string Played = ",\"video\":{\"url\":\"/v1/recorded/rec_0123456789abcdef0123456789abcdef/video\",\"sha256\":\"" + VideoSha + "\"," +
        "\"width\":1920,\"height\":1080,\"frameRate\":72,\"durationSeconds\":12.5}" +
        ",\"projection\":{\"tanLeft\":0.9,\"tanRight\":0.8,\"tanUp\":0.5,\"tanDown\":0.55,\"source\":\"measured-device-profile\",\"profile\":\"quest3-capture-16x9\",\"centring\":\"inferred\"}";
    private const string VideoSha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    [Test] public void AClipCarriesItsVideoAndHowItsCameraSawAndPlaysFromUnderTheService()
    {
        var clip = Wire.Read<RecordedSceneEnvelope>(SceneJson().Replace(",\"frames\"", Played + ",\"frames\"")).Scene!;
        Assert.That(RecordedScenes.Valid(clip), Is.True);
        Assert.That((clip.Video!.Url, clip.Video.Sha256, clip.Video.Width, clip.Video.Height, clip.Video.FrameRate, clip.Video.DurationSeconds),
            Is.EqualTo(("/v1/recorded/" + Recording + "/video", VideoSha, 1920, 1080, (float?)72f, (float?)12.5f)));
        Assert.That((clip.Projection!.TanLeft, clip.Projection.TanRight, clip.Projection.TanUp, clip.Projection.TanDown), Is.EqualTo((.9f, .8f, .5f, .55f)));
        Assert.That((clip.Projection.Source, clip.Projection.Profile, clip.Projection.Centring), Is.EqualTo(("measured-device-profile", "quest3-capture-16x9", "inferred")));
        using (var client = new ServiceClient("http://127.0.0.1:47900"))
            Assert.That(client.RecordedVideoUrl(clip.Video).ToString(), Is.EqualTo("http://127.0.0.1:47900/v1/recorded/" + Recording + "/video"));
        // Never another host, a way out of the API, or a video on a photo; no frame rate, length or reach is no clip.
        foreach (var path in new[] { "http://example.com/v1/x", "//example.com/v1/x", "/v1/../health", "/static/x", "/v1/a b" })
        {
            clip.Video.Url = path;
            Assert.That(RecordedScenes.Valid(clip), Is.False, path);
            using var client = new ServiceClient();
            Assert.Throws<ArgumentException>(() => client.RecordedVideoUrl(clip.Video), path);
        }
        clip.Video.Url = "v1/recorded/" + Recording + "/video";
        Assert.That(RecordedScenes.Valid(clip), Is.True);
        clip.Video.FrameRate = 0f; Assert.That(RecordedScenes.Valid(clip), Is.False);
        clip.Video.FrameRate = null; clip.Video.DurationSeconds = null; Assert.That(RecordedScenes.Valid(clip), Is.True, "A length or rate the Mac does not know stays unknown.");
        clip.Video.Sha256 = "abc"; Assert.That(RecordedScenes.Valid(clip), Is.False);
        clip.Video.Sha256 = VideoSha; clip.Projection.Source = "guess"; Assert.That(RecordedScenes.Valid(clip), Is.False, "A projection from nowhere.");
        clip.Projection.Source = "lens-tag";
        clip.Video.FrameRate = 30f; clip.Video.DurationSeconds = float.PositiveInfinity; Assert.That(RecordedScenes.Valid(clip), Is.False);
        clip.Video.DurationSeconds = 12.5f; clip.Projection.TanUp = -.6f; Assert.That(RecordedScenes.Valid(clip), Is.False, "A frame of no height.");
        clip.Projection.TanUp = float.NaN; Assert.That(RecordedScenes.Valid(clip), Is.False);
        clip.Projection = null; Assert.That(RecordedScenes.Valid(clip), Is.True, "An unmeasured projection is not shown as measured.");
        var photo = Wire.Read<RecordedSceneEnvelope>(SceneJson(kind: "photo", frames: "[]").Replace(",\"frames\"", Played + ",\"frames\"")).Scene!;
        photo.SourceTimeSeconds = null;
        Assert.That(RecordedScenes.Valid(photo), Is.False, "A photo has no video.");
    }

    [Test] public void ABoopUsesTheAnalyzedStillNearestThePlayersTime()
    {
        var frames = $"[{{\"frameId\":\"{Frame}\",\"seconds\":4.2,\"frameSha256\":\"{Sha(Jpeg)}\"}},{{\"frameId\":\"{Other}\",\"seconds\":5.2,\"frameSha256\":\"{Sha(Jpeg)}\"}}]";
        var clip = Wire.Read<RecordedSceneEnvelope>(SceneJson(frames: frames)).Scene!;
        Assert.That(RecordedScenes.Nearest(clip, 0)!.FrameId, Is.EqualTo(Frame));
        Assert.That(RecordedScenes.Nearest(clip, 4.69)!.FrameId, Is.EqualTo(Frame));
        Assert.That(RecordedScenes.Nearest(clip, 4.71)!.FrameId, Is.EqualTo(Other));
        Assert.That(RecordedScenes.Nearest(clip, 60)!.FrameId, Is.EqualTo(Other));
        clip.Frames.Clear();
        Assert.That(RecordedScenes.Nearest(clip, 1), Is.Null);
    }

    private static readonly PicturePlane Picture = new PicturePlane(new Vector3(0.2f, 1.4f, 1.8f), Vector3.UnitX, Vector3.UnitY, 1.2f, 1.6f);

    [Test] public void ImagePointsMapOntoThePictureWithTheOriginAtItsTopLeft()
    {
        AssertNear(Picture.At(0f, 0f), new Vector3(-0.4f, 2.2f, 1.8f));
        AssertNear(Picture.At(1f, 1f), new Vector3(0.8f, 0.6f, 1.8f));
        AssertNear(Picture.At(0.5f, 0.5f), Picture.Center);
        AssertNear(Picture.At(0.25f, 0.75f, -Vector3.UnitZ, 0.001f), new Vector3(-0.1f, 1.0f, 1.799f));
    }

    [TestCase(0.5f, 0.5f)][TestCase(0.02f, 0.97f)][TestCase(0.9f, 0.1f)][TestCase(0f, 0f)][TestCase(1f, 1f)]
    public void ARayThroughAnImagePointReadsBackThatPoint(float x, float y)
    {
        var eyes = new Vector3(0.05f, 1.5f, 0f);
        var target = Picture.At(x, y);
        Assert.That(Picture.TryImage(eyes, Vector3.Normalize(target - eyes), out var u, out var v, out var hit), Is.True);
        Assert.That(u, Is.EqualTo(x).Within(1e-5f));
        Assert.That(v, Is.EqualTo(y).Within(1e-5f));
        AssertNear(hit, target);
    }

    [Test] public void ARayOffThePictureParallelToItOrAwayFromItMissesIt()
    {
        var eyes = new Vector3(0f, 1.5f, 0f);
        Assert.That(Picture.TryImage(eyes, Vector3.Normalize(Picture.At(1.05f, 0.5f) - eyes), out _, out _, out _), Is.False);
        Assert.That(Picture.TryImage(eyes, Vector3.Normalize(Picture.At(0.5f, -0.01f) - eyes), out _, out _, out _), Is.False);
        Assert.That(Picture.TryImage(eyes, Vector3.UnitX, out _, out _, out _), Is.False);
        Assert.That(Picture.TryImage(eyes, -Vector3.Normalize(Picture.Center - eyes), out _, out _, out _), Is.False);
        Assert.That(Picture.TryImage(new Vector3(0f, 1.5f, 3f), Vector3.UnitZ, out _, out _, out _), Is.False);
    }

    [Test] public async Task NoSceneAnOlderServiceOrRoutesTurnedOffReadAsNone()
    {
        var transport = new Transport();
        using (var client = new ServiceClient(handler: transport)) Assert.That(await client.ReadRecordedSceneAsync(), Is.Null);
        Assert.That(transport.Path, Is.EqualTo("/v1/recorded-scene"));
        using (var client = new ServiceClient(handler: new Transport { Status = HttpStatusCode.NotFound, Body = "{\"error\":{\"code\":\"not_found\",\"message\":\"x\"}}" }))
            Assert.That(await client.ReadRecordedSceneAsync(), Is.Null);
    }

    [Test] public async Task AShownSceneIsReadAndAnInvalidOneIsRefused()
    {
        using (var client = new ServiceClient(handler: new Transport { Body = SceneJson() }))
            Assert.That((await client.ReadRecordedSceneAsync())!.FrameId, Is.EqualTo(Frame));
        using (var client = new ServiceClient(handler: new Transport { Body = SceneJson(kind: "live") }))
            Assert.That((await Refused(() => client.ReadRecordedSceneAsync())).Code, Is.EqualTo("recorded_scene_invalid"));
        using (var client = new ServiceClient(handler: new Transport { Body = "<html>" }))
            Assert.That((await Refused(() => client.ReadRecordedSceneAsync())).Code, Is.EqualTo("recorded_scene_invalid"));
        using (var client = new ServiceClient(handler: new Transport { Status = HttpStatusCode.InternalServerError }))
            Assert.That((await Refused(() => client.ReadRecordedSceneAsync())).Code, Is.EqualTo("recorded_scene_failed"));
    }

    [Test] public async Task AFramesOutlinesAreItsOwnWellFormedObjects()
    {
        const string body = "{\"samples\":[" +
            "{\"frameId\":\"" + Frame + "\",\"seconds\":4.2,\"provider\":\"local\",\"model\":\"m\",\"latencyMs\":1,\"leftOut\":0,\"verification\":\"proposed\",\"objects\":[" +
            "{\"label\":\"tents\",\"confidence\":0.3,\"origin\":\"proposed\",\"box\":{\"x0\":0.1,\"y0\":0.2,\"x1\":0.5,\"y1\":0.6},\"contour\":[{\"x\":0.2,\"y\":0.3},{\"x\":0.4,\"y\":0.3},{\"x\":0.3,\"y\":0.5}]}," +
            "{\"label\":\"dune\",\"confidence\":0.3,\"origin\":\"proposed\",\"box\":{\"x0\":0,\"y0\":0.3,\"x1\":1,\"y1\":1},\"contour\":[]}," +
            "{\"label\":\"bad\",\"confidence\":0.3,\"origin\":\"proposed\",\"box\":{\"x0\":0.5,\"y0\":0.2,\"x1\":1.5,\"y1\":0.6},\"contour\":[]}]}," +
            "{\"frameId\":\"rfr_other\",\"seconds\":4.3,\"provider\":\"local\",\"model\":\"m\",\"latencyMs\":1,\"leftOut\":0,\"verification\":\"proposed\",\"objects\":[" +
            "{\"label\":\"tents\",\"confidence\":0.3,\"origin\":\"proposed\",\"box\":{\"x0\":0.6,\"y0\":0.2,\"x1\":0.7,\"y1\":0.3},\"contour\":[]}]}]}";
        var transport = new Transport { Body = body };
        using (var client = new ServiceClient(handler: transport))
        {
            var outlines = await client.ReadRecordedOutlinesAsync();
            Assert.That(transport.Path, Is.EqualTo("/v1/recorded-scene/outlines"));
            var on = outlines.On(Frame);
            Assert.That(on.Select(outlined => outlined.Label), Is.EqualTo(new[] { "tents", "dune" }), "Only this frame's well-formed objects.");
            var tents = on[0].Extent()!;
            Assert.That((tents.X0, tents.Y0, tents.X1, tents.Y1), Is.EqualTo((.2f, .3f, .4f, .5f)), "A contour's extent, not its looser box.");
            Assert.That(on[1].Extent()!.X1, Is.EqualTo(1f), "No contour: its box.");
            Assert.That(outlines.On("rfr_none"), Is.Empty);
        }
        using (var client = new ServiceClient(handler: new Transport { Status = HttpStatusCode.NotFound }))
            Assert.That((await client.ReadRecordedOutlinesAsync()).Samples, Is.Empty);
        using (var client = new ServiceClient(handler: new Transport { Body = "<html>" }))
            Assert.That((await Refused(() => client.ReadRecordedOutlinesAsync())).Code, Is.EqualTo("recorded_outlines_invalid"));
    }

    [Test] public async Task AStillIsTheExactBytesItsSceneNamed()
    {
        var transport = new Transport { Bytes = Jpeg, MediaType = "image/jpeg" };
        using var client = new ServiceClient(handler: transport);
        Assert.That(await client.ReadRecordedFrameAsync(Frame, Sha(Jpeg)), Is.EqualTo(Jpeg));
        Assert.That(transport.Path, Is.EqualTo("/v1/recorded-scene/frames/" + Frame));
    }

    [Test] public async Task AStillThatDiffersIsNotAJpegIsTooLargeOrIsGoneIsRefused()
    {
        using (var client = new ServiceClient(handler: new Transport { Bytes = Jpeg, MediaType = "image/jpeg" }))
            Assert.That((await Refused(() => client.ReadRecordedFrameAsync(Frame, Sha(new byte[] { 1 })))).Code, Is.EqualTo("recorded_frame_mismatch"));
        var png = new byte[] { 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a };
        using (var client = new ServiceClient(handler: new Transport { Bytes = png, MediaType = "image/jpeg" }))
            Assert.That((await Refused(() => client.ReadRecordedFrameAsync(Frame, Sha(png)))).Code, Is.EqualTo("recorded_frame_invalid"));
        using (var client = new ServiceClient(handler: new Transport { Bytes = Jpeg, MediaType = "text/html" }))
            Assert.That((await Refused(() => client.ReadRecordedFrameAsync(Frame, Sha(Jpeg)))).Code, Is.EqualTo("recorded_frame_invalid"));
        var large = new byte[RecordedScenes.MaxFrameBytes + 1]; large[0] = 0xff; large[1] = 0xd8; large[2] = 0xff;
        using (var client = new ServiceClient(handler: new Transport { Bytes = large, MediaType = "image/jpeg" }))
            Assert.That((await Refused(() => client.ReadRecordedFrameAsync(Frame, Sha(large)))).Code, Is.EqualTo("recorded_frame_invalid"));
        using (var client = new ServiceClient(handler: new Transport { Status = HttpStatusCode.NotFound, Body = "{}" }))
            Assert.That((await Refused(() => client.ReadRecordedFrameAsync(Frame, Sha(Jpeg)))).Code, Is.EqualTo("recorded_frame_unknown"));
    }

    [Test] public void AFrameIdOrDigestOutOfPatternSendsNoRequest()
    {
        var transport = new Transport { Bytes = Jpeg, MediaType = "image/jpeg" };
        using var client = new ServiceClient(handler: transport);
        Assert.ThrowsAsync<ArgumentException>(() => client.ReadRecordedFrameAsync("rfr_../../v1/health", Sha(Jpeg)));
        Assert.ThrowsAsync<ArgumentException>(() => client.ReadRecordedFrameAsync(Other, "not-a-digest"));
        Assert.That(transport.Requests, Is.Zero);
    }

    [Test] public void ATurnOnARecordedStillCarriesItsReferenceAndNoPixels()
    {
        var request = new StartSessionRequest { Frame = null, RecordedFrame = new RecordedFrameRef { RecordingId = Recording, FrameId = Frame } };
        var json = JObject.Parse(Wire.Write(request));
        Assert.That(json.ContainsKey("frame"), Is.False);
        Assert.That((string?)json["recordedFrame"]!["recordingId"], Is.EqualTo(Recording));
        Assert.That((string?)json["recordedFrame"]!["frameId"], Is.EqualTo(Frame));
        Assert.That(JObject.Parse(Wire.Write(new StartSessionRequest())).ContainsKey("recordedFrame"), Is.False);
    }

    private static async Task<ServiceException> Refused(Func<Task> call)
    {
        try { await call(); }
        catch (ServiceException refused) { return refused; }
        Assert.Fail("Expected a refusal.");
        throw new InvalidOperationException();
    }

    private static void AssertNear(Vector3 actual, Vector3 expected) =>
        Assert.That(Vector3.Distance(actual, expected), Is.LessThan(1e-5f), $"{actual} is not {expected}");
}
