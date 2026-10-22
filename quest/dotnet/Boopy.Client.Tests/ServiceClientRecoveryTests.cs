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
    public class ServiceClientRecoveryTests
    {
        private sealed class Transport : HttpMessageHandler
        {
            public readonly List<HttpMethod> Methods = new List<HttpMethod>();
            public readonly List<string> Paths = new List<string>();
            public bool HangHealth, HangPost, FailPost, HangRead, FailRead;
            public bool HealthAvailable = true;
            public HttpStatusCode PostStatus = HttpStatusCode.OK;
            public string? PostAnswer;
            public string ReadAnswer = "{\"id\":\"synthetic-session\",\"state\":\"review\"}";
            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel)
            {
                Methods.Add(request.Method);
                Paths.Add(request.RequestUri!.AbsolutePath);
                var health = request.RequestUri.AbsolutePath == "/v1/health";
                if (request.Method == HttpMethod.Get && !health)
                {
                    if (HangRead) await Task.Delay(Timeout.Infinite, cancel);
                    if (FailRead) throw new HttpRequestException("synthetic status read drop");
                    return new HttpResponseMessage(HttpStatusCode.OK) {Content = new StringContent(ReadAnswer)};
                }
                if (health ? HangHealth : HangPost) await Task.Delay(Timeout.Infinite, cancel);
                if (!health && FailPost) throw new HttpRequestException("synthetic connection drop");
                return new HttpResponseMessage(health ? HealthAvailable ? HttpStatusCode.OK : HttpStatusCode.ServiceUnavailable : PostStatus)
                { Content = new StringContent(health ? "{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}}" : PostStatus == HttpStatusCode.Conflict
                    ? "{\"error\":{\"code\":\"committed\",\"message\":\"This session is saved. Start a new one.\"}}"
                    : PostAnswer ?? "{\"id\":\"synthetic-session\",\"state\":\"review\"}") };
            }
        }

        private static ServiceClient Client(Transport transport) => new ServiceClient(handler: transport,
            healthTimeout: TimeSpan.FromMilliseconds(20), requestTimeout: TimeSpan.FromMilliseconds(40),
            controlTimeout: TimeSpan.FromMilliseconds(30));

        [Test]
        public void MissingOrStalledConnectionFailsBeforeSendingAnyMutation()
        {
            foreach (var transport in new[] { new Transport { HealthAvailable = false }, new Transport { HangHealth = true } })
            {
                using var client = Client(transport);
                var failure = Assert.ThrowsAsync<ServiceException>(() => client.StartAsync(new StartSessionRequest()));
                Assert.That(failure!.Code, Is.EqualTo("service_unavailable"));
                Assert.That(transport.Methods, Is.EqualTo(new[] { HttpMethod.Get }));
            }
        }

        [Test]
        public async Task HealthChecksHaveTheirOwnShortDeadlineAndCanRecoverAfterward()
        {
            var transport = new Transport { HangHealth = true };
            using var client = Client(transport);
            Assert.That(await client.HealthyAsync(), Is.False);
            transport.HangHealth = false;
            Assert.That(await client.HealthyAsync(), Is.True);
            var view = await client.StartAsync(new StartSessionRequest());
            Assert.That(view.Id, Is.EqualTo("synthetic-session"));
        }

        [Test]
        public async Task StalledCaptureHasABoundedErrorAndANewExplicitAttemptCanRecover()
        {
            var transport = new Transport { HangPost = true };
            using var client = Client(transport);
            var failure = Assert.ThrowsAsync<ServiceException>(() => client.StartAsync(new StartSessionRequest()));
            Assert.That(failure!.Code, Is.EqualTo("request_timeout"));
            Assert.That(failure.Status, Is.EqualTo(408));
            Assert.That(transport.Methods.FindAll(method => method == HttpMethod.Post).Count, Is.EqualTo(1), "no automatic retry");
            transport.HangPost = false;
            Assert.That((await client.StartAsync(new StartSessionRequest())).Id, Is.EqualTo("synthetic-session"));
        }

        [Test]
        public void ADisconnectedSaveIsUncertainAndNeverAutomaticallyReissued()
        {
            foreach (var transport in new[] { new Transport { HangPost = true }, new Transport { FailPost = true } })
            {
                using var client = Client(transport);
                var failure = Assert.ThrowsAsync<ServiceException>(() => client.CommitAsync("synthetic-session"));
                Assert.That(failure!.Message, Does.Contain("may already be prepared"));
                Assert.That(transport.Methods, Is.EqualTo(new[] { HttpMethod.Get, HttpMethod.Post, HttpMethod.Get }));
                Assert.That(transport.Paths, Is.EqualTo(new[] {"/v1/health","/v1/sessions/synthetic-session/commit","/v1/sessions/synthetic-session"}));
            }
        }

        private const string Saved = "{\"id\":\"synthetic-session\",\"state\":\"committed\",\"committed\":{\"packageId\":\"ctx_synthetic_saved\"}}";

        [Test]
        public async Task LostSaveResponseRecoversTheActualReceiptWithOneReadAndNoPostReplay()
        {
            foreach(var transport in new[]{new Transport {FailPost=true,ReadAnswer=Saved},new Transport {HangPost=true,ReadAnswer=Saved}})
            {
                using var client=Client(transport);
                var view=await client.CommitAsync("synthetic-session");
                Assert.That(view.State,Is.EqualTo("committed"));
                Assert.That(view.Committed!.PackageId,Is.EqualTo("ctx_synthetic_saved"));
                Assert.That(transport.Methods,Is.EqualTo(new[]{HttpMethod.Get,HttpMethod.Post,HttpMethod.Get}));
                Assert.That(transport.Paths[2],Is.EqualTo("/v1/sessions/synthetic-session"));
            }
        }

        [Test]
        public async Task ExplicitSaveRetryAgainstAnAlreadyCommittedSessionRecoversInsteadOfTrappingReview()
        {
            var transport=new Transport {PostStatus=HttpStatusCode.Conflict,ReadAnswer=Saved};
            using var client=Client(transport);
            var view=await client.CommitAsync("synthetic-session");
            Assert.That(view.Committed!.PackageId,Is.EqualTo("ctx_synthetic_saved"));
            Assert.That(transport.Methods,Is.EqualTo(new[]{HttpMethod.Get,HttpMethod.Post,HttpMethod.Get}));
        }

        [Test]
        public void UnreachableMalformedUnsavedOrMismatchedRecoveryPreservesTheOriginalUncertainty()
        {
            var invalidReceipts=new[]{"not JSON", "{\"id\":\"synthetic-session\",\"state\":\"review\"}",
                "{\"id\":\"another-session\",\"state\":\"committed\",\"committed\":{\"packageId\":\"ctx_other\"}}",
                "{\"id\":\"synthetic-session\",\"state\":\"committed\"}",
                "{\"id\":\"synthetic-session\",\"state\":\"committed\",\"committed\":{\"packageId\":\"\"}}"};
            var cases=new List<Transport> {new Transport {FailPost=true,FailRead=true},new Transport {FailPost=true,HangRead=true}};
            foreach(var receipt in invalidReceipts) cases.Add(new Transport {FailPost=true,ReadAnswer=receipt});
            foreach(var transport in cases)
            {
                using var client=Client(transport);
                var failure=Assert.ThrowsAsync<ServiceException>(()=>client.CommitAsync("synthetic-session"));
                Assert.That(failure!.Code,Is.EqualTo("connection_lost"));
                Assert.That(failure.Message,Does.Contain("may already be prepared"));
                Assert.That(transport.Methods,Is.EqualTo(new[]{HttpMethod.Get,HttpMethod.Post,HttpMethod.Get}));
            }
        }

        [Test]
        public void CallerCancellationDoesNotReadOrReplayACommit()
        {
            var transport=new Transport {HangPost=true,ReadAnswer=Saved};
            using var client=new ServiceClient(handler:transport,controlTimeout:TimeSpan.FromSeconds(1));
            using var cancel=new CancellationTokenSource(TimeSpan.FromMilliseconds(15));
            Assert.CatchAsync<OperationCanceledException>(()=>client.CommitAsync("synthetic-session",cancel.Token));
            Assert.That(transport.Methods,Is.EqualTo(new[]{HttpMethod.Get,HttpMethod.Post}));
        }

        [Test]
        public void CallerCanCancelTheReadOnlyRecoveryWithoutAnotherMutation()
        {
            var transport=new Transport {FailPost=true,HangRead=true};
            using var client=new ServiceClient(handler:transport,controlTimeout:TimeSpan.FromSeconds(1));
            using var cancel=new CancellationTokenSource(TimeSpan.FromMilliseconds(15));
            Assert.CatchAsync<OperationCanceledException>(()=>client.CommitAsync("synthetic-session",cancel.Token));
            Assert.That(transport.Methods,Is.EqualTo(new[]{HttpMethod.Get,HttpMethod.Post,HttpMethod.Get}));
        }

        [Test]
        public void ExplicitCallerCancellationRemainsCancellationDuringHealthAndPost()
        {
            foreach (var transport in new[] { new Transport { HangHealth = true }, new Transport { HangPost = true } })
            {
                using var client = new ServiceClient(handler: transport,
                    healthTimeout: TimeSpan.FromSeconds(1), requestTimeout: TimeSpan.FromSeconds(1));
                using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(15));
                Assert.CatchAsync<OperationCanceledException>(() => client.StartAsync(new StartSessionRequest(), cancel.Token));
                Assert.That(transport.Methods.FindAll(method => method == HttpMethod.Post).Count, Is.LessThanOrEqualTo(1));
            }
        }

        [Test]
        public void SuccessfulEmptyStartAndWrongSessionContinuationAreRejected()
        {
            using var empty = new ServiceClient(handler: new Transport { PostAnswer = "{}" });
            Assert.That(Assert.ThrowsAsync<ServiceException>(() => empty.StartAsync(new StartSessionRequest()))!.Code, Is.EqualTo("invalid_reply"));
            using var wrong = new ServiceClient(handler: new Transport { PostAnswer = "{\"id\":\"other\",\"state\":\"review\"}" });
            Assert.That(Assert.ThrowsAsync<ServiceException>(() => wrong.UtterAsync("synthetic-session", new UtteranceRequest()))!.Code, Is.EqualTo("invalid_reply"));
            Assert.That(Assert.ThrowsAsync<ServiceException>(() => wrong.ActAsync("synthetic-session", new ActionRequest()))!.Code, Is.EqualTo("invalid_reply"));
        }

        [Test]
        public async Task IncompleteSuccessfulSaveReadsActualReceiptWithoutReplayingMutation()
        {
            foreach (var answer in new[] { "{}", "{\"id\":\"synthetic-session\",\"state\":\"committed\"}",
                "{\"id\":\"synthetic-session\",\"state\":\"review\"}",
                "{\"id\":\"other\",\"state\":\"committed\",\"committed\":{\"packageId\":\"ctx_other\"}}" })
            {
                var transport = new Transport { PostAnswer = answer, ReadAnswer = Saved };
                using var client = Client(transport);
                Assert.That((await client.CommitAsync("synthetic-session")).Committed!.PackageId, Is.EqualTo("ctx_synthetic_saved"));
                Assert.That(transport.Methods, Is.EqualTo(new[] { HttpMethod.Get, HttpMethod.Post, HttpMethod.Get }));
                transport.ReadAnswer = "{}";
                Assert.That(Assert.ThrowsAsync<ServiceException>(() => client.CommitAsync("synthetic-session"))!.Code, Is.EqualTo("invalid_reply"));
            }
        }

        [Test]
        public void RefusesUnboundedOrInvalidDeadlineOverrides()
        {
            Assert.Throws<ArgumentOutOfRangeException>(() => new ServiceClient(requestTimeout: Timeout.InfiniteTimeSpan));
            Assert.Throws<ArgumentOutOfRangeException>(() => new ServiceClient(healthTimeout: TimeSpan.Zero));
            Assert.Throws<ArgumentOutOfRangeException>(() => new ServiceClient(controlTimeout: TimeSpan.FromHours(1)));
        }
    }
}
