#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
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
    public class ActivityClientTests
    {
        private const string Health = "{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"},\"activities\":true}";

        internal static string Fixture(string name) =>
            File.ReadAllText(Path.Combine(TestContext.CurrentContext.TestDirectory, "Fixtures", name));
        internal static string Korean => Fixture("activity-korean-view.json");
        internal static string Morocco => Fixture("activity-morocco-view.json");
        internal static ActivityView View(string json) => Wire.Read<ActivityView>(json);

        private sealed class Transport : HttpMessageHandler
        {
            public Func<HttpRequestMessage, HttpResponseMessage>? Answer;
            public bool Down, Hang, Drop;
            public Action? BeforeReply;
            public readonly List<(HttpMethod Method, string Path, string? Body)> Requests = new List<(HttpMethod, string, string?)>();
            public IEnumerable<(HttpMethod Method, string Path, string? Body)> Activity => Requests.Where(request => request.Path != "/v1/health");
            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel)
            {
                var path = request.RequestUri!.AbsolutePath;
                Requests.Add((request.Method, path, request.Content == null ? null : await request.Content.ReadAsStringAsync()));
                if (path == "/v1/health")
                    return Down ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) : Json(HttpStatusCode.OK, Health);
                BeforeReply?.Invoke();
                if (Hang) await Task.Delay(Timeout.Infinite, cancel);
                if (Drop) throw new HttpRequestException("synthetic private detail");
                return Answer!(request);
            }
        }

        private static HttpResponseMessage Json(HttpStatusCode status, string body) =>
            new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        private static string Refusal(string code) => $"{{\"error\":{{\"code\":\"{code}\",\"message\":\"Synthetic refusal for {code}.\"}}}}";
        private static ServiceClient Client(Transport transport) => new ServiceClient(handler: transport, controlTimeout: TimeSpan.FromMilliseconds(200));
        private static string WithRevision(string json, int revision) { var body = JObject.Parse(json); body["revision"] = revision; return body.ToString(); }

        [Test]
        public async Task ReadsTheKoreanCanonicalViewWithItsExportedSubmissionAndClaimedReply()
        {
            var transport = new Transport { Answer = _ => Json(HttpStatusCode.OK, Korean) };
            using var client = Client(transport);
            var view = await client.ReadActivityAsync("act_k1");
            Assert.That(transport.Requests.Single().Path, Is.EqualTo("/v1/activities/act_k1"), "Reading needs no health preflight.");
            Assert.That(transport.Requests.Single().Method, Is.EqualTo(HttpMethod.Get));
            Assert.That(view.ValidFor("act_k1"), Is.True);
            Assert.That(view.Renderable, Is.True);
            Assert.That(view.Revision, Is.EqualTo(4));
            Assert.That(view.Instruction!.Text, Is.EqualTo("낙타를 텐트 왼쪽에 놓고 한국어로 말해 보세요."));
            Assert.That(view.Provenance!.Authorship, Is.EqualTo("claimed-by-file"));
            Assert.That(view.Provenance.ImportedAt, Is.EqualTo("1970-01-01T09:00:00.000Z"), "Timestamps stay the exact strings sent.");
            var arrange = view.Arrange!;
            Assert.That(arrange.Axis!.Kind, Is.EqualTo("viewer-left-right"));
            Assert.That(arrange.Tokens!.Select(token => token.Position), Is.EqualTo(new double?[] { 0.22, 0.71 }));
            Assert.That(arrange.Tokens![0].Source!.SourceId, Is.EqualTo("ctx_synthetic1:itm_2"));
            Assert.That(arrange.Tokens![1].Source, Is.Null, "A token without a source is illustrative.");
            Assert.That(arrange.Derived!.Relation, Is.EqualTo("left-of"));
            Assert.That(arrange.Derived.MatchesTarget, Is.True);
            Assert.That(arrange.Derived.Values, Is.Null);
            var sequence = view.Sequence!;
            Assert.That(sequence.Chosen, Is.EqualTo(new[] { "t2", "t4", "t3", "t1" }));
            Assert.That(sequence.Text, Is.EqualTo("낙타가 텐트 왼쪽에 있어요"));
            Assert.That(sequence.Tiles!.Count(tile => tile.Used), Is.EqualTo(4));
            Assert.That(view.Hints!.Total, Is.EqualTo(2));
            Assert.That(view.Hints.Revealed!.Single().Text, Is.EqualTo("Start with the camel, then say where it is."));
            var submission = view.LatestSubmission!;
            Assert.That(submission.Number, Is.EqualTo(1));
            Assert.That(submission.Export!.State, Is.EqualTo("exported-not-sent"));
            Assert.That(submission.Reply!.ClaimedAuthor, Is.EqualTo("Grok Bot"));
            Assert.That(submission.Reply.NextActivityId, Is.EqualTo("act_k2"));
            Assert.That(submission.Arrange!.Positions!["b"], Is.EqualTo(0.71));
            Assert.That(submission.HintsRevealed, Is.EqualTo(new[] { 0 }));
        }

        [Test]
        public async Task ReadsTheMoroccoCanonicalViewWithOnePlacedEstimateAndNoSubmission()
        {
            using var client = Client(new Transport { Answer = _ => Json(HttpStatusCode.OK, Morocco) });
            var view = await client.ReadActivityAsync("act_m1");
            Assert.That(view.Renderable, Is.True);
            Assert.That(view.Sequence, Is.Null);
            var arrange = view.Arrange!;
            Assert.That(arrange.Axis!.Kind, Is.EqualTo("number"));
            Assert.That(arrange.Axis.Steps, Is.EqualTo(40));
            Assert.That(arrange.Axis.Unit, Is.EqualTo("MAD"));
            Assert.That(arrange.Tokens!.Single().Value, Is.EqualTo(50));
            Assert.That(arrange.Derived!.Values!["a"], Is.EqualTo(50));
            Assert.That(arrange.Target, Is.Null);
            Assert.That(view.CanSubmit, Is.True);
            Assert.That(view.Submissions, Is.Empty);
            Assert.That(view.Hints!.Revealed, Is.Empty);
        }

        [Test]
        public async Task ListsSummariesWithoutChangingAnything()
        {
            var list = "{\"activities\":[{\"activityId\":\"act_k2\",\"title\":\"Tent and camel\",\"status\":\"active\",\"importedAt\":\"1970-01-01T09:20:00.000Z\","
                + "\"claimedAuthor\":\"Grok Bot\",\"submissions\":0,\"awaitingReply\":false,\"replyAvailable\":false,\"parentActivityId\":\"act_k1\"},"
                + "{\"activityId\":\"act_k1\",\"title\":\"Camel and tent\",\"status\":\"active\",\"importedAt\":\"1970-01-01T09:00:00.000Z\","
                + "\"claimedAuthor\":\"Grok Bot\",\"submissions\":1,\"awaitingReply\":false,\"replyAvailable\":true,\"parentActivityId\":null},"
                + "{\"activityId\":\"act_x1\",\"title\":null,\"status\":\"fallback-only\",\"importedAt\":\"1970-01-01T08:00:00.000Z\","
                + "\"claimedAuthor\":null,\"submissions\":0,\"awaitingReply\":false,\"replyAvailable\":false,\"parentActivityId\":null}]}";
            var transport = new Transport { Answer = _ => Json(HttpStatusCode.OK, list) };
            using var client = Client(transport);
            var activities = await client.ListActivitiesAsync();
            Assert.That(activities.Select(activity => activity.ActivityId), Is.EqualTo(new[] { "act_k2", "act_k1", "act_x1" }));
            Assert.That(activities[0].ParentActivityId, Is.EqualTo("act_k1"));
            Assert.That(activities[1].ReplyAvailable, Is.True);
            Assert.That(activities[2].Title, Is.Null);
            Assert.That(transport.Requests.Single().Method, Is.EqualTo(HttpMethod.Get));
            Assert.That(transport.Requests.Single().Path, Is.EqualTo("/v1/activities"));
        }

        [TestCase("{\"activities\":null}")]
        [TestCase("{\"activities\":[{\"activityId\":\"act_1\",\"status\":\"confirmed\",\"importedAt\":\"1970-01-01T08:00:00.000Z\",\"submissions\":0,\"awaitingReply\":false,\"replyAvailable\":false}]}")]
        [TestCase("{\"activities\":[{\"activityId\":\"activity\",\"status\":\"active\",\"importedAt\":\"1970-01-01T08:00:00.000Z\",\"submissions\":0,\"awaitingReply\":false,\"replyAvailable\":false}]}")]
        [TestCase("{\"activities\":[{\"activityId\":\"act_1\",\"status\":\"active\",\"importedAt\":\"1970-01-01T08:00:00.000Z\",\"awaitingReply\":false,\"replyAvailable\":false}]}")]
        [TestCase("[]")]
        public void MalformedListsAreInvalidReplies(string body)
        {
            using var client = Client(new Transport { Answer = _ => Json(HttpStatusCode.OK, body) });
            Assert.That(Assert.ThrowsAsync<ServiceException>(() => client.ListActivitiesAsync())!.Code, Is.EqualTo("invalid_reply"));
        }

        [Test]
        public void ListsAtMostTwentyDistinctActivities()
        {
            var one = "{\"activityId\":\"act_ID\",\"status\":\"active\",\"importedAt\":\"1970-01-01T08:00:00.000Z\",\"submissions\":0,\"awaitingReply\":false,\"replyAvailable\":false}";
            var many = "{\"activities\":[" + string.Join(",", Enumerable.Range(0, 21).Select(index => one.Replace("ID", index.ToString()))) + "]}";
            var twice = "{\"activities\":[" + one.Replace("ID", "1") + "," + one.Replace("ID", "1") + "]}";
            foreach (var body in new[] { many, twice })
            {
                using var client = Client(new Transport { Answer = _ => Json(HttpStatusCode.OK, body) });
                Assert.That(Assert.ThrowsAsync<ServiceException>(() => client.ListActivitiesAsync())!.Code, Is.EqualTo("invalid_reply"));
            }
        }

        [Test]
        public async Task ArrangementNamesEveryTokenWithExplicitNotPlacedAndTheRevisionItWasMadeAgainst()
        {
            var current = View(Korean);
            var transport = new Transport { Answer = _ => Json(HttpStatusCode.OK, WithRevision(Korean, 5)) };
            using var client = Client(transport);
            var returned = await client.ArrangeActivityAsync(current, new Dictionary<string, double?> { ["a"] = 0.3, ["b"] = null });
            Assert.That(returned.Revision, Is.EqualTo(5));
            Assert.That(transport.Requests.First().Path, Is.EqualTo("/v1/health"), "Changes are preceded by a health check.");
            var post = transport.Activity.Single();
            Assert.That(post.Method, Is.EqualTo(HttpMethod.Post));
            Assert.That(post.Path, Is.EqualTo("/v1/activities/act_k1/arrangement"));
            var body = JObject.Parse(post.Body!);
            Assert.That(body.Properties().Select(property => property.Name), Is.EqualTo(new[] { "revision", "positions" }));
            Assert.That((int)body["revision"]!, Is.EqualTo(4));
            var positions = (JObject)body["positions"]!;
            Assert.That(positions.Properties().Select(property => property.Name), Is.EqualTo(new[] { "a", "b" }));
            Assert.That((double)positions["a"]!, Is.EqualTo(0.3));
            Assert.That(positions["b"]!.Type, Is.EqualTo(JTokenType.Null), "Not placed is sent explicitly, never omitted.");
        }

        [Test]
        public async Task SequenceHintAndSubmissionCarryOnlyTheirRevisionAndChoice()
        {
            var current = View(Korean);
            var transport = new Transport { Answer = _ => Json(HttpStatusCode.OK, WithRevision(Korean, 5)) };
            using var client = Client(transport);
            await client.SequenceActivityAsync(current, new[] { "t2", "t4" });
            await client.RevealActivityHintAsync(current);
            await client.SubmitActivityAsync(current);
            var posts = transport.Activity.ToList();
            Assert.That(posts.Select(post => post.Path), Is.EqualTo(new[] {
                "/v1/activities/act_k1/sequence", "/v1/activities/act_k1/hints", "/v1/activities/act_k1/submissions" }));
            Assert.That(JToken.DeepEquals(JObject.Parse(posts[0].Body!), JObject.Parse("{\"revision\":4,\"chosen\":[\"t2\",\"t4\"]}")), Is.True);
            Assert.That(JToken.DeepEquals(JObject.Parse(posts[1].Body!), JObject.Parse("{\"revision\":4}")), Is.True);
            Assert.That(JToken.DeepEquals(JObject.Parse(posts[2].Body!), JObject.Parse("{\"revision\":4}")), Is.True);
            Assert.That(transport.Requests.Count(request => request.Path == "/v1/health"), Is.EqualTo(3));
        }

        [Test]
        public void StaleActivityIsRefusedWithItsCodeAndNeverRetriedOrReread()
        {
            var transport = new Transport { Answer = _ => Json(HttpStatusCode.Conflict, Refusal("stale_activity")) };
            using var client = Client(transport);
            var failure = Assert.ThrowsAsync<ServiceException>(() =>
                client.ArrangeActivityAsync(View(Korean), new Dictionary<string, double?> { ["a"] = 0.1, ["b"] = 0.9 }));
            Assert.That(failure!.Status, Is.EqualTo(409));
            Assert.That(failure.Code, Is.EqualTo("stale_activity"));
            Assert.That(failure.Message, Is.EqualTo("Synthetic refusal for stale_activity."));
            Assert.That(transport.Activity.Count(), Is.EqualTo(1), "A refused change is neither replayed nor silently reconciled.");
        }

        [TestCase(404, "activity_unknown")]
        [TestCase(409, "activity_unavailable")]
        [TestCase(409, "nothing_to_submit")]
        [TestCase(409, "no_more_hints")]
        [TestCase(400, "invalid_request")]
        public void RefusalsKeepTheirStatusAndCode(int status, string code)
        {
            var transport = new Transport { Answer = _ => Json((HttpStatusCode)status, Refusal(code)) };
            using var client = Client(transport);
            var read = Assert.ThrowsAsync<ServiceException>(() => client.ReadActivityAsync("act_k1"));
            Assert.That((read!.Status, read.Code), Is.EqualTo((status, code)));
            var change = Assert.ThrowsAsync<ServiceException>(() => client.SubmitActivityAsync(View(Korean)));
            Assert.That((change!.Status, change.Code), Is.EqualTo((status, code)));
            Assert.That(transport.Activity.Count(), Is.EqualTo(2));
        }

        [TestCase("<html>busy</html>")]
        [TestCase("{\"message\":\"Route GET:/v1/activities not found\",\"error\":\"Not Found\",\"statusCode\":404}")]
        [TestCase("")]
        public void UnreadableRefusalsKeepTheirStatus(string body)
        {
            using var client = Client(new Transport { Answer = _ => Json(HttpStatusCode.NotFound, body) });
            var failure = Assert.ThrowsAsync<ServiceException>(() => client.ListActivitiesAsync());
            Assert.That((failure!.Status, failure.Code), Is.EqualTo((404, "http_error")));
        }

        [Test]
        public void AnUnreachableMacRefusesChangesBeforeSendingThem()
        {
            var transport = new Transport { Down = true, Answer = _ => Json(HttpStatusCode.OK, Korean) };
            using var client = Client(transport);
            var failure = Assert.ThrowsAsync<ServiceException>(() => client.SubmitActivityAsync(View(Korean)));
            Assert.That((failure!.Status, failure.Code), Is.EqualTo((503, "service_unavailable")));
            Assert.That(transport.Activity, Is.Empty);
        }

        [Test]
        public void ALostOrLateChangeIsUncertainAndNeverReplayed()
        {
            var late = new Transport { Hang = true };
            using (var client = Client(late))
            {
                var failure = Assert.ThrowsAsync<ServiceException>(() => client.SubmitActivityAsync(View(Korean)));
                Assert.That((failure!.Status, failure.Code), Is.EqualTo((408, "request_timeout")));
                Assert.That(failure.Message, Does.Contain("may have been saved"));
            }
            var lost = new Transport { Drop = true };
            using (var client = Client(lost))
            {
                var failure = Assert.ThrowsAsync<ServiceException>(() => client.RevealActivityHintAsync(View(Korean)));
                Assert.That((failure!.Status, failure.Code), Is.EqualTo((503, "connection_lost")));
                Assert.That(failure.Message, Does.Not.Contain("synthetic private detail"));
            }
            Assert.That(late.Activity.Count(), Is.EqualTo(1));
            Assert.That(lost.Activity.Count(), Is.EqualTo(1));
            using var reading = Client(new Transport { Hang = true });
            Assert.That(Assert.ThrowsAsync<ServiceException>(() => reading.ReadActivityAsync("act_k1"))!.Code, Is.EqualTo("request_timeout"));
        }

        [Test]
        public void ExplicitCancellationRemainsCancellationEvenWhenTheReplyArrives()
        {
            using var cancel = new CancellationTokenSource();
            var transport = new Transport { BeforeReply = cancel.Cancel, Answer = _ => Json(HttpStatusCode.OK, WithRevision(Korean, 5)) };
            using var client = Client(transport);
            Assert.CatchAsync<OperationCanceledException>(() => client.SubmitActivityAsync(View(Korean), cancel.Token));
            Assert.That(transport.Activity.Count(), Is.EqualTo(1));
        }

        [Test]
        public async Task AReplyForAnotherActivityOrAnEarlierRevisionIsInvalid()
        {
            var other = JObject.Parse(Korean); other["activityId"] = "act_k9";
            foreach (var body in new[] { other.ToString(), Morocco })
            {
                using var client = Client(new Transport { Answer = _ => Json(HttpStatusCode.OK, body) });
                Assert.That(Assert.ThrowsAsync<ServiceException>(() => client.SubmitActivityAsync(View(Korean)))!.Code, Is.EqualTo("invalid_reply"));
                Assert.That(Assert.ThrowsAsync<ServiceException>(() => client.ReadActivityAsync("act_k1"))!.Code, Is.EqualTo("invalid_reply"));
            }
            using var earlier = Client(new Transport { Answer = _ => Json(HttpStatusCode.OK, Morocco) });
            Assert.That(Assert.ThrowsAsync<ServiceException>(() => earlier.SubmitActivityAsync(View(WithRevision(Morocco, 2))))!.Code, Is.EqualTo("invalid_reply"),
                "A change cannot return an earlier revision than the one it was made against.");
            Assert.That((await earlier.ReadActivityAsync("act_m1")).Revision, Is.EqualTo(1), "A plain read reports whatever the Mac has.");
        }

        [Test]
        public void MalformedBytesAndDuplicateNamesAreInvalidReplies()
        {
            var bodies = new List<HttpContent> {
                new StringContent("{\"activityId\":\"act_k1\",\"activityId\":\"act_k1\"}"),
                new StringContent(Korean + " {}"),
                new StringContent("[" + Korean + "]"),
                new StringContent(Korean.Replace("\"act_k1\"", "\"act_k1\"" + new string(' ', 1024 * 1024))),
                new ByteArrayContent(new byte[] { 0x7b, 0xff, 0xfe, 0x7d }),
            };
            foreach (var content in bodies)
            {
                using var client = Client(new Transport { Answer = _ => new HttpResponseMessage(HttpStatusCode.OK) { Content = content } });
                Assert.That(Assert.ThrowsAsync<ServiceException>(() => client.ReadActivityAsync("act_k1"))!.Code, Is.EqualTo("invalid_reply"));
            }
        }

        private static readonly Action<JObject>[] EnvelopeViolations = {
            view => view["provenance"]!["authorship"] = "verified",
            view => view["status"] = "confirmed",
            view => view.Remove("revision"),
            view => view["revision"] = -1,
            view => view.Remove("fallbackText"),
            view => view["fallbackText"] = new string('x', 801),
            view => view.Remove("provenance"),
            view => view["provenance"]!["packetSha256"] = "not-a-hash",
            view => view["provenance"]!["requestId"] = "ctx_wrong",
            view => view["hints"]!["total"] = 0,
            view => view["hints"]!["revealed"]![0]!["index"] = 1,
            view => view["submissions"]![0]!["number"] = 2,
            view => view["submissions"]![0]!["revision"] = 5,
            view => view["submissions"]![0]!["export"] = null,
            view => view["submissions"]![0]!["export"]!["state"] = "sent",
            view => view["submissions"]![0]!["reply"]!["replyId"] = "sub_k1",
            view => view["submissions"]![0]!["reply"]!["points"] = new JArray(),
            view => view["submissions"]![0]!["reply"]!["nextActivityId"] = "next",
            view => { view["status"] = "fallback-only"; },
        };

        [Test]
        public void EnvelopeViolationsAreRefusedBeforeAnythingIsShown([Range(0, 18)] int violation)
        {
            var body = JObject.Parse(Korean); EnvelopeViolations[violation](body);
            using var client = Client(new Transport { Answer = _ => Json(HttpStatusCode.OK, body.ToString()) });
            Assert.That(Assert.ThrowsAsync<ServiceException>(() => client.ReadActivityAsync("act_k1"))!.Code, Is.EqualTo("invalid_reply"));
        }

        internal const string FallbackOnly = "{\"activityId\":\"act_x1\",\"revision\":0,\"status\":\"fallback-only\",\"title\":null,\"purpose\":null,"
            + "\"instruction\":null,\"fallbackText\":\"Arrange the camel and the tent in your mind.\\nThen say it aloud.\","
            + "\"issues\":[\"activity.components.0.type: unsupported component\"],"
            + "\"provenance\":{\"requestId\":\"arq_x1\",\"packageId\":\"ctx_synthetic3\",\"packetSha256\":\"7777777777777777777777777777777777777777777777777777777777777777\","
            + "\"artifactSha256\":\"8888888888888888888888888888888888888888888888888888888888888888\",\"claimedAuthor\":null,\"authorship\":\"claimed-by-file\","
            + "\"importedAt\":\"1970-01-01T08:00:00.000Z\",\"parent\":null},"
            + "\"components\":[],\"hints\":{\"total\":0,\"revealed\":[]},\"canSubmit\":false,\"submissions\":[]}";

        [Test]
        public async Task AFallbackOnlyViewIsShownAsTextAndCannotBeChanged()
        {
            var transport = new Transport { Answer = _ => Json(HttpStatusCode.OK, FallbackOnly) };
            using var client = Client(transport);
            var view = await client.ReadActivityAsync("act_x1");
            Assert.That(view.ValidFor("act_x1"), Is.True);
            Assert.That(view.Renderable, Is.False);
            Assert.That(view.FallbackText, Does.Contain("\n"), "The fallback text may span lines.");
            Assert.Throws<ArgumentException>(() => client.SubmitActivityAsync(view));
            Assert.Throws<ArgumentException>(() => client.ArrangeActivityAsync(view, new Dictionary<string, double?>()));
            Assert.That(transport.Requests.Count, Is.EqualTo(1), "Nothing is sent for an activity that cannot be changed.");
        }

        private static readonly Action<JObject>[] Unrenderable = {
            view => view["components"]![0]!["type"] = "draw",
            view => view["components"]![0]!["axis"]!["kind"] = "front-back",
            view => ((JArray)view["components"]!).Add(view["components"]![1]!.DeepClone()),
            view => view["components"] = new JArray(),
            view => ((JArray)view["components"]![0]!["tokens"]!).Add(new JObject { ["key"] = "c", ["label"] = new JObject { ["text"] = "물", ["language"] = "ko" } }),
            view => view["components"]![0]!["tokens"]![0]!["key"] = "b",
            view => view["components"]![0]!["tokens"]![0]!["position"] = 1.5,
            view => view["components"]![0]!["tokens"]![0]!["label"]!["text"] = new string('가', 25),
            view => view["components"]![0]!["target"]!["relation"] = "above",
            view => view["components"]![0]!["target"]!["object"] = "a",
            view => view["components"]![0]!["derived"]!["relation"] = "correct",
            view => view["components"]![1]!["tiles"]![0]!["text"] = "있어 요",
            view => view["components"]![1]!["tiles"]![1]!["text"] = "있어요",
            view => view["components"]![1]!["tiles"]![0]!["key"] = "t9",
            view => view["components"]![1]!["tiles"]![0]!["key"] = "t2",
            view => view["components"]![1]!["chosen"] = new JArray("t2", "t2"),
            view =>
            {
                var tiles = (JArray)view["components"]![1]!["tiles"]!;
                while (tiles.Count > 2) tiles.RemoveAt(2);
                view["components"]![1]!["chosen"] = new JArray("t2");
            },
            view => view["components"]![1]!["joiner"] = "comma",
            view => view["instruction"]!["language"] = "Korean",
            view => view["title"] = null,
        };

        [Test]
        public void ContentThisHeadsetCannotDrawFallsBackToTextInsteadOfGuessing([Range(0, 18)] int change)
        {
            var body = JObject.Parse(Korean);
            Unrenderable[change](body);
            var view = View(body.ToString());
            Assert.That(view.ValidFor("act_k1"), Is.True, "The envelope is intact, so the fallback text can still be shown.");
            Assert.That(view.Renderable, Is.False);
        }

        [TestCase("{\"kind\":\"scale\",\"low\":\"Cheaper\",\"high\":\"Pricier\"}", 2, true)]
        [TestCase("{\"kind\":\"scale\",\"low\":\"Cheaper\"}", 2, false)]
        [TestCase("{\"kind\":\"scale\",\"low\":\"Cheaper\",\"high\":\"Pricier\"}", 1, false)]
        [TestCase("{\"kind\":\"number\",\"min\":0,\"max\":200,\"step\":5,\"unit\":\"MAD\"}", 4, true)]
        [TestCase("{\"kind\":\"number\",\"min\":0,\"max\":200,\"step\":7}", 1, false)]
        [TestCase("{\"kind\":\"number\",\"min\":0,\"max\":2000,\"step\":1}", 1, false)]
        [TestCase("{\"kind\":\"number\",\"min\":5,\"max\":5,\"step\":1}", 1, false)]
        [TestCase("{\"kind\":\"number\",\"min\":0,\"max\":1,\"step\":0.1}", 1, true)]
        [TestCase("{\"kind\":\"number\",\"min\":0,\"max\":200,\"step\":5,\"unit\":\"Moroccan dirham\"}", 1, false)]
        [TestCase("{\"kind\":\"viewer-left-right\"}", 3, false)]
        public void AxisAndTokenCountsFollowTheContract(string axis, int tokens, bool renderable)
        {
            var body = JObject.Parse(Morocco);
            var component = (JObject)body["components"]![0]!;
            component["axis"] = JObject.Parse(axis);
            component["tokens"] = new JArray(Enumerable.Range(0, tokens).Select(index => new JObject {
                ["key"] = ((char)('a' + index)).ToString(),
                ["label"] = new JObject { ["text"] = "Item " + index, ["language"] = "en", ["gloss"] = null },
                ["source"] = null, ["position"] = null, ["value"] = null,
            }));
            var kind = (string)component["axis"]!["kind"]!;
            component["derived"] = new JObject { ["relation"] = null, ["matchesTarget"] = null, ["order"] = new JArray(), ["ties"] = false,
                ["values"] = kind == "number" ? new JObject() : null };
            Assert.That(View(body.ToString()).Renderable, Is.EqualTo(renderable));
        }

        [Test]
        public void ArrangementArgumentsMustNameExactlyThisActivitysTokensWithinTheLane()
        {
            var transport = new Transport { Answer = _ => Json(HttpStatusCode.OK, Korean) };
            using var client = Client(transport);
            foreach (var positions in new[] {
                new Dictionary<string, double?> { ["a"] = 0.2 },
                new Dictionary<string, double?> { ["a"] = 0.2, ["b"] = 0.4, ["c"] = 0.5 },
                new Dictionary<string, double?> { ["a"] = 0.2, ["c"] = 0.4 },
                new Dictionary<string, double?> { ["a"] = -0.01, ["b"] = 0.4 },
                new Dictionary<string, double?> { ["a"] = 1.01, ["b"] = 0.4 },
                new Dictionary<string, double?> { ["a"] = double.NaN, ["b"] = 0.4 },
            })
                Assert.Throws<ArgumentException>(() => client.ArrangeActivityAsync(View(Korean), positions));
            Assert.Throws<ArgumentException>(() => client.ArrangeActivityAsync(View(Morocco), new Dictionary<string, double?> { ["a"] = 0.2, ["b"] = 0.3 }));
            Assert.That(transport.Requests, Is.Empty);
        }

        [Test]
        public void SequenceArgumentsMustBeDistinctTilesOfThisActivity()
        {
            var transport = new Transport { Answer = _ => Json(HttpStatusCode.OK, Korean) };
            using var client = Client(transport);
            Assert.Throws<ArgumentException>(() => client.SequenceActivityAsync(View(Korean), new[] { "t1", "t1" }));
            Assert.Throws<ArgumentException>(() => client.SequenceActivityAsync(View(Korean), new[] { "t6" }));
            Assert.Throws<ArgumentException>(() => client.SequenceActivityAsync(View(Morocco), new[] { "t1" }), "Morocco has no sequence.");
            Assert.That(transport.Requests, Is.Empty);
        }

        [TestCase(",\"activities\":true", true)]
        [TestCase(",\"activities\":false", false)]
        [TestCase("", false)]
        public async Task HealthOffersActivitiesOnlyWhenTheServiceSaysSo(string flag, bool expected)
        {
            var body = "{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}" + flag + "}";
            using var reading = new ServiceClient(handler: new HealthOnly(body));
            Assert.That((await reading.ReadHealthAsync())!.Activities, Is.EqualTo(expected), "An older service without the flag hides the activity entry.");
        }

        private sealed class HealthOnly : HttpMessageHandler
        {
            private readonly string body;
            public HealthOnly(string body) { this.body = body; }
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel) =>
                Task.FromResult(Json(HttpStatusCode.OK, body));
        }

        [Test]
        public void TheServicesNullShapesAreAccepted()
        {
            // Section 10a: absent optional strings are null; relation only for left/right, values only for number.
            var fallback = JObject.Parse(FallbackOnly);
            Assert.That(View(fallback.ToString()).ValidFor("act_x1"), Is.True);

            var korean = JObject.Parse(Korean);
            korean["components"]![0]!["tokens"]![0]!["label"]!["gloss"] = null;
            korean["components"]![0]!["target"] = null;
            korean["components"]![0]!["derived"]!["matchesTarget"] = null;
            korean["provenance"]!["claimedAuthor"] = null;
            korean["submissions"]![0]!["reply"]!["claimedAuthor"] = null;
            korean["submissions"]![0]!["reply"]!["summary"]!["gloss"] = null;
            var view = View(korean.ToString());
            Assert.That(view.ValidFor("act_k1") && view.Renderable, Is.True);
            Assert.That(view.Arrange!.Target, Is.Null);
            Assert.That(view.Provenance!.ClaimedAuthor, Is.Null);

            var unplaced = JObject.Parse(Morocco);
            var token = unplaced["components"]![0]!["tokens"]![0]!;
            token["position"] = null; token["value"] = null;
            unplaced["components"]![0]!["derived"] = JObject.Parse("{\"relation\":null,\"matchesTarget\":null,\"order\":[],\"ties\":false,\"values\":{\"a\":null}}");
            unplaced["components"]![0]!["axis"]!["unit"] = null;
            var number = View(unplaced.ToString());
            Assert.That(number.ValidFor("act_m1") && number.Renderable, Is.True);
            Assert.That(number.Arrange!.Derived!.Values!["a"], Is.Null);

            var scale = JObject.Parse(Morocco);
            var component = (JObject)scale["components"]![0]!;
            component["axis"] = JObject.Parse("{\"kind\":\"scale\",\"low\":\"Cheaper\",\"high\":\"Pricier\"}");
            component["tokens"] = JArray.Parse("[{\"key\":\"a\",\"label\":{\"text\":\"scarf\",\"language\":\"en\",\"gloss\":null},\"source\":null,\"position\":0.2,\"value\":null},"
                + "{\"key\":\"b\",\"label\":{\"text\":\"lamp\",\"language\":\"en\",\"gloss\":null},\"source\":null,\"position\":null,\"value\":null}]");
            component["derived"] = JObject.Parse("{\"relation\":null,\"matchesTarget\":null,\"order\":[\"a\"],\"ties\":false,\"values\":null}");
            Assert.That(View(scale.ToString()).Renderable, Is.True);
            component["derived"]!["relation"] = "left-of";
            Assert.That(View(scale.ToString()).Renderable, Is.False, "Only a left/right board has a relation.");
            component["derived"]!["relation"] = null;
            component["tokens"]![0]!["value"] = 40;
            Assert.That(View(scale.ToString()).Renderable, Is.False, "Only a number board has values.");
        }

        [Test]
        public void IdentifiersFollowTheContractPatterns()
        {
            using var client = Client(new Transport { Answer = _ => Json(HttpStatusCode.OK, Korean) });
            foreach (var id in new[] { "", "k1", "act_", "act_k1/../x", "arq_k1", "act_" + new string('a', 65) })
                Assert.ThrowsAsync<ArgumentException>(() => client.ReadActivityAsync(id));
        }
    }
}
