#nullable enable
using System.IO;
using System.Linq;
using Boopy.Client;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    /// <summary>
    /// A cross-lane contract check: the views the service generated with its own importer and store
    /// (service/fixtures/activity) parse as valid, drawable views on the headset, keep the service's
    /// tile order, and agree with the headset's own preview derivation.
    /// </summary>
    public class ActivityServiceFixtureTests
    {
        private static string ServiceFixture(string name)
        {
            for (var directory = new DirectoryInfo(TestContext.CurrentContext.TestDirectory); directory != null; directory = directory.Parent)
            {
                var path = Path.Combine(directory.FullName, "service", "fixtures", "activity", name);
                if (File.Exists(path)) return File.ReadAllText(path);
            }
            throw new FileNotFoundException("The service's generated activity fixtures are not in this checkout.", name);
        }

        [TestCase("korean-view.json", "act_k1")]
        [TestCase("morocco-view.json", "act_m1")]
        public void ServiceGeneratedViewsAreValidAndDrawable(string name, string id)
        {
            var view = Wire.Read<ActivityView>(ServiceFixture(name));
            Assert.That(view.ValidFor(id), Is.True, "The service's own view fails the headset's envelope check.");
            Assert.That(view.Renderable, Is.True, "The service's own view is not drawable on the headset.");
        }

        [Test]
        public void TilesKeepTheServicesOrder()
        {
            var json = ServiceFixture("korean-view.json");
            var written = JObject.Parse(json)["components"]!.First(component => (string?)component["type"] == "sequence")["tiles"]!.Select(tile => (string)tile["key"]!);
            var view = Wire.Read<ActivityView>(json);
            Assert.That(view.Sequence!.Tiles!.Select(tile => tile.Key), Is.EqualTo(written), "The headset re-sorted the tiles the service ordered.");
            Assert.That(written, Is.Not.Ordered, "The fixture's tiles are in key order, so this check would prove nothing.");
        }

        [TestCase("korean-view.json")]
        [TestCase("morocco-view.json")]
        public void HeadsetDerivationAgreesWithTheServicesRecordedReading(string name)
        {
            var arrange = Wire.Read<ActivityView>(ServiceFixture(name)).Arrange!;
            var derived = ActivityDerivation.Derive(arrange, arrange.Tokens!.ToDictionary(token => token.Key, token => token.Position));
            Assert.That(derived.Relation, Is.EqualTo(arrange.Derived!.Relation));
            Assert.That(derived.MatchesTarget, Is.EqualTo(arrange.Derived.MatchesTarget));
            Assert.That(derived.Order, Is.EqualTo(arrange.Derived.Order));
            Assert.That(derived.Ties, Is.EqualTo(arrange.Derived.Ties));
            Assert.That(derived.Values, Is.EqualTo(arrange.Derived.Values));
            foreach (var token in arrange.Tokens!.Where(token => token.Position.HasValue && arrange.Axis!.Kind == "number"))
                Assert.That(ActivityDerivation.Value(arrange.Axis!, token.Position!.Value), Is.EqualTo(token.Value), "Micro-unit snapping disagrees with the service's recorded value.");
        }

        [Test]
        public void CalledViewAndReplyKeepTheRealStoresCallProvenanceWithoutAFileExport()
        {
            var json = ServiceFixture("called-with-reply.json");
            var view = Wire.Read<ActivityView>(json);
            Assert.That(view.ValidFor("act_k1") && view.Renderable, Is.True);
            Assert.That(view.Provenance!.ClaimedAuthor, Is.Null);
            Assert.That(view.LatestSubmission!.Export, Is.Null);
            Assert.That(view.LatestSubmission.Reply!.ClaimedAuthor, Is.Null);
            var roundTrip = JObject.Parse(Wire.Write(view));
            Assert.That((string?)roundTrip["provenance"]!["call"]?["callId"], Is.EqualTo("cal_k1"));
            Assert.That((double?)roundTrip["provenance"]!["call"]?["durationMs"], Is.EqualTo(1500));
            Assert.That((string?)roundTrip["submissions"]![0]!["replyCall"]?["state"], Is.EqualTo("imported"));
            Assert.That((string?)roundTrip["submissions"]![0]!["reply"]!["call"]?["callId"], Is.EqualTo("cal_k2"));
        }

        [TestCase("running")]
        [TestCase("failed")]
        [TestCase("interrupted")]
        [TestCase("off")]
        public void ARecordedCalledSubmissionSurvivesPendingFailedInterruptedOrDisabledCalls(string state)
        {
            var view = JObject.Parse(ServiceFixture("called-with-reply.json"));
            var submission = view["submissions"]![0]!; submission["reply"] = null;
            submission["replyCall"] = state == "off" ? null : new JObject {
                ["callId"] = "cal_k2", ["state"] = state,
                ["failure"] = state == "running" ? null : new JObject {
                    ["code"] = state == "interrupted" ? "interrupted" : "assistant_timeout",
                    ["message"] = state == "interrupted"
                        ? "Boopy couldn't make a reply from this: Boopy stopped before the local model answered."
                        : "Boopy couldn't make a reply from this: the local model didn't answer in time." }
            };
            Assert.That(Valid(view), Is.True, "The saved attempt must not depend on a successful call.");
        }

        [Test]
        public void ACalledActivityCanStillReceiveAnExplicitlyExportedFileReplyAfterItsCallFails()
        {
            var view = JObject.Parse(ServiceFixture("called-with-reply.json"));
            var submission = view["submissions"]![0]!;
            submission["export"] = JObject.Parse(ServiceFixture("korean-view.json"))["submissions"]![0]!["export"]!.DeepClone();
            ((JObject)submission["reply"]!).Remove("call"); submission["reply"]!["claimedAuthor"] = "Grok Bot";
            submission["replyCall"] = new JObject { ["callId"] = "cal_k2", ["state"] = "failed", ["failure"] = new JObject {
                ["code"] = "assistant_timeout", ["message"] = "Boopy couldn't make a reply from this: the local model didn't answer in time." } };
            Assert.That(Valid(view), Is.True, "Authorship is per artifact, not inherited from its activity.");
        }

        [TestCase("missing-call")]
        [TestCase("null-call")]
        [TestCase("claimed-author")]
        [TestCase("file-with-call")]
        [TestCase("provider")]
        [TestCase("call-id")]
        [TestCase("model")]
        [TestCase("duration-missing")]
        [TestCase("duration-negative")]
        [TestCase("duration-fraction")]
        [TestCase("reply-author")]
        [TestCase("reply-call-id")]
        [TestCase("reply-call-missing")]
        [TestCase("reply-state")]
        [TestCase("imported-no-reply")]
        [TestCase("failed-no-failure")]
        public void CalledProvenanceCannotBeClaimedGuessedOrDetachedFromItsReplyCall(string change)
        {
            var view = JObject.Parse(ServiceFixture("called-with-reply.json"));
            var provenance = (JObject)view["provenance"]!; var call = (JObject)provenance["call"]!;
            var submission = view["submissions"]![0]!; var reply = submission["reply"]!;
            switch (change)
            {
                case "missing-call": provenance.Remove("call"); break;
                case "null-call": provenance["call"] = null; break;
                case "claimed-author": provenance["claimedAuthor"] = "Grok Bot"; break;
                case "file-with-call": provenance["authorship"] = "claimed-by-file"; break;
                case "provider": call["provider"] = "remote"; break;
                case "call-id": call["callId"] = "act_k1"; break;
                case "model": call["model"] = "Grok"; break;
                case "duration-missing": call.Remove("durationMs"); break;
                case "duration-negative": call["durationMs"] = -1; break;
                case "duration-fraction": call["durationMs"] = 1.5; break;
                case "reply-author": reply["claimedAuthor"] = "Grok Bot"; break;
                case "reply-call-id": reply["call"]!["callId"] = "cal_other"; break;
                case "reply-call-missing": ((JObject)submission).Remove("replyCall"); break;
                case "reply-state": submission["replyCall"]!["state"] = "confirmed"; break;
                case "imported-no-reply": submission["reply"] = null; break;
                case "failed-no-failure": submission["reply"] = null; submission["replyCall"]!["state"] = "failed"; break;
            }
            Assert.That(Valid(view), Is.False, change);
        }

        [TestCase("provenance-call")]
        [TestCase("provenance-null-call")]
        [TestCase("reply-call")]
        [TestCase("reply-null-call")]
        [TestCase("submission-call")]
        [TestCase("submission-null-call")]
        public void FileViewsDoNotAcquireCalledProvenanceEvenWhenTheNewKeyIsNull(string change)
        {
            var view = JObject.Parse(ServiceFixture("korean-view.json"));
            var called = JObject.Parse(ServiceFixture("called-with-reply.json"));
            var submission = view["submissions"]![0]!;
            switch (change)
            {
                case "provenance-call": view["provenance"]!["call"] = called["provenance"]!["call"]!.DeepClone(); break;
                case "provenance-null-call": view["provenance"]!["call"] = null; break;
                case "reply-call": submission["reply"]!["call"] = called["submissions"]![0]!["reply"]!["call"]!.DeepClone(); break;
                case "reply-null-call": submission["reply"]!["call"] = null; break;
                case "submission-call": submission["replyCall"] = called["submissions"]![0]!["replyCall"]!.DeepClone(); break;
                case "submission-null-call": submission["replyCall"] = null; break;
            }
            Assert.That(Valid(view), Is.False, change);
        }

        [Test]
        public void FileViewRoundTripKeepsEveryCallKeyAbsentAndRemainsValid()
        {
            var view = Wire.Read<ActivityView>(ServiceFixture("korean-view.json"));
            var written = JObject.Parse(Wire.Write(view));
            Assert.That(((JObject)written["provenance"]!).ContainsKey("call"), Is.False);
            foreach (var submission in written["submissions"]!.Cast<JObject>())
            {
                Assert.That(submission.ContainsKey("replyCall"), Is.False);
                if (submission["reply"] is JObject reply) Assert.That(reply.ContainsKey("call"), Is.False);
            }
            Assert.That(Valid(written), Is.True);
        }

        [Test]
        public void ACalledSubmissionWithCallsOffKeepsItsExplicitNullReplyCallOnRoundTrip()
        {
            var json = JObject.Parse(ServiceFixture("called-with-reply.json"));
            json["submissions"]![0]!["reply"] = null;
            json["submissions"]![0]!["replyCall"] = null;
            var written = JObject.Parse(Wire.Write(Wire.Read<ActivityView>(json.ToString())));
            Assert.That(((JObject)written["submissions"]![0]!).ContainsKey("replyCall"), Is.True);
            Assert.That(written["submissions"]![0]!["replyCall"]!.Type, Is.EqualTo(JTokenType.Null));
            Assert.That(Valid(written), Is.True);
        }

        [TestCase(false)]
        [TestCase(true)]
        public void SummaryRoundTripRetainsCallPresenceWithoutInventingIt(bool called)
        {
            var json = Summary(called);
            var summary = Wire.Read<ActivitySummary>(json.ToString());
            Assert.That(summary.Valid, Is.True);
            var written = JObject.Parse(Wire.Write(summary));
            Assert.That(written.ContainsKey("call"), Is.EqualTo(called));
            if (called)
            {
                Assert.That(summary.ClaimedAuthor, Is.Null);
                Assert.That((string?)written["call"]!["provider"], Is.EqualTo("ollama"));
                Assert.That((string?)written["call"]!["model"], Is.EqualTo("qwen3.6:35b-a3b-nvfp4"));
            }
            Assert.That(Wire.Read<ActivitySummary>(written.ToString()).Valid, Is.True);
        }

        [TestCase("null-call")]
        [TestCase("claimed-author")]
        [TestCase("provider")]
        [TestCase("model")]
        [TestCase("empty-model")]
        [TestCase("fallback")]
        public void SummaryCallMetadataMustBeLocalAndCannotClaimAnAuthor(string change)
        {
            var json = Summary(true);
            switch (change)
            {
                case "null-call": json["call"] = null; break;
                case "claimed-author": json["claimedAuthor"] = "Grok Bot"; break;
                case "provider": json["call"]!["provider"] = "remote"; break;
                case "model": json["call"]!["model"] = "Grok"; break;
                case "empty-model": json["call"]!["model"] = ""; break;
                case "fallback": json["status"] = "fallback-only"; break;
            }
            Assert.That(Wire.Read<ActivitySummary>(json.ToString()).Valid, Is.False);
        }

        [Test]
        public void FileSummaryWithAnExplicitNullCallIsRejectedRatherThanSilentlyRepaired()
        {
            var json = Summary(false); json["call"] = null;
            var summary = Wire.Read<ActivitySummary>(json.ToString());
            Assert.That(summary.Valid, Is.False);
            var written = JObject.Parse(Wire.Write(summary));
            Assert.That(written.ContainsKey("call"), Is.True);
            Assert.That(Wire.Read<ActivitySummary>(written.ToString()).Valid, Is.False);
        }

        private static JObject Summary(bool called)
        {
            var view = JObject.Parse(ServiceFixture(called ? "called-with-reply.json" : "korean-view.json"));
            var provenance = view["provenance"]!;
            var summary = new JObject {
                ["activityId"] = view["activityId"]!.DeepClone(), ["title"] = view["title"]!.DeepClone(),
                ["status"] = view["status"]!.DeepClone(), ["importedAt"] = provenance["importedAt"]!.DeepClone(),
                ["claimedAuthor"] = provenance["claimedAuthor"]!.DeepClone(), ["submissions"] = 1,
                ["awaitingReply"] = false, ["replyAvailable"] = true
            };
            if (called) summary["call"] = new JObject {
                ["provider"] = provenance["call"]!["provider"]!.DeepClone(),
                ["model"] = provenance["call"]!["model"]!.DeepClone()
            };
            return summary;
        }

        private static bool Valid(JObject json)
        {
            try { return Wire.Read<ActivityView>(json.ToString()).ValidFor("act_k1"); }
            catch (JsonException) { return false; }
        }
    }
}
