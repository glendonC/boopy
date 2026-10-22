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
    public class SpeechOutputTests
    {
        private const string ResponseAt = "1970-01-01T12:00:00-04:00";
        private sealed class Transport : HttpMessageHandler
        {
            public readonly List<string> Paths = new List<string>();
            public readonly TaskCompletionSource<bool> SpeechEntered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            public string? Sent;
            public HttpStatusCode Status = HttpStatusCode.OK;
            public bool Hang, Drop, LateCancel, LateDeadline;
            public TimeSpan Delay;
            public CancellationTokenSource? Caller;
            public string Answer = "{\"sessionId\":\"synthetic/session\",\"utteranceId\":\"synthetic-turn\",\"responseAt\":\"1970-01-01T12:00:00-04:00\",\"speaker\":\"boopy\",\"mimeType\":\"audio/wav\",\"wav\":\"synthetic-wav\",\"language\":\"ko\",\"voice\":\"synthetic-voice\",\"latencyMs\":12}";
            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel)
            {
                Paths.Add(request.RequestUri!.AbsolutePath);
                if (request.Method == HttpMethod.Get) return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}}") };
                Sent = await request.Content!.ReadAsStringAsync();
                SpeechEntered.TrySetResult(true);
                if (Delay > TimeSpan.Zero) await Task.Delay(Delay, cancel);
                if (Hang) await Task.Delay(Timeout.Infinite, cancel);
                if (Drop) throw new HttpRequestException("synthetic sensitive provider details");
                if (LateCancel) Caller!.Cancel();
                if (LateDeadline) await Task.Delay(50);
                return new HttpResponseMessage(Status) { Content = new StringContent(Answer) };
            }
        }
        private static SpeechOutputRequest Request() => new SpeechOutputRequest { UtteranceId = "synthetic-turn", ResponseAt = ResponseAt };
        [Test]
        public async Task SpeechUsesExactJournaledResponseReferenceAndSingleEscapedPost()
        {
            var transport = new Transport();
            using var client = new ServiceClient(handler: transport);
            var result = await client.SpeechAsync("synthetic/session", Request());
            Assert.That(result.ResponseAt, Is.EqualTo(ResponseAt));
            Assert.That(result.Speaker, Is.EqualTo("boopy"));
            Assert.That(result.Language, Is.EqualTo("ko"));
            Assert.That(transport.Paths, Is.EqualTo(new[] { "/v1/health", "/v1/sessions/synthetic%2Fsession/speech" }));
            Assert.That(transport.Sent, Is.EqualTo(Wire.Write(Request())));
            Assert.That(transport.Sent, Does.Not.Contain("text"));
        }
        [Test]
        public async Task NeuralReloadBeyondOldEightSecondDeadlineStillReturnsExactReplyOnce()
        {
            var transport = new Transport { Delay = TimeSpan.FromMilliseconds(8250) };
            using var client = new ServiceClient(handler: transport);
            var result = await client.SpeechAsync("synthetic/session", Request());
            Assert.That(result.ResponseAt, Is.EqualTo(ResponseAt));
            Assert.That(transport.Paths.Count, Is.EqualTo(2));
        }
        [Test]
        public async Task CallerCanCancelWhileNeuralSpeechIsStillLoading()
        {
            using var cancel = new CancellationTokenSource();
            var transport = new Transport { Delay = TimeSpan.FromSeconds(20) };
            using var client = new ServiceClient(handler: transport);
            var pending = client.SpeechAsync("synthetic/session", Request(), cancel.Token);
            await transport.SpeechEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            cancel.Cancel();
            Assert.CatchAsync<OperationCanceledException>(() => pending);
            Assert.That(transport.Paths.Count, Is.EqualTo(2));
        }
        [Test]
        public void SpeechTimeoutAndDropHaveSanitizedSpecificFailureWithoutReplay()
        {
            foreach (var transport in new[] { new Transport { Hang = true }, new Transport { LateDeadline = true }, new Transport { Drop = true }, new Transport { Status = HttpStatusCode.BadGateway, Answer = "private synthetic provider details" }, new Transport { Answer = "private malformed response" } })
            {
                using var client = new ServiceClient(handler: transport, speechTimeout: TimeSpan.FromMilliseconds(15));
                var failure = Assert.ThrowsAsync<ServiceException>(() => client.SpeechAsync("synthetic/session", Request()));
                Assert.That(failure!.Code, Does.StartWith("speech_"));
                Assert.That(failure.Message, Does.Not.Contain("private").And.Not.Contain("processing").And.Not.Contain("saved").And.Not.Contain("provider details"));
                Assert.That(transport.Paths.Count, Is.EqualTo(2));
            }
        }
        [Test]
        public void ExplicitStopWinsOverSuccessfulLateSpeechResponse()
        {
            using var cancel = new CancellationTokenSource();
            var transport = new Transport { LateCancel = true, Caller = cancel };
            using var client = new ServiceClient(handler: transport);
            Assert.CatchAsync<OperationCanceledException>(() => client.SpeechAsync("synthetic/session", Request(), cancel.Token));
            Assert.That(transport.Paths.Count, Is.EqualTo(2));
        }
        [Test]
        public void MismatchedTurnTimeSpeakerOrFormatCannotBecomePlayback()
        {
            foreach (var change in new[] { ("synthetic-turn", "stale-turn"), (ResponseAt, "1970-01-01T00:00:00Z"), ("boopy", "muse"), ("audio/wav", "audio/mp3") })
            {
                var transport = new Transport(); transport.Answer = transport.Answer.Replace(change.Item1, change.Item2);
                using var client = new ServiceClient(handler: transport);
                var failure = Assert.ThrowsAsync<ServiceException>(() => client.SpeechAsync("synthetic/session", Request()));
                Assert.That(failure!.Code, Is.EqualTo("speech_invalid"));
            }
        }
        [Test]
        public void OversizedBase64CannotReachPlayback()
        {
            var transport = new Transport();
            transport.Answer = transport.Answer.Replace("synthetic-wav", new string('A', 2796205));
            using var client = new ServiceClient(handler: transport);
            var failure = Assert.ThrowsAsync<ServiceException>(() => client.SpeechAsync("synthetic/session", Request()));
            Assert.That(failure!.Code, Is.EqualTo("speech_invalid"));
            Assert.That(transport.Paths.Count, Is.EqualTo(2));
        }

        [Test]
        public void IncompleteReferencesFailBeforeAnyTransport()
        {
            var transport = new Transport();
            using var client = new ServiceClient(handler: transport);
            Assert.ThrowsAsync<ArgumentException>(() => client.SpeechAsync("synthetic/session", new SpeechOutputRequest()));
            Assert.That(transport.Paths, Is.Empty);
        }
    }
}
