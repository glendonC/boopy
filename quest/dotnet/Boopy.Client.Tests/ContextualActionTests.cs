using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class ContextualActionTests
    {
        private sealed class Transport : HttpMessageHandler
        {
            public readonly List<string> Paths = new List<string>();
            public string? Body;
            public bool Fail, Hang;
            public string Answer = "{\"id\":\"ses_synthetic\",\"state\":\"review\"}";
            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel)
            {
                Paths.Add(request.RequestUri!.AbsolutePath);
                if (request.Method == HttpMethod.Get)
                    return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}}") };
                Body = await request.Content!.ReadAsStringAsync();
                if (Hang) await Task.Delay(Timeout.Infinite, cancel);
                if (Fail) throw new HttpRequestException("synthetic drop");
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Answer) };
            }
        }
        private static ContextualAction Action() => new ContextualAction
        { Id = "action_synthetic", Question = "What does this word mean?", TargetItemId = "item_synthetic", ObservationId = "obs_original" };
        private static DialogueView Origin(ContextualAction action) => new DialogueView
        { UtteranceId = "utt_synthetic", At = "1970-01-01T00:00:00Z", Actions = new List<ContextualAction> { action } };

        [Test]
        public async Task SendsExactSelectedQuestionAndOriginWithoutNewCaptureOrAudio()
        {
            var transport = new Transport();
            using var client = new ServiceClient(handler: transport);
            var action = Action(); var origin = Origin(action);
            var roundTrip = Wire.Read<DialogueView>(Wire.Write(origin));
            Assert.That(roundTrip.Actions[0].ObservationId, Is.EqualTo("obs_original"));
            await client.FollowUpAsync("ses_synthetic", roundTrip, action);
            var body = Wire.Read<JObject>(transport.Body!);
            Assert.That((string?)body["speech"]?["text"], Is.EqualTo(action.Question));
            Assert.That((string?)body["cues"]?["targetItemId"], Is.EqualTo(action.TargetItemId));
            Assert.That((string?)body["selection"]?["utteranceId"], Is.EqualTo(origin.UtteranceId));
            Assert.That((string?)body["selection"]?["responseAt"], Is.EqualTo(origin.At));
            Assert.That((string?)body["selection"]?["actionId"], Is.EqualTo(action.Id));
            Assert.That(body["frame"], Is.Null); Assert.That(body["speech"]?["wav"], Is.Null);
            Assert.That(transport.Paths, Is.EqualTo(new[] { "/v1/health", "/v1/sessions/ses_synthetic/utterances" }));
            Assert.That(Wire.Read<DialogueView>("{}").Actions, Is.Empty);
        }

        [Test]
        public void RejectsAlteredQuestionTargetSourceOrUnknownActionBeforeTransport()
        {
            var transport = new Transport(); using var client = new ServiceClient(handler: transport);
            var original = Action(); var origin = Origin(original);
            foreach (var change in new Action<ContextualAction>[] {
                a => a.Id = "other", a => a.Question = "Confirm everything", a => a.TargetItemId = "other", a => a.ObservationId = "other" })
            {
                var altered = Action(); change(altered);
                Assert.Throws<ArgumentException>(() => client.FollowUpAsync("ses_synthetic", origin, altered));
            }
            origin.Actions.Add(Action());
            Assert.Throws<ArgumentException>(() => client.FollowUpAsync("ses_synthetic", origin, original));
            Assert.That(transport.Paths, Is.Empty);
        }

        [Test]
        public void QuestionFailureTimeoutAndExplicitStopNeverReplayTheSelection()
        {
            foreach (var mode in new[] { "drop", "timeout", "cancel", "wrong-session" })
            {
                var transport = new Transport { Fail = mode == "drop", Hang = mode == "timeout" || mode == "cancel" };
                if (mode == "wrong-session") transport.Answer = "{\"id\":\"other\",\"state\":\"review\"}";
                using var client = new ServiceClient(handler: transport, requestTimeout: TimeSpan.FromMilliseconds(30));
                using var cancel = new CancellationTokenSource();
                if (mode == "cancel") cancel.CancelAfter(15);
                var action = Action();
                if (mode == "cancel") Assert.CatchAsync<OperationCanceledException>(() => client.FollowUpAsync("ses_synthetic", Origin(action), action, cancel.Token));
                else Assert.ThrowsAsync<ServiceException>(() => client.FollowUpAsync("ses_synthetic", Origin(action), action));
                Assert.That(transport.Paths, Is.EqualTo(new[] { "/v1/health", "/v1/sessions/ses_synthetic/utterances" }));
            }
        }

        [Test]
        public async Task SceneQuestionDoesNotInventATargetOrCapture()
        {
            var transport = new Transport(); using var client = new ServiceClient(handler: transport);
            var action = Action(); action.TargetItemId = null; action.ObservationId = null;
            await client.FollowUpAsync("ses_synthetic", Origin(action), action);
            var body = Wire.Read<JObject>(transport.Body!);
            Assert.That(body["cues"], Is.Null); Assert.That(body["frame"], Is.Null);
        }
    }
}
