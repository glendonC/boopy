using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests;

public class SessionStartRecoveryTests
{
    private const string Id = "00000000-0000-4000-8000-000000000042";
    private sealed class Handler : HttpMessageHandler
    {
        public readonly List<string> Calls = new();
        public bool TimeoutPost, CancelPost, CancelRead, TimeoutRead;
        public string Receipt = "{\"requestId\":\"" + Id + "\",\"sessionId\":\"synthetic\",\"status\":\"succeeded\",\"view\":{\"id\":\"synthetic\",\"state\":\"review\"}}";
        public CancellationTokenSource Caller = new();
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
        {
            Calls.Add(request.Method + " " + request.RequestUri!.AbsolutePath);
            if (request.RequestUri.AbsolutePath == "/v1/health") return new(HttpStatusCode.OK) { Content = new StringContent("{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}}") };
            if (request.Method == HttpMethod.Post)
            {
                if (CancelPost) Caller.Cancel();
                if (TimeoutPost) { await Task.Delay(50); throw new OperationCanceledException(); }
                throw new HttpRequestException("synthetic interrupted response");
            }
            if (CancelRead) Caller.Cancel();
            if (TimeoutRead) await Task.Delay(50);
            return new(HttpStatusCode.OK) { Content = new StringContent(Receipt) };
        }
    }
    [TestCase(false)] [TestCase(true)]
    public async Task LostOrTimedOutStartRecoversOnceWithoutRepeatingPost(bool timeout)
    {
        var handler = new Handler { TimeoutPost = timeout };
        using var client = new ServiceClient(handler: handler, requestTimeout: TimeSpan.FromMilliseconds(10));
        var view = await client.StartAsync(new StartSessionRequest { RequestId = Id });
        Assert.That(view.Id, Is.EqualTo("synthetic"));
        Assert.That(handler.Calls, Is.EqualTo(new[] { "GET /v1/health", "POST /v1/sessions", "GET /v1/session-starts/" + Id }));
    }
    [TestCase("pending")] [TestCase("failed")] [TestCase("interrupted")] [TestCase("mismatch-id")] [TestCase("mismatch-session")] [TestCase("missing-view")] [TestCase("invalid-json")]
    public void InvalidOrUnfinishedReceiptKeepsOriginalUncertainFailure(string scenario)
    {
        var handler = new Handler();
        if (scenario == "mismatch-id") handler.Receipt = handler.Receipt.Replace(Id, "00000000-0000-4000-8000-000000000043");
        else if (scenario == "mismatch-session") handler.Receipt = handler.Receipt.Replace("\"sessionId\":\"synthetic\"", "\"sessionId\":\"other\"");
        else if (scenario == "invalid-json") handler.Receipt = "not-json";
        else if (scenario == "missing-view") handler.Receipt = "{\"requestId\":\"" + Id + "\",\"sessionId\":\"synthetic\",\"status\":\"succeeded\"}";
        else handler.Receipt = handler.Receipt.Replace("succeeded", scenario);
        using var client = new ServiceClient(handler: handler);
        var failure = Assert.ThrowsAsync<ServiceException>(() => client.StartAsync(new StartSessionRequest { RequestId = Id }));
        Assert.That(failure!.Code, Is.EqualTo("connection_lost"));
        Assert.That(handler.Calls.Count, Is.EqualTo(3));
    }
    [TestCase(false)] [TestCase(true)]
    public void ExplicitCancellationPreventsRecoveryOrIgnoresLateReceipt(bool duringRead)
    {
        using var caller = new CancellationTokenSource();
        var handler = new Handler { Caller = caller, CancelPost = !duringRead, CancelRead = duringRead };
        using var client = new ServiceClient(handler: handler);
        Assert.CatchAsync<OperationCanceledException>(() => client.StartAsync(new StartSessionRequest { RequestId = Id }, caller.Token));
        Assert.That(handler.Calls.Count, Is.EqualTo(duringRead ? 3 : 2));
    }
    [Test] public void PendingReceiptPreservesOriginalTimeoutFailure()
    {
        var handler = new Handler { TimeoutPost = true };
        handler.Receipt = handler.Receipt.Replace("succeeded", "pending");
        using var client = new ServiceClient(handler: handler, requestTimeout: TimeSpan.FromMilliseconds(10));
        var failure = Assert.ThrowsAsync<ServiceException>(() => client.StartAsync(new StartSessionRequest { RequestId = Id }));
        Assert.That(failure!.Code, Is.EqualTo("request_timeout"));
        Assert.That(handler.Calls.Count, Is.EqualTo(3));
    }
    [Test] public void KeylessStartHasNoReceiptLookup()
    {
        var handler = new Handler(); using var client = new ServiceClient(handler: handler);
        Assert.ThrowsAsync<ServiceException>(() => client.StartAsync(new StartSessionRequest()));
        Assert.That(handler.Calls, Is.EqualTo(new[] { "GET /v1/health", "POST /v1/sessions" }));
    }
    [Test] public void ReceiptLookupDeadlineCannotTurnLateResultIntoSuccess()
    {
        var handler = new Handler { TimeoutRead = true };
        using var client = new ServiceClient(handler: handler, controlTimeout: TimeSpan.FromMilliseconds(10));
        var failure = Assert.ThrowsAsync<ServiceException>(() => client.StartAsync(new StartSessionRequest { RequestId = Id }));
        Assert.That(failure!.Code, Is.EqualTo("connection_lost"));
        var readFailure = Assert.ThrowsAsync<ServiceException>(() => client.ReadStartAsync(Id));
        Assert.That(readFailure!.Code, Is.EqualTo("start_read_timeout"));
    }
}
