#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class HandoffTests
    {
        private const string Session = "ses_synthetic";
        private const string Package = "ctx_synthetic";
        private const string RequestId = "synthetic-handoff";
        private static readonly string Hash = new string('a', 64);
        private static HandoffRequest Selection() => new HandoffRequest { RequestId = RequestId, PackageId = Package };
        private static HandoffStatus Pending() => new HandoffStatus {
            SessionId = Session, RequestId = RequestId, PackageId = Package,
            ReceiptId = "handoff_11111111-1111-4111-8111-111111111111", SelectionSha256 = Hash,
            Attempt = 1, State = "preparing-local",
        };
        private static HandoffStatus Completed()
        {
            var status = Pending(); status.State = "prepared-local"; status.SourceState = "unchanged";
            status.Receipt = new HandoffReceipt {
                ReceiptId = status.ReceiptId, RequestId = RequestId, PackageId = Package, State = "prepared-local",
                SelectionSha256 = Hash, BaselineSha256 = Hash, PacketSha256 = Hash, SourceSnapshotSha256 = Hash,
                PreparedAt = "1970-01-01T12:00:00.000Z", HistoricalSnapshot = true, Delivery = "not-sent",
                SelectedPackageIds = new List<string> { Package }, SelectedSourceIds = new List<string> { Package + ":itm_synthetic" },
                Memory = new HandoffMemoryResult { Status = "disabled", ReturnedSources = 0 },
                References = new HandoffReferenceResult { Status = "disabled", ReturnedAssociations = 0 },
            };
            return status;
        }
        private sealed class Transport : HttpMessageHandler
        {
            public string Answer = Wire.Write(Pending());
            public HttpStatusCode Status = HttpStatusCode.Accepted;
            public int Calls;
            public string? Body, Path;
            public HttpMethod? Method;
            public bool Hang;
            public Stream? Stream;
            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel)
            {
                Calls++; Method = request.Method; Path = request.RequestUri?.AbsolutePath;
                if (request.Content != null) Body = await request.Content.ReadAsStringAsync();
                if (Hang) await Task.Delay(Timeout.Infinite, cancel);
                return new HttpResponseMessage(Status) { Content = Stream == null ? new StringContent(Answer) : new StreamContent(Stream) };
            }
        }
        private static ServiceClient Client(Transport transport) => new ServiceClient(handler: transport, controlTimeout: TimeSpan.FromMilliseconds(100));

        [Test]
        public async Task StartsOnceAndReturnsPendingWithoutAutomaticPollingOrMutationRetry()
        {
            var transport = new Transport(); using var client = Client(transport);
            var status = await client.PrepareHandoffAsync(Session, Selection());
            Assert.That(status.State, Is.EqualTo("preparing-local"));
            Assert.That(transport.Calls, Is.EqualTo(1));
            Assert.That(transport.Method, Is.EqualTo(HttpMethod.Post));
            Assert.That(transport.Path, Is.EqualTo($"/v1/sessions/{Session}/handoff-preparations"));
            Assert.That(JObject.Parse(transport.Body!).Count, Is.EqualTo(2));
        }

        [Test]
        public async Task ReadsCompletedReceiptWithExactSelectionAndKeepsNotSentState()
        {
            var transport = new Transport { Status = HttpStatusCode.OK, Answer = Wire.Write(Completed()) };
            using var client = Client(transport);
            var status = await client.ReadHandoffAsync(Session, Selection());
            Assert.That(status.Receipt?.Delivery, Is.EqualTo("not-sent"));
            Assert.That(status.Receipt?.HistoricalSnapshot, Is.True);
            Assert.That(transport.Method, Is.EqualTo(HttpMethod.Get));
            Assert.That(transport.Calls, Is.EqualTo(1));
            Assert.That(transport.Body, Is.Null);
        }

        [Test]
        public async Task ReadsFailedOrPendingWithoutInventingCompletion()
        {
            var status = Pending(); status.State = "failed"; status.Reason = "interrupted";
            var transport = new Transport { Status = HttpStatusCode.OK, Answer = Wire.Write(status) };
            using var client = Client(transport);
            Assert.That((await client.ReadHandoffAsync(Session, RequestId)).State, Is.EqualTo("failed"));
            transport.Answer = Wire.Write(Pending());
            Assert.That((await client.ReadHandoffAsync(Session, Selection())).State, Is.EqualTo("preparing-local"));
        }

        [TestCase("sessionId", "ses_other")]
        [TestCase("requestId", "other-request")]
        [TestCase("packageId", "ctx_other")]
        [TestCase("receiptId", "not-a-receipt")]
        [TestCase("selectionSha256", "not-a-hash")]
        [TestCase("state", "delivered")]
        [TestCase("sourceState", "unknown")]
        public void RejectsMismatchedOrUnverifiableMetadata(string field, string value)
        {
            var body = JObject.Parse(Wire.Write(Completed())); body[field] = value;
            var transport = new Transport { Status = HttpStatusCode.OK, Answer = body.ToString() };
            using var client = Client(transport);
            var error = Assert.ThrowsAsync<ServiceException>(() => client.ReadHandoffAsync(Session, Selection()));
            Assert.That(error!.Code, Is.EqualTo("invalid_reply"));
            Assert.That(transport.Calls, Is.EqualTo(1));
        }

        [TestCase("delivery", "sent")]
        [TestCase("baselineSha256", "bad")]
        [TestCase("packetSha256", "bad")]
        [TestCase("sourceSnapshotSha256", "bad")]
        [TestCase("preparedAt", "unknown")]
        [TestCase("packageId", "ctx_other")]
        [TestCase("requestId", "other-request")]
        public void RejectsInvalidCompletedReceipt(string field, string value)
        {
            var body = JObject.Parse(Wire.Write(Completed())); body["receipt"]![field] = value;
            using var client = Client(new Transport { Status = HttpStatusCode.OK, Answer = body.ToString() });
            Assert.That(Assert.ThrowsAsync<ServiceException>(() => client.ReadHandoffAsync(Session, Selection()))!.Code, Is.EqualTo("invalid_reply"));
        }

        [TestCase("{}")]
        [TestCase("{malformed")]
        [TestCase("null")]
        public void GenericSuccessAndMalformedBodiesAreNotPreparationReceipts(string body)
        {
            using var client = Client(new Transport { Status = HttpStatusCode.OK, Answer = body });
            Assert.That(Assert.ThrowsAsync<ServiceException>(() => client.ReadHandoffAsync(Session, Selection()))!.Code, Is.EqualTo("invalid_reply"));
        }

        [Test]
        public void RejectsWidenedScopeMissingTrustFieldsAndContradictoryModuleState()
        {
            foreach (var mutate in new Action<JObject>[] {
                body => body["receipt"]!["selectedPackageIds"] = new JArray(Package, "ctx_unselected"),
                body => body["receipt"]!["selectedSourceIds"] = new JArray("ctx_unselected:itm_other"),
                body => ((JObject)body["receipt"]!).Remove("historicalSnapshot"),
                body => body.Remove("sourceState"),
                body => body["receipt"]!["memory"]!["status"] = "available",
                body => body["receipt"]!["memory"]!["returnedSources"] = 1,
                body => body["receipt"]!["references"]!["returnedAssociations"] = 1,
            }) {
                var body = JObject.Parse(Wire.Write(Completed())); mutate(body);
                using var client = Client(new Transport { Status = HttpStatusCode.OK, Answer = body.ToString() });
                Assert.That(Assert.ThrowsAsync<ServiceException>(() => client.ReadHandoffAsync(Session, Selection()))!.Code, Is.EqualTo("invalid_reply"));
            }
        }

        [Test]
        public void StatusCodeMustAgreeWithPreparationState()
        {
            using var client = Client(new Transport { Status = HttpStatusCode.OK });
            Assert.That(Assert.ThrowsAsync<ServiceException>(() => client.PrepareHandoffAsync(Session, Selection()))!.Code, Is.EqualTo("invalid_reply"));
            using var other = Client(new Transport { Status = HttpStatusCode.Accepted, Answer = Wire.Write(Completed()) });
            Assert.That(Assert.ThrowsAsync<ServiceException>(() => other.PrepareHandoffAsync(Session, Selection()))!.Code, Is.EqualTo("invalid_reply"));
        }

        [Test]
        public void BoundsResponseAndNeverRetriesAfterTimeoutOrRefusal()
        {
            var huge = new Transport { Status = HttpStatusCode.OK, Answer = new string('x', 256 * 1024 + 1) };
            using var client = Client(huge);
            Assert.That(Assert.ThrowsAsync<ServiceException>(() => client.ReadHandoffAsync(Session, Selection()))!.Code, Is.EqualTo("invalid_reply"));
            var hanging = new Transport { Hang = true }; using var waiting = Client(hanging);
            Assert.That(Assert.ThrowsAsync<ServiceException>(() => waiting.PrepareHandoffAsync(Session, Selection()))!.Code, Is.EqualTo("request_timeout"));
            Assert.That(hanging.Calls, Is.EqualTo(1));
            var refused = new Transport { Status = HttpStatusCode.Conflict }; using var failing = Client(refused);
            Assert.ThrowsAsync<ServiceException>(() => failing.PrepareHandoffAsync(Session, Selection()));
            Assert.That(refused.Calls, Is.EqualTo(1));
        }

        private sealed class WaitingStream : MemoryStream
        {
            public bool Disposed;
            public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            { await Task.Delay(Timeout.Infinite, cancellationToken); return 0; }
            protected override void Dispose(bool disposing) { Disposed = true; base.Dispose(disposing); }
        }

        [Test]
        public void BodyReadSharesDeadlineAndDisposesTransportResources()
        {
            var stream = new WaitingStream();
            using var client = Client(new Transport { Status = HttpStatusCode.OK, Stream = stream });
            Assert.That(Assert.ThrowsAsync<ServiceException>(() => client.ReadHandoffAsync(Session, Selection()))!.Code, Is.EqualTo("request_timeout"));
            Assert.That(stream.Disposed, Is.True);
        }

        [Test]
        public void ExplicitCancellationIsPreservedAndNoRequestIsRetried()
        {
            var transport = new Transport { Hang = true }; using var client = Client(transport);
            using var cancel = new CancellationTokenSource(20);
            Assert.CatchAsync<OperationCanceledException>(() => client.PrepareHandoffAsync(Session, Selection(), cancel.Token));
            Assert.That(transport.Calls, Is.EqualTo(1));
        }

        [Test]
        public async Task KeepsChangedSourceStatusSeparateFromImmutableHistoricalReceipt()
        {
            var status = Completed(); status.SourceState = "changed";
            using var client = Client(new Transport { Status = HttpStatusCode.OK, Answer = Wire.Write(status) });
            var returned = await client.ReadHandoffAsync(Session, Selection());
            Assert.That(returned.SourceState, Is.EqualTo("changed"));
            Assert.That(returned.Receipt?.HistoricalSnapshot, Is.True);
            Assert.That(returned.Receipt?.Delivery, Is.EqualTo("not-sent"));
        }

        [Test]
        public void RejectsInvalidExplicitSelectionsBeforeNetwork()
        {
            var transport = new Transport(); using var client = Client(transport);
            var selection = Selection(); selection.References = new HandoffReferenceSelection {
                PackageId = Package, ItemId = "itm_synthetic", ConceptKey = "dune", ReferenceId = "Q8514",
            };
            Assert.Throws<ArgumentException>(() => client.PrepareHandoffAsync(Session, selection));
            selection.References = null;
            selection.Memory = new HandoffMemorySelection { PackageIds = new List<string> { Package }, Query = " " };
            Assert.Throws<ArgumentException>(() => client.PrepareHandoffAsync(Session, selection));
            Assert.That(transport.Calls, Is.Zero);
        }

        [TestCase(false)]
        [TestCase(true)]
        public async Task PreservesExplicitOptionalModuleAvailabilityWithoutInventingDelivery(bool available)
        {
            var request = Selection();
            request.Memory = new HandoffMemorySelection { PackageIds = new List<string> { "ctx_earlier" }, Query = "synthetic" };
            request.References = new HandoffReferenceSelection { PackageId = Package, ItemId = "itm_synthetic", ConceptKey = "dune", ReferenceId = "Q25391" };
            var status = Completed();
            Assert.That(status.Receipt, Is.Not.Null);
            status.Receipt!.SelectedPackageIds.Add("ctx_earlier");
            status.Receipt.Memory = new HandoffMemoryResult { Status = available ? "available" : "unavailable", ReturnedSources = available ? 1 : 0 };
            status.Receipt.References = new HandoffReferenceResult { Status = available ? "available" : "unavailable",
                ReturnedAssociations = available ? 1 : 0, SourceRecordSha256 = available ? Hash : null };
            using var client = Client(new Transport { Status = HttpStatusCode.OK, Answer = Wire.Write(status) });
            var returned = await client.ReadHandoffAsync(Session, request);
            Assert.That(returned.Receipt?.Memory?.Status, Is.EqualTo(available ? "available" : "unavailable"));
            Assert.That(returned.Receipt?.Delivery, Is.EqualTo("not-sent"));
        }

        private sealed class UnseekableStream : MemoryStream
        {
            public bool Disposed;
            public UnseekableStream(byte[] bytes) : base(bytes) { }
            public override bool CanSeek => false;
            protected override void Dispose(bool disposing) { Disposed = true; base.Dispose(disposing); }
        }
        [Test]
        public void UnknownLengthResponseCannotBypassByteLimit()
        {
            var stream = new UnseekableStream(new byte[256 * 1024 + 1]);
            using var client = Client(new Transport { Status = HttpStatusCode.OK, Stream = stream });
            Assert.That(Assert.ThrowsAsync<ServiceException>(() => client.ReadHandoffAsync(Session, Selection()))!.Code, Is.EqualTo("invalid_reply"));
            Assert.That(stream.Disposed, Is.True);
        }
    }
}
