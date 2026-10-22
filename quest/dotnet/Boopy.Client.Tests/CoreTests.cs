using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Numerics;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class GeometryTests
    {
        [Test]
        public void FlipsTopLeftImageCoordinatesIntoTheBottomLeftViewport()
        {
            Assert.That(Geometry.ToViewport(0.25f, 0.1f), Is.EqualTo(new Vector2(0.25f, 0.9f)));
            var back = Geometry.FromViewport(new Vector2(0.25f, 0.9f));
            Assert.That(back.X, Is.EqualTo(0.25f).Within(1e-6));
            Assert.That(back.Y, Is.EqualTo(0.1f).Within(1e-6));
        }

        [Test]
        public void AnchorsBoxesAtTheirCenterAndTheSceneNowhere()
        {
            var box = new Grounding { Kind = "box", Box = new Box2 { X0 = 0.2f, Y0 = 0.4f, X1 = 0.6f, Y1 = 0.8f } };
            Assert.That(Geometry.Anchor(box), Is.EqualTo(new Vector2(0.4f, 0.6f)));
            Assert.That(Geometry.Anchor(new Grounding { Kind = "point", Point = new Point2 { X = 0.1f, Y = 0.2f } }),
                Is.EqualTo(new Vector2(0.1f, 0.2f)));
            Assert.That(Geometry.Anchor(new Grounding { Kind = "scene" }), Is.Null);
        }

        [Test]
        public void SamplesDepthBetweenCellsAndSkipsCellsWithoutAnAnswer()
        {
            var grid = new DepthGrid { Columns = 2, Rows = 2, Meters = new float?[] { 1f, 3f, null, 2f } };
            Assert.That(Geometry.SampleDepth(grid, new Vector2(0.25f, 0.25f)), Is.EqualTo(1f).Within(1e-5));
            Assert.That(Geometry.SampleDepth(grid, new Vector2(0.5f, 0.25f)), Is.EqualTo(2f).Within(1e-5));
            // Bottom-left has no depth: the answer is the mean of the nearest cells that do.
            Assert.That(Geometry.SampleDepth(grid, new Vector2(0.25f, 0.75f)), Is.EqualTo(1.5f).Within(1e-5));
            var empty = new DepthGrid { Columns = 1, Rows = 1, Meters = new float?[] { null } };
            Assert.That(Geometry.SampleDepth(empty, new Vector2(0.5f, 0.5f)), Is.Null);
        }

        [Test]
        public void ListsCellCentersRowByRowFromTheTopLeft()
        {
            var centers = Geometry.CellCenters(4, 3).ToList();
            Assert.That(centers.Count, Is.EqualTo(12));
            Assert.That(centers[0], Is.EqualTo(new Vector2(0.125f, 1f / 6f)));
            Assert.That(centers[4], Is.EqualTo(new Vector2(0.125f, 0.5f)));
        }

        [Test]
        public void ArcsSceneChipsBelowTheEyesAtArmsLength()
        {
            var eyes = new Vector3(0f, 1.2f, 0f);
            var spots = Layout.SceneArc(eyes, new Vector3(0f, -0.3f, 1f), 7);
            Assert.That(spots.Count, Is.EqualTo(7));
            Assert.That(spots.All(spot => Math.Abs(Vector3.Distance(spot, eyes) - 0.85f) < 1e-4), Is.True);
            Assert.That(spots.All(spot => spot.Y < eyes.Y), Is.True);
            Assert.That(spots[2].X, Is.EqualTo(0f).Within(1e-5), "the middle of the first row faces the referent");
        }
    }

    public class WavTests
    {
        [Test]
        public void EncodesSixteenKilohertzMonoPcm()
        {
            var samples = Enumerable.Repeat(0.5f, 48000).ToArray();
            var wav = Wav.Encode(samples, samples.Length, 1, 48000)!;
            Assert.That(Encoding.ASCII.GetString(wav, 0, 4), Is.EqualTo("RIFF"));
            Assert.That(Encoding.ASCII.GetString(wav, 8, 4), Is.EqualTo("WAVE"));
            Assert.That(BitConverter.ToInt32(wav, 24), Is.EqualTo(16000));
            Assert.That(BitConverter.ToInt16(wav, 22), Is.EqualTo(1));
            Assert.That(BitConverter.ToInt32(wav, 40), Is.EqualTo(16000 * 2));
            Assert.That(BitConverter.ToInt16(wav, 44), Is.EqualTo((short)Math.Round(0.5 * short.MaxValue)));
        }

        [Test]
        public void MixesStereoDownAndRefusesTooShortClips()
        {
            var stereo = new float[16000 * 2];
            for (var i = 0; i < stereo.Length; i += 2)
            {
                stereo[i] = 1f;
                stereo[i + 1] = 0f;
            }
            var wav = Wav.Encode(stereo, stereo.Length, 2, 16000)!;
            Assert.That(BitConverter.ToInt16(wav, 44), Is.EqualTo((short)Math.Round(0.5 * short.MaxValue)));
            Assert.That(Wav.Encode(new float[1000], 1000, 1, 16000), Is.Null);
        }
    }

    public class PinchGestureTests
    {
        [Test]
        public void AQuickPinchIsATap()
        {
            var pinch = new PinchGesture();
            Assert.That(pinch.Update(true, 0.9f, false, 0f), Is.EqualTo(PinchEvent.Began));
            Assert.That(pinch.Update(true, 0.7f, false, 0.1f), Is.EqualTo(PinchEvent.None), "inside the hysteresis");
            Assert.That(pinch.Update(true, 0.2f, false, 0.2f), Is.EqualTo(PinchEvent.Tapped));
        }

        [Test]
        public void AHeldPinchIsTalkingUntilLetGo()
        {
            var pinch = new PinchGesture();
            pinch.Update(true, 0.95f, false, 0f);
            Assert.That(pinch.Update(true, 0.95f, false, 0.4f), Is.EqualTo(PinchEvent.Holding));
            Assert.That(pinch.Update(true, 0.95f, false, 2f), Is.EqualTo(PinchEvent.None));
            Assert.That(pinch.Update(true, 0.1f, false, 2.1f), Is.EqualTo(PinchEvent.Released));
        }

        [Test]
        public void ASlowCaptureDoesNotTurnAHoldIntoATap()
        {
            var pinch = new PinchGesture();
            Assert.That(pinch.Update(true, 0.95f, false, 0f), Is.EqualTo(PinchEvent.Began));
            // No frame was sampled between capture beginning and the person letting go.
            Assert.That(pinch.Update(true, 0.1f, false, 0.6f), Is.EqualTo(PinchEvent.Released));
            Assert.That(pinch.Down, Is.False);
            Assert.That(pinch.Holding, Is.False);
        }

        [Test]
        public void LosingTheHandOrTheSystemGestureCancels()
        {
            var pinch = new PinchGesture();
            pinch.Update(true, 0.95f, false, 0f);
            Assert.That(pinch.Update(false, 0f, false, 0.5f), Is.EqualTo(PinchEvent.Cancelled));
            pinch.Update(true, 0.95f, false, 1f);
            Assert.That(pinch.Update(true, 0.95f, true, 1.1f), Is.EqualTo(PinchEvent.Cancelled));
        }
    }

    public class SeatedPointingTests
    {
        [Test]
        public void AHandRestingPalmDownHasNoRay()
        {
            var head = new HeadPose(new Vector3(0f, 1.2f, 0f), new Vector3(0f, 0f, 1f));
            var resting = new HandPosture(true, true, new Vector3(0.2f, 0.8f, 0.4f), new Vector3(0.2f, 0.8f, 0.35f), new Vector3(0f, -1f, 0f));
            Assert.That(SeatedPointing.Aim(head, resting).Active, Is.False);
            var pointing = new HandPosture(true, true, new Vector3(0.2f, 0.9f, 0.4f), new Vector3(0.2f, 0.9f, 0.35f), new Vector3(-1f, 0f, 0f));
            Assert.That(SeatedPointing.Aim(head, pointing).Active, Is.True);
        }
    }

    public class ChipStyleTests
    {
        [TestCase("proposed", "model", 0.9f, ChipTone.Proposed, "likely")]
        [TestCase("proposed", "model", 0.3f, ChipTone.Proposed, "unsure")]
        [TestCase("confirmed", "model", 0.9f, ChipTone.Confirmed, "confirmed")]
        [TestCase("confirmed", "person", null, ChipTone.Confirmed, "yours")]
        [TestCase("rejected", "model", 0.9f, ChipTone.Rejected, "not this")]
        [TestCase("known", "model", 0.9f, ChipTone.Known, "you know this")]
        public void ShowsStateInWords(string status, string origin, float? confidence, ChipTone tone, string tag)
        {
            var style = ChipStyles.For(new Item { Status = status, Origin = origin, Confidence = confidence }, false);
            Assert.That(style.Tone, Is.EqualTo(tone));
            Assert.That(style.Tag, Is.EqualTo(tag));
        }

        [Test]
        public void StrikesThroughRejectedLabels()
        {
            var item = new Item { Label = "Tents", Status = "rejected" };
            Assert.That(ChipStyles.Caption(item, ChipStyles.For(item, false)), Does.StartWith("<s>Tents</s>"));
        }
    }

    public class ProtocolTests
    {
        [Test]
        public void ReadsTheSessionViewTheServiceSends()
        {
            var json = File.ReadAllText(Path.Combine(TestContext.CurrentContext.TestDirectory, "Fixtures", "session-view.json"));
            var view = Wire.Read<SessionView>(json);
            Assert.That(view.State, Is.EqualTo("review"));
            Assert.That(view.Items.Single(item => item.Id == view.IntentId).Kind, Is.EqualTo("goal"));
            var tents = view.Items.Single(item => item.Label == "Tents");
            Assert.That(tents.Status, Is.EqualTo("rejected"));
            Assert.That(tents.Note, Is.EqualTo("we didn't camp"));
            Assert.That(tents.Grounding.Box, Is.Not.Null);
            Assert.That(view.Items.Any(item => item.Origin == "person"), Is.True);
            Assert.That(view.Observations[0].CapturedAt, Is.EqualTo("1970-01-01T18:00:00.000Z"), "timestamps stay as sent");
        }

        [Test]
        public void WritesCamelCaseWithoutNulls()
        {
            var request = new StartSessionRequest
            {
                Frame = new FrameData { Jpeg = "abc", Width = 1280, Height = 960, CapturedAt = "1970-01-01T18:00:00Z" },
                Cues = new Cues { Gaze = new Cue { Point = new Point2 { X = 0.5f, Y = 0.5f }, OnSurface = true } },
                Speech = new SpeechData { Wav = "UklGRg==" },
            };
            var json = Newtonsoft.Json.JsonConvert.DeserializeObject<JObject>(Wire.Write(request), Wire.Settings)!;
            Assert.That(json["frame"]!["capturedAt"]!.ToString(), Is.EqualTo("1970-01-01T18:00:00Z"));
            Assert.That(json["cues"]!["gaze"]!["onSurface"]!.Value<bool>(), Is.True);
            Assert.That(json["cues"]!["pointer"], Is.Null);
            Assert.That(json["speech"]!["text"], Is.Null);
        }
    }

    public class ServiceClientTests
    {
        private sealed class Answer : HttpMessageHandler
        {
            private readonly HttpStatusCode status;
            private readonly string body;
            public HttpRequestMessage? Request;

            public Answer(HttpStatusCode status, string body)
            {
                this.status = status;
                this.body = body;
            }

            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel)
            {
                if (request.Method == HttpMethod.Get)
                    return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                    { Content = new StringContent("{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}}") });
                Request = request;
                return Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
            }
        }

        [Test]
        public async Task ExplicitSaveReturnsTheServiceReceiptWithoutClaimingDelivery()
        {
            var handler = new Answer(HttpStatusCode.OK, "{\"id\":\"ses_test\",\"state\":\"committed\",\"committed\":{\"packageId\":\"ctx_test\",\"at\":\"1970-01-01T01:00:00Z\",\"summary\":\"1 confirmed, 2 accepted\"}}");
            using var client = new ServiceClient(handler: handler);
            var view = await client.CommitAsync("ses_test");
            Assert.That(handler.Request!.Method, Is.EqualTo(HttpMethod.Post));
            Assert.That(handler.Request.RequestUri!.AbsolutePath, Is.EqualTo("/v1/sessions/ses_test/commit"));
            Assert.That(view.State, Is.EqualTo("committed"));
            Assert.That(view.Committed!.PackageId, Is.EqualTo("ctx_test"));
            Assert.That(view.Committed.Summary, Is.EqualTo("1 confirmed, 2 accepted"));
        }

        [Test]
        public void TurnsARefusalIntoItsCodeAndWords()
        {
            var handler = new Answer(HttpStatusCode.Conflict, "{\"error\":{\"code\":\"busy\",\"message\":\"Still working on the last request.\"}}");
            using var client = new ServiceClient(handler: handler);
            var error = Assert.ThrowsAsync<ServiceException>(() => client.CommitAsync("ses_1"));
            Assert.That(error!.Code, Is.EqualTo("busy"));
            Assert.That(error.Status, Is.EqualTo(409));
            Assert.That(handler.Request!.RequestUri!.ToString(), Is.EqualTo("http://127.0.0.1:47900/v1/sessions/ses_1/commit"));
        }
    }
}
