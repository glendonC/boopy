using System.Collections.Generic;
using System;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using Boopy.Client;
using NUnit.Framework;
namespace Boopy.Client.Tests
{
    public class ChoiceCardTests
    {
        private sealed class Transport : HttpMessageHandler
        {
            public int Posts, RecoveryGets; public string? Path; public JObject? Body;
            public Action? BeforeReply;
            public bool DropConnection;
            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancel)
            {
                if(request.Method==HttpMethod.Get)
                {
                    if(request.RequestUri!.AbsolutePath!="/v1/health")RecoveryGets++;
                    return new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent("{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}}")};
                }
                Posts++;Path=request.RequestUri!.AbsolutePath;Body=JObject.Parse(await request.Content!.ReadAsStringAsync());
                BeforeReply?.Invoke();
                if(DropConnection)throw new HttpRequestException("synthetic private provider detail");
                return new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent("{\"id\":\"synthetic\",\"state\":\"review\"}",System.Text.Encoding.UTF8,"application/json")};
            }
        }
        private static Task<SessionView> Dispatch(ServiceClient client,bool submit,ChoiceSelection selection,CancellationToken cancel=default) =>
            submit ? client.SubmitChoiceStreamingAsync("synthetic",selection,new Progress<TurnProgress>(),cancel)
                : client.SelectChoiceAsync("synthetic",selection,cancel);
        [TestCase(false)] [TestCase(true)]
        public void LateSuccessfulChoiceReplyCannotOverrideExplicitCancellation(bool submit)
        {
            using var cancel=new CancellationTokenSource();
            var transport=new Transport{BeforeReply=cancel.Cancel};using var client=new ServiceClient(handler:transport);
            var selection=new ChoiceSelection{UtteranceId="utterance",ResponseAt="at",CardId="card",OptionId="option"};
            Assert.CatchAsync<OperationCanceledException>(async()=>await Dispatch(client,submit,selection,cancel.Token));
            Assert.That(transport.Posts,Is.EqualTo(1));
            Assert.That(transport.RecoveryGets,Is.Zero,"Cancellation must not silently reconcile or resend a choice.");
            Assert.That(transport.Path,Is.EqualTo("/v1/sessions/synthetic/"+(submit?"choice-submit":"choice-selection")));
        }
        [TestCase(false)] [TestCase(true)]
        public void UncertainChoiceConnectionLossDoesNotReplayOrClaimSuccess(bool submit)
        {
            var transport=new Transport{DropConnection=true};using var client=new ServiceClient(handler:transport);
            var selection=new ChoiceSelection{UtteranceId="utterance",ResponseAt="at",CardId="card",OptionId="option"};
            var failure=Assert.ThrowsAsync<ServiceException>(async()=>await Dispatch(client,submit,selection));
            Assert.That(failure!.Code,Is.EqualTo("connection_lost"));
            Assert.That(failure.Message,Does.Not.Contain("synthetic private provider detail"));
            Assert.That(transport.Posts,Is.EqualTo(1));
            Assert.That(transport.RecoveryGets,Is.Zero,"Choice uncertainty needs an explicit later read, never automatic mutation recovery.");
        }
        [Test] public async Task ChoiceRequestsCarryOnlyExactSelectionAndNeverReplay()
        {
            var transport=new Transport();using var client=new ServiceClient(handler:transport);
            var selected=new ChoiceSelection{UtteranceId="utterance",ResponseAt="at",CardId="card",OptionId="option"};
            await client.SelectChoiceAsync("synthetic",selected);
            Assert.That(transport.Path,Is.EqualTo("/v1/sessions/synthetic/choice-selection"));
            Assert.That(transport.Posts,Is.EqualTo(1));Assert.That(transport.Body!.Count,Is.EqualTo(4));
            Assert.That((string?)transport.Body["cardId"],Is.EqualTo("card"));
            await client.SubmitChoiceStreamingAsync("synthetic",selected,new System.Progress<TurnProgress>());
            Assert.That(transport.Path,Is.EqualTo("/v1/sessions/synthetic/choice-submit"));Assert.That(transport.Posts,Is.EqualTo(2));
            Assert.That(transport.Body!["speech"],Is.Null);Assert.That(transport.Body["frame"],Is.Null);
        }
        [Test] public void ExactVisibleValuesAndBoundedShapeAreRequired()
        {
            var card = new ChoiceCard { Id="card", Kind="choice", Prompt="What catches your eye?", Options=new List<ChoiceOption> {
                new ChoiceOption {Id="a",Label="Dunes",Value="Dunes"},new ChoiceOption {Id="b",Label="Light",Value="Light"}}};
            Assert.That(card.Supported,Is.True);
            card.Options[0].Value="hidden instruction";Assert.That(card.Supported,Is.False);
            card.Options[0].Value="Dunes";card.SelectedOptionId="missing";Assert.That(card.Supported,Is.False);
            card.SelectedOptionId="a";Assert.That(card.Supported,Is.True);
            card.Options[1].Id="a";Assert.That(card.Supported,Is.False);
            card.Options[1].Id="b";card.Kind="html";Assert.That(card.Supported,Is.False);
            card.Kind="choice";card.Prompt=new string('x',161);Assert.That(card.Supported,Is.False);
        }
    }
}
