#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class ServiceClientTasksTests
    {
        private const string Health = "{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}}";
        private const string Session = "ses_synthetic1";
        private const string TaskId = "tsk_00112233445566778899aabbccddeeff";
        private const string OpenEvent = "evt_0123456789abcdef0123456789abcdef";
        private const string AnswerEvent = "evt_fedcba9876543210fedcba9876543210";
        private static readonly byte[] SyntheticWav = { 0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 5, 6 };

        private const string Components = "[" +
            "{\"type\":\"subject\",\"sourceId\":\"src_obs1\",\"maskId\":null}," +
            "{\"type\":\"annotation\",\"text\":\"Stone marker\",\"evidenceIds\":[\"itm_stone\"]}," +
            "{\"type\":\"dialogue\",\"text\":\"It looks like a stone marker.\",\"evidenceIds\":[\"itm_stone\"]}," +
            "{\"type\":\"voice_reply\",\"prompt\":\"Answer aloud.\"}," +
            "{\"type\":\"status\",\"code\":\"not-sent\"}]";
        private const string OneAttempt = "[{\"eventId\":\"" + AnswerEvent + "\",\"text\":\"A stone marker by the trail.\"," +
            "\"recognitionUncertain\":true,\"kind\":\"practice-attempt\"}]";

        private static string View(int revision = 1, string taskId = TaskId, string session = Session, string attempts = "[]",
            string delivery = "not-sent") =>
            "{\"taskId\":\"" + taskId + "\",\"sessionId\":\"" + session + "\",\"revision\":" + revision +
            ",\"source\":{\"sourceId\":\"src_obs1\",\"sourceRevision\":1,\"sha256\":\"" + new string('b', 64) + "\"}" +
            ",\"intent\":\"consult_source\",\"utterance\":\"What is this?\",\"phase\":\"open\"" +
            ",\"continuity\":\"local-only\",\"delivery\":\"" + delivery + "\",\"subjectCorrected\":false" +
            ",\"components\":" + Components + ",\"attempts\":" + attempts + ",\"lastRejection\":null}";

        private sealed class Transport : HttpMessageHandler
        {
            public Func<HttpRequestMessage, HttpResponseMessage>? Answer;
            public bool Down, Hang;
            public int Drops;
            public Action? BeforeReply;
            public readonly List<(HttpMethod Method, string Path, string? Body)> Requests = new List<(HttpMethod, string, string?)>();
            public List<(HttpMethod Method, string Path, string? Body)> TaskRequests => Requests.Where(request => request.Path != "/v1/health").ToList();
            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel)
            {
                var path = request.RequestUri!.AbsolutePath;
                Requests.Add((request.Method, path, request.Content == null ? null : await request.Content.ReadAsStringAsync()));
                if (path == "/v1/health")
                    return Down ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) : Json(HttpStatusCode.OK, Health);
                BeforeReply?.Invoke();
                if (Hang) await Task.Delay(Timeout.Infinite, cancel);
                if (Drops > 0) { Drops--; throw new HttpRequestException("synthetic private detail"); }
                return Answer!(request);
            }
        }

        private static HttpResponseMessage Json(HttpStatusCode status, string body) =>
            new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        private static string Refusal(string code) => $"{{\"error\":{{\"code\":\"{code}\",\"message\":\"Synthetic refusal for {code}.\"}}}}";
        private static ServiceClient Client(Transport transport) => new ServiceClient(handler: transport,
            controlTimeout: TimeSpan.FromMilliseconds(200), requestTimeout: TimeSpan.FromMilliseconds(200));
        private static string[] Names(JToken body) => ((JObject)body).Properties().Select(property => property.Name).ToArray();

        [Test]
        public async Task OpeningPostsBothIdsToTheSessionsTaskAndReturnsTheExactViewText()
        {
            var transport = new Transport { Answer = _ => Json(HttpStatusCode.OK, View()) };
            using var client = Client(transport);
            var text = await client.OpenTaskAsync(Session, OpenEvent, TaskId);
            Assert.That(text, Is.EqualTo(View()), "The view comes back as the text the Mac sent, for the one parser.");
            Assert.That(transport.Requests.First().Path, Is.EqualTo("/v1/health"), "A change is preceded by a health check.");
            var post = transport.TaskRequests.Single();
            Assert.That(post.Method, Is.EqualTo(HttpMethod.Post));
            Assert.That(post.Path, Is.EqualTo("/v1/sessions/ses_synthetic1/task"));
            var body = JObject.Parse(post.Body!);
            Assert.That(Names(body), Is.EqualTo(new[] { "eventId", "taskId" }));
            Assert.That((string?)body["eventId"], Is.EqualTo(OpenEvent));
            Assert.That((string?)body["taskId"], Is.EqualTo(TaskId));
        }

        [Test]
        public async Task ARetriedOpenCarriesTheSameIds()
        {
            var transport = new Transport { Drops = 1, Answer = _ => Json(HttpStatusCode.OK, View()) };
            using var client = Client(transport);
            var lost = Assert.ThrowsAsync<ServiceException>(() => client.OpenTaskAsync(Session, OpenEvent, TaskId));
            Assert.That((lost!.Status, lost.Code), Is.EqualTo((503, "connection_lost")));
            Assert.That(lost.Message, Does.Not.Contain("synthetic private detail"));
            Assert.That(transport.TaskRequests.Count, Is.EqualTo(1), "The client never retries by itself.");
            Assert.That(await client.OpenTaskAsync(Session, OpenEvent, TaskId), Is.EqualTo(View()));
            var posts = transport.TaskRequests;
            Assert.That(posts.Count, Is.EqualTo(2));
            Assert.That(posts[1].Path, Is.EqualTo(posts[0].Path));
            Assert.That(posts[1].Body, Is.EqualTo(posts[0].Body), "A retry is the same event: the same event id and task id.");
        }

        [Test]
        public async Task ASessionWithoutATaskReadyTurnHasNoTaskAndNoError()
        {
            var transport = new Transport { Answer = _ => Json(HttpStatusCode.Conflict, Refusal("task_unavailable")) };
            using var client = Client(transport);
            Assert.That(await client.OpenTaskAsync(Session, OpenEvent, TaskId), Is.Null);
            Assert.That(transport.TaskRequests.Count, Is.EqualTo(1));
            using var unknown = Client(new Transport { Answer = _ => Json(HttpStatusCode.NotFound, Refusal("unknown_session")) });
            var failure = Assert.ThrowsAsync<ServiceException>(() => unknown.OpenTaskAsync(Session, OpenEvent, TaskId));
            Assert.That((failure!.Status, failure.Code), Is.EqualTo((404, "unknown_session")));
            using var other = Client(new Transport { Answer = _ => Json(HttpStatusCode.Conflict, Refusal("duplicate_conflict")) });
            Assert.That(Assert.ThrowsAsync<ServiceException>(() => other.OpenTaskAsync(Session, OpenEvent, TaskId))!.Code,
                Is.EqualTo("duplicate_conflict"), "Only task_unavailable means no task.");
        }

        [Test]
        public async Task TheSessionsExistingTaskIsAcceptedButAnotherSessionsIsNot()
        {
            var earlier = View(taskId: "tsk_earlier1");
            using var existing = Client(new Transport { Answer = _ => Json(HttpStatusCode.OK, earlier) });
            Assert.That(await existing.OpenTaskAsync(Session, OpenEvent, TaskId), Is.EqualTo(earlier),
                "One task per session: the Mac may return the task it already has.");
            using var foreign = Client(new Transport { Answer = _ => Json(HttpStatusCode.OK, View(session: "ses_other")) });
            Assert.That(Assert.ThrowsAsync<ServiceException>(() => foreign.OpenTaskAsync(Session, OpenEvent, TaskId))!.Code,
                Is.EqualTo("invalid_reply"));
        }

        [Test]
        public async Task AnAnswerSendsTheWavAsBase64AgainstTheCurrentRevision()
        {
            var reply = View(revision: 2, attempts: OneAttempt);
            var transport = new Transport { Answer = _ => Json(HttpStatusCode.OK, reply) };
            using var client = Client(transport);
            Assert.That(await client.AnswerTaskAsync(TaskId, Session, 1, AnswerEvent, SyntheticWav), Is.EqualTo(reply));
            Assert.That(transport.Requests.First().Path, Is.EqualTo("/v1/health"));
            var post = transport.TaskRequests.Single();
            Assert.That(post.Method, Is.EqualTo(HttpMethod.Post));
            Assert.That(post.Path, Is.EqualTo("/v1/tasks/" + TaskId + "/answers"));
            var body = JObject.Parse(post.Body!);
            Assert.That(Names(body), Is.EqualTo(new[] { "eventId", "sessionId", "expectedRevision", "speech" }));
            Assert.That((string?)body["eventId"], Is.EqualTo(AnswerEvent));
            Assert.That((string?)body["sessionId"], Is.EqualTo(Session));
            Assert.That(body["expectedRevision"]!.Type, Is.EqualTo(JTokenType.Integer));
            Assert.That((int)body["expectedRevision"]!, Is.EqualTo(1));
            Assert.That(Names(body["speech"]!), Is.EqualTo(new[] { "wav" }), "Only audio: the headset sends no text and no frame.");
            Assert.That((string?)body["speech"]!["wav"], Is.EqualTo(Convert.ToBase64String(SyntheticWav)));
        }

        [Test]
        public async Task ARetriedAnswerIsTheSameEventAndANewAnswerIsANewEvent()
        {
            var transport = new Transport { Drops = 1, Answer = _ => Json(HttpStatusCode.OK, View(revision: 2, attempts: OneAttempt)) };
            using var client = Client(transport);
            Assert.That(Assert.ThrowsAsync<ServiceException>(() => client.AnswerTaskAsync(TaskId, Session, 1, AnswerEvent, SyntheticWav))!.Code,
                Is.EqualTo("connection_lost"));
            await client.AnswerTaskAsync(TaskId, Session, 1, AnswerEvent, SyntheticWav);
            var posts = transport.TaskRequests;
            Assert.That(posts.Count, Is.EqualTo(2), "One send per call; the retry was the caller's.");
            Assert.That(posts[1].Body, Is.EqualTo(posts[0].Body), "The retry reuses the event id, revision and audio.");
            var first = TaskIds.NewEventId();
            var second = TaskIds.NewEventId();
            Assert.That(first, Is.Not.EqualTo(second), "Each new answer gets its own event id.");
            foreach (var id in new[] { first, second }) Assert.That(Regex.IsMatch(id, "^evt_[0-9a-f]{32}$"), Is.True, id);
            Assert.That(Regex.IsMatch(TaskIds.NewTaskId(), "^tsk_[0-9a-f]{32}$"), Is.True);
            Assert.That(TaskIds.NewTaskId(), Is.Not.EqualTo(TaskIds.NewTaskId()));
        }

        [TestCase(409, "stale_revision")]
        [TestCase(409, "cancelled")]
        [TestCase(409, "session_mismatch")]
        [TestCase(409, "duplicate_conflict")]
        [TestCase(422, "no_words")]
        [TestCase(422, "answer_unusable")]
        [TestCase(503, "recognizer_unavailable")]
        [TestCase(502, "speech_failed")]
        [TestCase(404, "unknown_task")]
        [TestCase(400, "invalid_request")]
        public void RefusalsKeepTheirStatusCodeAndMessage(int status, string code)
        {
            var transport = new Transport { Answer = _ => Json((HttpStatusCode)status, Refusal(code)) };
            using var client = Client(transport);
            var answer = Assert.ThrowsAsync<ServiceException>(() => client.AnswerTaskAsync(TaskId, Session, 1, AnswerEvent, SyntheticWav));
            Assert.That((answer!.Status, answer.Code, answer.Message), Is.EqualTo((status, code, "Synthetic refusal for " + code + ".")));
            var action = Assert.ThrowsAsync<ServiceException>(() => client.ActOnTaskAsync(TaskId, Session, 1, AnswerEvent, "retry"));
            Assert.That((action!.Status, action.Code), Is.EqualTo((status, code)));
            Assert.That(transport.TaskRequests.Count, Is.EqualTo(2), "A refusal is neither replayed nor reconciled by the client.");
        }

        [TestCase("<html>busy</html>")]
        [TestCase("")]
        [TestCase("{\"message\":\"Route POST:/v1/tasks not found\",\"statusCode\":404}")]
        public void UnreadableRefusalsKeepTheirStatus(string body)
        {
            using var client = Client(new Transport { Answer = _ => Json(HttpStatusCode.NotFound, body) });
            var failure = Assert.ThrowsAsync<ServiceException>(() => client.AnswerTaskAsync(TaskId, Session, 1, AnswerEvent, SyntheticWav));
            Assert.That((failure!.Status, failure.Code), Is.EqualTo((404, "http_error")));
        }

        [Test]
        public async Task ActionsSendOnlyTheirTypeAgainstARevision()
        {
            var transport = new Transport { Answer = _ => Json(HttpStatusCode.OK, View(revision: 4)) };
            using var client = Client(transport);
            foreach (var type in new[] { "wrong_subject", "save_for_later", "retry", "cancel" })
                await client.ActOnTaskAsync(TaskId, Session, 3, AnswerEvent, type);
            var posts = transport.TaskRequests;
            Assert.That(posts.Select(post => post.Path).Distinct(), Is.EqualTo(new[] { "/v1/tasks/" + TaskId + "/actions" }));
            var body = JObject.Parse(posts[0].Body!);
            Assert.That(Names(body), Is.EqualTo(new[] { "eventId", "sessionId", "expectedRevision", "action" }));
            Assert.That(JToken.DeepEquals(body, JObject.Parse("{\"eventId\":\"" + AnswerEvent + "\",\"sessionId\":\"" + Session +
                "\",\"expectedRevision\":3,\"action\":{\"type\":\"wrong_subject\"}}")), Is.True);
            Assert.That(posts.Select(post => (string?)JObject.Parse(post.Body!)["action"]!["type"]),
                Is.EqualTo(new[] { "wrong_subject", "save_for_later", "retry", "cancel" }));
            var before = transport.Requests.Count;
            foreach (var type in new[] { "voice_reply", "confirm", "" })
                Assert.Throws<ArgumentException>(() => client.ActOnTaskAsync(TaskId, Session, 3, AnswerEvent, type), type);
            Assert.That(transport.Requests.Count, Is.EqualTo(before), "An answer goes through /answers; nothing else is sent.");
        }

        [Test]
        public async Task ReadingNeedsNoHealthCheckAndMayFindNoTask()
        {
            var transport = new Transport { Answer = _ => Json(HttpStatusCode.OK, View(revision: 2, attempts: OneAttempt)) };
            using var client = Client(transport);
            Assert.That(await client.ReadTaskAsync(TaskId), Is.EqualTo(View(revision: 2, attempts: OneAttempt)));
            var read = transport.Requests.Single();
            Assert.That((read.Method, read.Path), Is.EqualTo((HttpMethod.Get, "/v1/tasks/" + TaskId)));
            using var empty = Client(new Transport { Answer = _ => Json(HttpStatusCode.OK, "null") });
            Assert.That(await empty.ReadTaskAsync(TaskId), Is.Null, "The JSON literal null means no such task.");
        }

        [Test]
        public void RepliesThatAreNotThisTasksViewAreInvalid()
        {
            foreach (var body in new[] { "<html>ok</html>", "[]", "null", View(delivery: "sent"), View(session: "ses_other") })
            {
                using var client = Client(new Transport { Answer = _ => Json(HttpStatusCode.OK, body) });
                Assert.That(Assert.ThrowsAsync<ServiceException>(() => client.OpenTaskAsync(Session, OpenEvent, TaskId))!.Code,
                    Is.EqualTo("invalid_reply"), body);
            }
            foreach (var body in new[] { View(revision: 2, taskId: "tsk_other", attempts: OneAttempt), View(revision: 2, session: "ses_other", attempts: OneAttempt),
                View(revision: 1, attempts: OneAttempt), View(revision: 2), "null" })
            {
                using var client = Client(new Transport { Answer = _ => Json(HttpStatusCode.OK, body) });
                Assert.That(Assert.ThrowsAsync<ServiceException>(() => client.AnswerTaskAsync(TaskId, Session, 1, AnswerEvent, SyntheticWav))!.Code,
                    Is.EqualTo("invalid_reply"), body);
            }
            using (var client = Client(new Transport { Answer = _ => Json(HttpStatusCode.OK, View(revision: 1)) }))
                Assert.That(Assert.ThrowsAsync<ServiceException>(() => client.ActOnTaskAsync(TaskId, Session, 1, AnswerEvent, "retry"))!.Code,
                    Is.EqualTo("invalid_reply"), "A change cannot leave the revision where it was.");
            using (var client = Client(new Transport { Answer = _ => Json(HttpStatusCode.OK, View(taskId: "tsk_other")) }))
                Assert.That(Assert.ThrowsAsync<ServiceException>(() => client.ReadTaskAsync(TaskId))!.Code, Is.EqualTo("invalid_reply"));
            using (var client = Client(new Transport { Answer = _ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(new byte[] { 0x7b, 0xff, 0xfe, 0x7d }) } }))
                Assert.That(Assert.ThrowsAsync<ServiceException>(() => client.ReadTaskAsync(TaskId))!.Code, Is.EqualTo("invalid_reply"));
        }

        [Test]
        public void AnUnreachableMacRefusesChangesBeforeSendingThem()
        {
            var transport = new Transport { Down = true, Answer = _ => Json(HttpStatusCode.OK, View(revision: 2, attempts: OneAttempt)) };
            using var client = Client(transport);
            foreach (var change in new Func<Task>[] {
                () => client.OpenTaskAsync(Session, OpenEvent, TaskId),
                () => client.AnswerTaskAsync(TaskId, Session, 1, AnswerEvent, SyntheticWav),
                () => client.ActOnTaskAsync(TaskId, Session, 1, AnswerEvent, "cancel") })
            {
                var failure = Assert.ThrowsAsync<ServiceException>(() => change());
                Assert.That((failure!.Status, failure.Code), Is.EqualTo((503, "service_unavailable")));
            }
            Assert.That(transport.TaskRequests, Is.Empty);
        }

        [Test]
        public void ALateOrLostAnswerIsUncertainAndSentOnce()
        {
            var late = new Transport { Hang = true };
            using (var client = Client(late))
            {
                var failure = Assert.ThrowsAsync<ServiceException>(() => client.AnswerTaskAsync(TaskId, Session, 1, AnswerEvent, SyntheticWav));
                Assert.That((failure!.Status, failure.Code), Is.EqualTo((408, "request_timeout")));
                Assert.That(failure.Message, Does.Contain("may still be recorded"));
            }
            var lost = new Transport { Drops = 1 };
            using (var client = Client(lost))
            {
                var failure = Assert.ThrowsAsync<ServiceException>(() => client.AnswerTaskAsync(TaskId, Session, 1, AnswerEvent, SyntheticWav));
                Assert.That((failure!.Status, failure.Code), Is.EqualTo((503, "connection_lost")));
                Assert.That(failure.Message, Does.Contain("may still be recorded"));
                Assert.That(failure.Message, Does.Not.Contain("synthetic private detail"));
            }
            Assert.That(late.TaskRequests.Count, Is.EqualTo(1));
            Assert.That(lost.TaskRequests.Count, Is.EqualTo(1));
            using var reading = Client(new Transport { Hang = true });
            Assert.That(Assert.ThrowsAsync<ServiceException>(() => reading.ReadTaskAsync(TaskId))!.Code, Is.EqualTo("request_timeout"));
        }

        [Test]
        public void ExplicitCancellationRemainsCancellationEvenWhenTheReplyArrives()
        {
            using var cancel = new CancellationTokenSource();
            var transport = new Transport { BeforeReply = cancel.Cancel, Answer = _ => Json(HttpStatusCode.OK, View(revision: 2, attempts: OneAttempt)) };
            using var client = Client(transport);
            Assert.CatchAsync<OperationCanceledException>(() => client.AnswerTaskAsync(TaskId, Session, 1, AnswerEvent, SyntheticWav, cancel.Token));
            Assert.That(transport.TaskRequests.Count, Is.EqualTo(1));
        }

        [Test]
        public void ArgumentsFollowTheContractBeforeAnythingIsSent()
        {
            var transport = new Transport { Answer = _ => Json(HttpStatusCode.OK, View(revision: 2, attempts: OneAttempt)) };
            using var client = Client(transport);
            foreach (var eventId in new[] { "", "evt_", "event_1", "evt_a/b", "evt_" + new string('a', 65) })
            {
                Assert.Throws<ArgumentException>(() => client.OpenTaskAsync(Session, eventId, TaskId), eventId);
                Assert.Throws<ArgumentException>(() => client.AnswerTaskAsync(TaskId, Session, 1, eventId, SyntheticWav), eventId);
            }
            foreach (var taskId in new[] { "", "tsk_", "task_1", "tsk_a/../b" })
            {
                Assert.Throws<ArgumentException>(() => client.OpenTaskAsync(Session, OpenEvent, taskId), taskId);
                Assert.Throws<ArgumentException>(() => client.ReadTaskAsync(taskId), taskId);
            }
            foreach (var session in new[] { "", "ses one", "ses/1", new string('s', 129) })
                Assert.Throws<ArgumentException>(() => client.AnswerTaskAsync(TaskId, session, 1, AnswerEvent, SyntheticWav), session);
            Assert.Throws<ArgumentException>(() => client.AnswerTaskAsync(TaskId, Session, -1, AnswerEvent, SyntheticWav));
            Assert.Throws<ArgumentException>(() => client.AnswerTaskAsync(TaskId, Session, 1, AnswerEvent, Array.Empty<byte>()));
            Assert.Throws<ArgumentException>(() => client.AnswerTaskAsync(TaskId, Session, 1, AnswerEvent, new byte[2 * 1024 * 1024]));
            Assert.That(transport.Requests, Is.Empty);
        }
    }
}
