#nullable enable
using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using Newtonsoft.Json.Linq;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>Production dispatch with synthetic transport; no camera, microphone or provider claim.</summary>
    public static class ContextualFollowUpValidation
    {
        public static void Validate()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            HangulFont.Install();
            foreach (var outcome in new[] { "accepted", "cancelled", "focus-lost", "transport", "malformed" }) ValidateTurn(outcome);
            Debug.Log("Boopy contextual follow-up dispatch validation passed (synthetic HTTP, exact selected origin, no new capture/audio).");
        }

        private static void ValidateTurn(string outcome)
        {
            var root = new GameObject("Synthetic contextual follow-up " + outcome);
            try
            {
                var eyes = new GameObject("Synthetic eyes").transform; eyes.SetParent(root.transform, false);
                var room = root.AddComponent<RoomCamera>();
                var scene = SessionScene.Create(root.transform, room, eyes);
                var console = ContextConsole.Create(root.transform, eyes); console.Place(new Vector3(0, 0, 1));
                var strip = DialogueStrip.Create(root.transform, eyes);
                var app = root.AddComponent<BoopyApp>();
                var prior = View(false); console.Render(prior);
                Set(app, "head", eyes); Set(app, "room", room); Set(app, "scene", scene); Set(app, "console", console); Set(app, "dialogue", strip);
                Set(app, "status", StatusLine.Create(root.transform, eyes, Visuals.Quad()));
                Set(app, "session", prior);
                Require(console.SuggestedAction(ConsoleAction.FollowUpOne)?.Id == ActionId, "Production suggested action is unavailable.");
                var handler = new ReplyHandler { Outcome = outcome, OnPost = () =>
                {
                    Require((bool)Get(app, "busy")! && Get(app, "captureRequest") != null, "Follow-up did not own a cancellable wait.");
                    Require(!((Voice)Get(app, "voice")!).Recording, "Follow-up started microphone recording.");
                    Require(strip.Stage == DialogueStage.Working, "Follow-up did not acknowledge waiting.");
                    if (outcome == "cancelled") ((CancellationTokenSource)Get(app, "captureRequest")!).Cancel();
                    if (outcome == "focus-lost") Invoke(app, "OnFocusLost");
                }};
                using var client = new ServiceClient(handler: handler); Set(app, "client", client);
                ((Task)Invoke(app, "FollowUp", ConsoleAction.FollowUpOne)!).GetAwaiter().GetResult();
                Require(handler.Posts == 1, "Follow-up replayed or omitted its selection.");
                var body = handler.Body!;
                Require((string?)body["speech"]?["text"] == Question && body["speech"]?["wav"] == null && body["frame"] == null,
                    "Follow-up question changed or sent camera/microphone data.");
                Require((string?)body["selection"]?["utteranceId"] == "synthetic-first" &&
                    (string?)body["selection"]?["responseAt"] == ResponseAt && (string?)body["selection"]?["actionId"] == ActionId &&
                    (string?)body["cues"]?["targetItemId"] == "synthetic-target", "Follow-up lost exact original selection.");
                Require(Get(app, "pending") == null && Get(app, "unresolvedStartId") == null, "Follow-up created capture state.");
                Require(!(bool)Get(app, "busy")! && Get(app, "captureRequest") == null, "Follow-up wait lifecycle stayed busy.");
                Require(!((Voice)Get(app, "voice")!).Recording, "Follow-up started microphone.");
                if (outcome == "accepted")
                {
                    var returned = (SessionView)Get(app, "session")!;
                    Require(returned.Dialogue?.UtteranceId == "synthetic-next" && strip.FullText == returned.Dialogue.Text, "Accepted follow-up did not show exact new reply.");
                    Require(returned.Items[0].Status == "proposed" && returned.Items[0].Confidence == .4f &&
                        returned.Items[0].Grounding.ObservationId == "synthetic-original", "Question selection verified or moved original evidence.");
                }
                else
                {
                    Require(ReferenceEquals(Get(app, "session"), prior), "Stopped/failed follow-up applied stale late reply.");
                    Require(console.SuggestedAction(ConsoleAction.FollowUpOne) == null, "Uncertain follow-up reoffered its consumed suggestion.");
                    Require(!strip.FullText.Contains("Check capture") && !strip.FullText.Contains("Check the earlier capture"), "Follow-up offered unavailable capture recovery.");
                    Require(!(bool)Get(console, "captureRecovery")!, "Follow-up invented first-capture recovery.");
                    if (outcome == "focus-lost")
                    {
                        Invoke(app, "OnFocusAcquired");
                        Require(ReferenceEquals(Get(app, "session"), prior) && strip.FullText != "Synthetic new answer.", "Focus recovery applied cancelled reply.");
                    }
                    else Require(strip.Stage == DialogueStage.Error, "Failed follow-up concealed uncertainty.");
                }
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }

        private const string Question = "What does this word mean?";
        private const string ActionId = "synthetic-interpretation.followup-1";
        private const string ResponseAt = "1970-01-01T00:00:00Z";
        private static SessionView View(bool response)
        {
            var view = new SessionView { Id = "synthetic-session", State = "review", ReferentId = "synthetic-target", Model = new ModelRef { Provider = "fixture", Id = "synthetic-model" } };
            view.Items.Add(new Item { Id = "synthetic-target", Label = "한글", Statement = "Synthetic recorded word.", Status = "proposed", Confidence = .4f,
                Grounding = new Grounding { Kind = "box", ObservationId = "synthetic-original", Box = new Box2 { X0 = .1f, Y0 = .1f, X1 = .2f, Y1 = .2f } } });
            view.Observations.Add(new ObservationRef { Id = "synthetic-original" });
            view.Utterances.Add(new UtteranceRef { Id = "synthetic-first", Text = "What is this?", Kind = "ask" });
            if (response) view.Utterances.Add(new UtteranceRef { Id = "synthetic-next", Text = Question, Kind = "ask" });
            view.Dialogue = new DialogueView { UtteranceId = response ? "synthetic-next" : "synthetic-first", At = response ? "1970-01-01T00:00:01Z" : ResponseAt,
                Text = response ? "Synthetic new answer." : "Synthetic first answer." };
            if (!response) view.Dialogue.Actions.Add(new ContextualAction { Id = ActionId, Question = Question, TargetItemId = "synthetic-target", ObservationId = "synthetic-original" });
            return view;
        }
        private sealed class ReplyHandler : HttpMessageHandler
        {
            public int Posts; public JObject? Body; public string Outcome = "accepted"; public Action? OnPost;
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel)
            {
                if (request.Method == HttpMethod.Get) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}}") });
                Posts++; Body = Wire.Read<JObject>(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
                Require(request.RequestUri!.AbsolutePath == "/v1/sessions/synthetic-session/utterances", "Follow-up sent a different mutation.");
                OnPost?.Invoke();
                if (Outcome == "transport") throw new HttpRequestException("Synthetic drop");
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Outcome == "malformed" ? "not-json" : Wire.Write(View(true)), System.Text.Encoding.UTF8, "application/json") });
            }
        }
        private static object? Invoke(object target, string name, params object[] args) => target.GetType().GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(target, args);
        private static void Set(object target, string name, object? value) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(target, value);
        private static object? Get(object target, string name) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(target);
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
