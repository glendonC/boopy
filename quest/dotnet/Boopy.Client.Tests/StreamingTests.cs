using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using NUnit.Framework;
namespace Boopy.Client.Tests;

public sealed class StreamingTests
{
    private const string Result = "{\"type\":\"result\",\"view\":{\"id\":\"synthetic-session\",\"state\":\"review\"}}\n";
    private sealed class Progress : IProgress<TurnProgress>
    {
        public readonly List<TurnProgress> Events = new();
        public Action? Reported;
        public void Report(TurnProgress progress) { Events.Add(progress); Reported?.Invoke(); }
    }
    private sealed class Transport : HttpMessageHandler
    {
        public int Posts, RecoveryGets;
        public Stream Stream = new MemoryStream(Encoding.UTF8.GetBytes(Result));
        public Action? BeforeReply;
        public string Media = "application/x-ndjson";
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel)
        {
            if (request.Method == HttpMethod.Get)
            {
                if (request.RequestUri!.AbsolutePath != "/v1/health") RecoveryGets++;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}}") });
            }
            Posts++; Assert.That(request.Headers.Accept.ToString(), Is.EqualTo("application/x-ndjson"));
            BeforeReply?.Invoke();
            var content = new StreamContent(Stream); content.Headers.ContentType = new(Media);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
        }
    }
    private sealed class GatedStream : Stream
    {
        private readonly byte[] first = Encoding.UTF8.GetBytes("{\"type\":\"stage\",\"stage\":\"transcribing\"}\n");
        private readonly byte[] last = Encoding.UTF8.GetBytes(Result);
        public readonly TaskCompletionSource Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int step;
        public override async Task<int> ReadAsync(byte[] buffer,int offset,int count,CancellationToken cancel)
        {
            if(step++ == 0) { Array.Copy(first,0,buffer,offset,first.Length); return first.Length; }
            if(step == 2) { await Release.Task.WaitAsync(cancel); Array.Copy(last,0,buffer,offset,last.Length); return last.Length; }
            return 0;
        }
        public override bool CanRead=>true;public override bool CanSeek=>false;public override bool CanWrite=>false;
        public override long Length=>throw new NotSupportedException();public override long Position{get=>throw new NotSupportedException();set=>throw new NotSupportedException();}
        public override int Read(byte[] b,int o,int c)=>throw new NotSupportedException();public override void Flush(){}
        public override long Seek(long o,SeekOrigin s)=>throw new NotSupportedException();public override void SetLength(long v)=>throw new NotSupportedException();public override void Write(byte[] b,int o,int c)=>throw new NotSupportedException();
    }
    [Test] public async Task ReportsRealStageBeforeTerminalResultAndUsesOneMutation()
    {
        var gate=new GatedStream();var transport=new Transport {Stream=gate};using var client=new ServiceClient(handler:transport);
        var progress=new Progress();var entered=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);progress.Reported=()=>entered.TrySetResult();
        var pending=client.StartStreamingAsync(new StartSessionRequest(),progress);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.That(pending.IsCompleted,Is.False);Assert.That(progress.Events[0].Words,Is.EqualTo("I’m working out what you said…"));
        gate.Release.SetResult();Assert.That((await pending).Id,Is.EqualTo("synthetic-session"));Assert.That(transport.Posts,Is.EqualTo(1));
    }
    [Test] public async Task CancellationStopsFurtherStageCallbacksAndNeverResends()
    {
        var gate=new GatedStream();var transport=new Transport {Stream=gate};using var client=new ServiceClient(handler:transport);using var cancel=new CancellationTokenSource();
        var progress=new Progress {Reported=cancel.Cancel};
        Assert.CatchAsync<OperationCanceledException>(async()=>await client.StartStreamingAsync(new StartSessionRequest(),progress,cancel.Token));
        Assert.That(progress.Events.Count,Is.EqualTo(1));Assert.That(transport.Posts,Is.EqualTo(1));Assert.That(transport.RecoveryGets,Is.Zero);
        await Task.CompletedTask;
    }
    [TestCase("{\"type\":\"stage\",\"stage\":\"invented-agent\"}\n")]
    [TestCase("{\"type\":\"stage\",\"stage\":\"interpreting\",\"text\":\"unvalidated answer\"}\n")]
    [TestCase("{\"type\":\"result\",\"view\":{\"id\":\"wrong-session\",\"state\":\"review\"}}\n")]
    [TestCase("{\"type\":\"stage\",\"stage\":\"interpreting\"}")]
    [TestCase(Result+Result)]
    public void InvalidIncompleteOrCrossSessionEventsNeverBecomeAResult(string body)
    {
        var transport=new Transport {Stream=new MemoryStream(Encoding.UTF8.GetBytes(body))};using var client=new ServiceClient(handler:transport);
        var error=Assert.ThrowsAsync<ServiceException>(async()=>await client.UtterStreamingAsync("synthetic-session",new UtteranceRequest(),new Progress()));
        Assert.That(error!.Code,Is.EqualTo("invalid_reply"));Assert.That(transport.Posts,Is.EqualTo(1));
        Assert.That(error.Message,Does.Contain("Processing may continue"));
        Assert.That(error.Message,Does.Contain("Reconnect USB"));
        Assert.That(error.Message,Does.Not.Contain("Check capture"));
    }
    [Test] public void AStreamDeadlineChecksExactStartIdentityWithoutResending()
    {
        var transport=new Transport {Stream=new GatedStream()};using var client=new ServiceClient(handler:transport,requestTimeout:TimeSpan.FromMilliseconds(30));
        var error=Assert.ThrowsAsync<ServiceException>(async()=>await client.StartStreamingAsync(new StartSessionRequest {RequestId="11111111-1111-4111-8111-111111111111"},new Progress()));
        Assert.That(error!.Code,Is.EqualTo("request_timeout"));Assert.That(transport.Posts,Is.EqualTo(1));Assert.That(transport.RecoveryGets,Is.EqualTo(1));
    }
    [Test] public void ExcessStagesAndUnboundedLinesAreRejected()
    {
        foreach(var body in new[] {string.Concat(System.Linq.Enumerable.Repeat("{\"type\":\"stage\",\"stage\":\"interpreting\"}\n",33))+Result, new string('x',2*1024*1024+1)})
        {
            var transport=new Transport {Stream=new MemoryStream(Encoding.UTF8.GetBytes(body))};using var client=new ServiceClient(handler:transport);var progress=new Progress();
            var error=Assert.ThrowsAsync<ServiceException>(async()=>await client.StartStreamingAsync(new StartSessionRequest(),progress));
            Assert.That(error!.Code,Is.EqualTo("invalid_reply"));Assert.That(progress.Events.Count,Is.LessThanOrEqualTo(32));Assert.That(transport.Posts,Is.EqualTo(1));
        }
    }
    [TestCase("application/json")]
    public async Task LegacyJsonIsValidatedOnSamePostWithoutInventingProgress(string media)
    {
        var transport=new Transport {Media=media,Stream=new MemoryStream(Encoding.UTF8.GetBytes("{\"id\":\"synthetic-session\",\"state\":\"review\"}"))};using var client=new ServiceClient(handler:transport);var progress=new Progress();
        Assert.That((await client.StartStreamingAsync(new StartSessionRequest(),progress)).Id,Is.EqualTo("synthetic-session"));
        Assert.That(progress.Events.Count,Is.Zero);Assert.That(transport.Posts,Is.EqualTo(1));
    }
    [Test] public void ArbitraryTextCannotMasqueradeAsLegacyJson()
    {
        var transport=new Transport {Media="text/plain",Stream=new MemoryStream(Encoding.UTF8.GetBytes("{\"id\":\"synthetic-session\",\"state\":\"review\"}"))};using var client=new ServiceClient(handler:transport);
        var error=Assert.ThrowsAsync<ServiceException>(async()=>await client.StartStreamingAsync(new StartSessionRequest(),new Progress()));
        Assert.That(error!.Code,Is.EqualTo("invalid_reply"));Assert.That(transport.Posts,Is.EqualTo(1));
    }
    [Test] public void LateSuccessfulReplyCannotOverrideCallerCancellation()
    {
        using var cancel=new CancellationTokenSource();var transport=new Transport {BeforeReply=cancel.Cancel};using var client=new ServiceClient(handler:transport);
        Assert.CatchAsync<OperationCanceledException>(async()=>await client.StartStreamingAsync(new StartSessionRequest(),new Progress(),cancel.Token));
    }
    [Test] public void BoundedSanitizedTerminalErrorDoesNotApplyResult()
    {
        var transport=new Transport {Stream=new MemoryStream(Encoding.UTF8.GetBytes("{\"type\":\"error\",\"error\":{\"code\":\"synthetic_failed\",\"message\":\"Could not finish.\"}}\n"))};using var client=new ServiceClient(handler:transport);
        var error=Assert.ThrowsAsync<ServiceException>(async()=>await client.StartStreamingAsync(new StartSessionRequest(),new Progress()));
        Assert.That(error!.Code,Is.EqualTo("synthetic_failed"));Assert.That(error.Message,Is.EqualTo("Could not finish."));Assert.That(transport.Posts,Is.EqualTo(1));
    }
}
