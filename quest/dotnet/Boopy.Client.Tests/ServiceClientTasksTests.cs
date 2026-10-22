#nullable enable
using System;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class ServiceClientTasksTests
    {
        private const string Session = "ses_synthetic1";
        private const string TaskId = "tsk_00112233445566778899aabbccddeeff";
        private const string OpenEvent = "evt_0123456789abcdef0123456789abcdef";
        private const string ActEvent = "evt_fedcba9876543210fedcba9876543210";

        private static string View() =>
            "{\"taskId\":\"" + TaskId + "\",\"sessionId\":\"" + Session + "\",\"revision\":1," +
            "\"source\":{\"sourceId\":\"src_picture\",\"sourceRevision\":1,\"sha256\":\"" + new string('b', 64) + "\"}," +
            "\"intent\":\"consult_source\",\"utterance\":\"What is this?\",\"phase\":\"open\"," +
            "\"continuity\":\"local-only\",\"delivery\":\"not-sent\",\"subjectCorrected\":false," +
            "\"components\":[" +
            "{\"type\":\"annotation\",\"text\":\"Stone\",\"evidenceIds\":[\"itm_stone\"]}," +
            "{\"type\":\"dialogue\",\"text\":\"It looks like a stone.\",\"evidenceIds\":[\"itm_stone\"]}," +
            "{\"type\":\"voice_reply\",\"prompt\":\"Answer aloud.\"}," +
            "{\"type\":\"status\",\"code\":\"not-sent\"}]," +
            "\"attempts\":[],\"lastRejection\":null}";

        private sealed class Transport : HttpMessageHandler
        {
            public Func<HttpRequestMessage, HttpResponseMessage>? Answer;
            public readonly System.Collections.Generic.List<(HttpMethod Method, string Path, string? Body)> Requests =
                new System.Collections.Generic.List<(HttpMethod, string, string?)>();

            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel)
            {
                var path = request.RequestUri!.AbsolutePath;
                var body = request.Content == null ? null : await request.Content.ReadAsStringAsync();
                Requests.Add((request.Method, path, body));
                if (path == "/v1/health")
                    return Json(HttpStatusCode.OK, "{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}}");
                return Answer!(request);
            }
        }

        private static HttpResponseMessage Json(HttpStatusCode status, string body) =>
            new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

        private static ServiceClient Client(Transport transport) =>
            new ServiceClient(handler: transport, controlTimeout: TimeSpan.FromMilliseconds(200));

        [Test]
        public async Task OpeningReturnsTheUnsentView()
        {
            var transport = new Transport { Answer = _ => Json(HttpStatusCode.OK, View()) };
            using var client = Client(transport);
            var text = await client.OpenTaskAsync(Session, OpenEvent, TaskId);
            Assert.That(text, Is.EqualTo(View()));
            var post = transport.Requests.Single(request => request.Method == HttpMethod.Post);
            Assert.That(post.Path, Is.EqualTo("/v1/sessions/" + Session + "/task"));
            var body = JObject.Parse(post.Body!);
            Assert.That(body["eventId"]!.Value<string>(), Is.EqualTo(OpenEvent));
            Assert.That(body["taskId"]!.Value<string>(), Is.EqualTo(TaskId));
            Assert.That(InteractionPresentation.Read(text!).Delivery, Is.EqualTo("not-sent"));
        }

        [Test]
        public void ASentViewIsNotAccepted()
        {
            var sent = View().Replace("\"delivery\":\"not-sent\"", "\"delivery\":\"sent\"");
            var transport = new Transport { Answer = _ => Json(HttpStatusCode.OK, sent) };
            using var client = Client(transport);
            var error = Assert.ThrowsAsync<ServiceException>(async () => await client.OpenTaskAsync(Session, OpenEvent, TaskId));
            Assert.That(error!.Code, Is.EqualTo("invalid_reply"));
        }

        [Test]
        public async Task AnActionIsPostedAndTheReplyStaysNotSent()
        {
            var transport = new Transport { Answer = _ => Json(HttpStatusCode.OK, View()) };
            using var client = Client(transport);
            var text = await client.ActOnTaskAsync(TaskId, Session, 0, ActEvent, "wrong_subject");
            Assert.That(InteractionPresentation.Read(text).Delivery, Is.EqualTo("not-sent"));
            var post = transport.Requests.Single(request => request.Method == HttpMethod.Post);
            Assert.That(post.Path, Is.EqualTo("/v1/tasks/" + TaskId + "/actions"));
            var body = JObject.Parse(post.Body!);
            Assert.That(body["action"]!["type"]!.Value<string>(), Is.EqualTo("wrong_subject"));
            Assert.That(body["expectedRevision"]!.Value<int>(), Is.EqualTo(0));
        }
    }
}
