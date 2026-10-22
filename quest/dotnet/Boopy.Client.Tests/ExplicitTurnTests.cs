using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class ExplicitTurnTests
    {
        private sealed class LateResponse : HttpMessageHandler
        {
            public readonly List<HttpMethod> Methods = new List<HttpMethod>();
            public CancellationTokenSource Caller = new CancellationTokenSource();
            public bool CancelHealth, CancelPost, CancelRead;
            public bool ExpirePostDeadline;
            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel)
            {
                Methods.Add(request.Method);
                var health = request.RequestUri!.AbsolutePath == "/v1/health";
                if ((health && CancelHealth) || (request.Method == HttpMethod.Post && CancelPost) || (!health && request.Method == HttpMethod.Get && CancelRead)) Caller.Cancel();
                // Intentionally return after cancellation: fake transport models the completion race.
                if (request.Method == HttpMethod.Post && ExpirePostDeadline) await Task.Delay(50);
                return new HttpResponseMessage(HttpStatusCode.OK)
                { Content = new StringContent(health ? "{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}}" : "{\"id\":\"synthetic-session\",\"state\":\"review\"}") };
            }
        }

        [Test]
        public void ExplicitStopWinsOverLateSuccessfulResponseWithoutMutationReplay()
        {
            using var caller = new CancellationTokenSource();
            var handler = new LateResponse { Caller = caller, CancelPost = true };
            using var client = new ServiceClient(handler: handler);
            Assert.CatchAsync<OperationCanceledException>(() => client.UtterAsync("synthetic-session", new UtteranceRequest { Speech = new SpeechData { Text = "Synthetic whole scene request" } }, caller.Token));
            Assert.That(handler.Methods, Is.EqualTo(new[] { HttpMethod.Get, HttpMethod.Post }));
        }


        [Test]
        public void ExpiredDeadlineWinsOverLateSuccessfulResponseWithoutMutationReplay()
        {
            var handler = new LateResponse { ExpirePostDeadline = true };
            using var client = new ServiceClient(handler: handler, requestTimeout: TimeSpan.FromMilliseconds(10));
            var failure = Assert.ThrowsAsync<ServiceException>(() => client.UtterAsync("synthetic-session", new UtteranceRequest()));
            Assert.That(failure!.Code, Is.EqualTo("request_timeout"));
            Assert.That(handler.Methods, Is.EqualTo(new[] { HttpMethod.Get, HttpMethod.Post }));
        }

        [Test]
        public void StopDuringSuccessfulHealthPreflightPreventsMutation()
        {
            using var caller = new CancellationTokenSource();
            var handler = new LateResponse { Caller = caller, CancelHealth = true };
            using var client = new ServiceClient(handler: handler);
            Assert.CatchAsync<OperationCanceledException>(() => client.StartAsync(new StartSessionRequest(), caller.Token));
            Assert.That(handler.Methods, Is.EqualTo(new[] { HttpMethod.Get }));
        }

        [Test]
        public void StopDuringLateSessionReadRemainsCancellation()
        {
            using var caller = new CancellationTokenSource();
            var handler = new LateResponse { Caller = caller, CancelRead = true };
            using var client = new ServiceClient(handler: handler);
            Assert.CatchAsync<OperationCanceledException>(() => client.ReadSessionAsync("synthetic-session", caller.Token));
            Assert.That(handler.Methods, Is.EqualTo(new[] { HttpMethod.Get }));
        }

        [Test]
        public void NonvisualTurnOmitsFrameAndPreservesSourceIntentAndExactSpeech()
        {
            var request = new StartSessionRequest { Frame = null,
                Speech = new SpeechData { Text = "It felt colder than expected. 다음에 연습해요." },
                Attention = new AttentionInput { Source = "past-recollection", Scope = "scene", Evidence = "none" } };
            var json = Wire.Write(request);
            Assert.That(json, Does.Not.Contain("\"frame\""));
            var roundTrip = Wire.Read<StartSessionRequest>(json);
            Assert.That(roundTrip.Attention!.Source, Is.EqualTo("past-recollection"));
            Assert.That(roundTrip.Attention.Evidence, Is.EqualTo("none"));
            Assert.That(roundTrip.Speech.Text, Is.EqualTo(request.Speech.Text));
            Assert.That(roundTrip.Attention.OcrRequested, Is.False);
            Assert.That(roundTrip.Attention.SegmentationRequested, Is.False);
        }

        [Test]
        public void PhysicalFrameKeepsUntrustedTimestampAndUnknownSourceNeverBecomesLocation()
        {
            var request = new UtteranceRequest { Frame = new FrameData {
                Jpeg = "synthetic-jpeg", Width = 1280, Height = 960,
                CapturedAt = "1970-01-01T12:00:00-04:00", Source = "current-surroundings", TimestampTrusted = false },
                Attention = new AttentionInput { Source = "unknown", Scope = "scene", Evidence = "visual" },
                Speech = new SpeechData { Text = "Remember the Sahara." } };
            var roundTrip = Wire.Read<UtteranceRequest>(Wire.Write(request));
            Assert.That(roundTrip.Frame!.TimestampTrusted, Is.False);
            Assert.That(roundTrip.Frame.Source, Is.EqualTo("current-surroundings"));
            Assert.That(roundTrip.Frame.CapturedAt, Is.EqualTo(request.Frame.CapturedAt));
            Assert.That(roundTrip.Attention!.Source, Is.EqualTo("unknown"));
            Assert.That(roundTrip.Attention.MaxAgeMs, Is.EqualTo(15000));
        }

        [Test]
        public void ReturnedDialogueKeepsActualUtteranceAssociationAndServerTimestamp()
        {
            const string json = "{\"id\":\"synthetic-session\",\"state\":\"review\",\"attention\":{\"utteranceId\":\"synthetic-turn-2\",\"source\":\"past-recollection\",\"action\":\"clarify\",\"reason\":\"Choose the source.\",\"observationId\":null,\"work\":{\"ocr\":false,\"segmentation\":false}},\"dialogue\":{\"speaker\":\"boopy\",\"text\":\"Choose the source. 사하라 사진인가요?\",\"utteranceId\":\"synthetic-turn-2\",\"at\":\"1970-01-01T12:00:00-04:00\"}}";
            var view = Wire.Read<SessionView>(json);
            Assert.That(view.Dialogue!.UtteranceId, Is.EqualTo(view.Attention!.UtteranceId));
            Assert.That(view.Dialogue.Speaker, Is.EqualTo("boopy"));
            Assert.That(view.Dialogue.Text, Is.EqualTo("Choose the source. 사하라 사진인가요?"));
            Assert.That(view.Dialogue.At, Is.EqualTo("1970-01-01T12:00:00-04:00"));
            var replay = Wire.Read<SessionView>(Wire.Write(view));
            Assert.That(replay.Dialogue!.UtteranceId, Is.EqualTo("synthetic-turn-2"));
            Assert.That(replay.Attention!.ObservationId, Is.Null);
            Assert.That(replay.Attention.Work.Ocr, Is.False);
            Assert.That(Wire.Read<SessionView>("{\"id\":\"legacy-session\"}").Dialogue, Is.Null);
        }
    }
}
