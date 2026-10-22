using System;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using NUnit.Framework;
namespace Boopy.Client.Tests;
public sealed class HealthTests
{
    private sealed class Transport : HttpMessageHandler
    {
        public string Body = "{}";
        public HttpStatusCode Status = HttpStatusCode.OK;
        public bool Hang, Drop, CancelLate;
        public CancellationTokenSource? Caller;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel)
        {
            Assert.That(request.Method, Is.EqualTo(HttpMethod.Get));
            Assert.That(request.RequestUri!.AbsolutePath, Is.EqualTo("/v1/health"));
            if (Hang) await Task.Delay(Timeout.Infinite, cancel);
            if (Drop) throw new HttpRequestException("synthetic private detail");
            if (CancelLate) Caller!.Cancel();
            return new(Status) { Content = new StringContent(Body) };
        }
    }
    [TestCase("{}")]
    [TestCase("{\"ok\":true}")]
    [TestCase("{\"ok\":false,\"service\":\"boopy\"}")]
    [TestCase("{\"ok\":true,\"service\":\"another-app\",\"interpreter\":{\"provider\":\"meta-model-api\",\"model\":\"muse-spark\"}}")]
    [TestCase("<html>ok</html>")]
    [TestCase("null")]
    public async Task GenericSuccessOrMalformedPayloadDoesNotEstablishBoopyConnection(string body)
    {
        using var client = new ServiceClient(handler:new Transport {Body=body});
        Assert.That(await client.ReadHealthAsync(), Is.Null);
    }
    [TestCase("fixture")][TestCase("ollama")][TestCase("meta-model-api")]
    public async Task ValidatedConnectionReturnsConfiguredCapabilitiesWithoutMuseIdentity(string provider)
    {
        using var client = new ServiceClient(handler:new Transport {Body=$"{{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{{\"provider\":\"{provider}\",\"model\":\"synthetic\"}},\"speechOutputAvailable\":true}}"});
        var health=await client.ReadHealthAsync();
        Assert.That(health, Is.Not.Null); Assert.That(health!.Interpreter!.Provider, Is.EqualTo(provider));
        Assert.That(health.SpeechOutputAvailable, Is.True);
    }
    [Test] public async Task FailureAndDeadlineAreUnavailableButCallerCancellationRemainsCancellation()
    {
        using(var client = new ServiceClient(handler:new Transport{Status=HttpStatusCode.ServiceUnavailable})) Assert.That(await client.ReadHealthAsync(),Is.Null);
        using(var client = new ServiceClient(handler:new Transport{Drop=true})) Assert.That(await client.ReadHealthAsync(),Is.Null);
        using(var client = new ServiceClient(handler:new Transport{Hang=true},healthTimeout:TimeSpan.FromMilliseconds(20))) Assert.That(await client.ReadHealthAsync(),Is.Null);
        using var caller=new CancellationTokenSource();
        using var late=new ServiceClient(handler:new Transport{CancelLate=true,Caller=caller});
        Assert.ThrowsAsync<OperationCanceledException>(async()=>await late.ReadHealthAsync(caller.Token));
    }
    [TestCase("", null)]
    [TestCase(",\"liveScene\":null", false)]
    [TestCase(",\"liveScene\":{}", null)]
    [TestCase(",\"liveScene\":{\"provider\":\"local\"}", null)]
    [TestCase(",\"liveScene\":{\"provider\":\"local\",\"model\":\"synthetic\"}", true)]
    public async Task LiveSceneCapabilityDistinguishesExplicitAbsenceFromOlderUnknownHealth(string capability, bool? expected)
    {
        using var client=new ServiceClient(handler:new Transport {Body="{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}"+capability+"}"});
        var health=await client.ReadHealthAsync();
        Assert.That(health,Is.Not.Null);
        Assert.That(health!.LiveSceneAvailable,Is.EqualTo(expected));
    }
}
