#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
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
    public static class TargetedQuestionValidation
    {
        public static void Validate()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            HangulFont.Install();
            foreach (var cancelled in new[] { false, true }) ValidateTurn(cancelled);
            ValidateTurn(false, "transport");
            ValidateTurn(false, "malformed");
            Debug.Log("Boopy targeted context validation passed (synthetic response; no microphone/camera/consumer outcome).");
        }
        private static void ValidateTurn(bool cancelled, string? failure = null)
        {
            var root = new GameObject("Synthetic targeted question");
            try
            {
                var eyes = new GameObject("Synthetic eyes").transform; eyes.SetParent(root.transform, false);
                var room = root.AddComponent<RoomCamera>(); var scene = SessionScene.Create(root.transform, room, eyes);
                var console = ContextConsole.Create(root.transform, eyes); console.Place(new Vector3(0, 0, 1));
                var strip = DialogueStrip.Create(root.transform, eyes);
                var app = root.AddComponent<BoopyApp>();
                var prior = View(false); console.Render(prior); console.Activate(ConsoleAction.Review);
                var original = SnapshotAt(0); var current = SnapshotAt(2); scene.Remember("synthetic-original", original);
                Set(app, "head", eyes); Set(app, "room", room); Set(app, "scene", scene); Set(app, "console", console); Set(app, "dialogue", strip);
                Set(app, "status", StatusLine.Create(root.transform, eyes, Visuals.Quad()));
                Set(app, "session", prior); Set(app, "pending", current); Set(app, "pendingTarget", "synthetic-target");
                Set(app, "pendingCues", new Cues { TargetItemId = "synthetic-target" });
                Set(app, "pendingEvidence", new EvidenceTurn(false));
                var handler = new ReplyHandler { Result = View(true), Failure = failure, OnPost = () =>
                {
                    var header = console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Intent instrument");
                    Require(header.BodyText == "Sending…", "Targeted turn falsely promises a specific perception stage.");
                    Require(strip.Stage == DialogueStage.Working && ThinkingPhrases.All.Contains(strip.FullText) && strip.SpeakerText == "",
                        "Targeted processing caption is not one of Boopy's thinking phrases, or it names a speaker.");
                    console.InputPolicy.End(); console.RefreshVisuals(.1f);
                    Require(header.BodyText == "Sending…", "Busy refresh changed the waiting label.");
                    if (cancelled) ((CancellationTokenSource)Get(app, "captureRequest")!).Cancel();
                } };
                Set(app, "client", new ServiceClient(handler: handler));
                ((Task)typeof(BoopyApp).GetMethod("Send", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(app, new object[] { new byte[] { 3, 4, 5 } })!).GetAwaiter().GetResult();
                Require(handler.Posts == 1 && handler.Target == "synthetic-target" && handler.FramePresent, "Target/image dispatch changed or repeated mutation.");
                var snapshots = (Dictionary<string, Snapshot>)Get(scene, "snapshots")!;
                Require(ReferenceEquals(snapshots["synthetic-original"], original), "New capture replaced the selected source's cached pixels.");
                if (failure != null)
                {
                    Require(ReferenceEquals(Get(app, "session"), prior), "Failed continuation applied a fabricated response.");
                    Require(!snapshots.ContainsKey("synthetic-new"), "Failed continuation associated unreturned pixels.");
                    Require(strip.Stage == DialogueStage.Error && (strip.FullText.Contains("Processing may continue") || strip.FullText.Contains("Mac may still finish this turn")), "Failed continuation concealed uncertain server work.");
                    Require(!strip.FullText.Contains("Check the earlier capture") && !strip.FullText.Contains("Check capture"), "Continuation failure instructed unavailable first-capture recovery.");
                    Require(Get(app, "unresolvedStartId") == null && !(bool)Get(console, "captureRecovery")!, "Continuation invented a pending first capture.");
                    var controls = (Dictionary<ConsoleAction, SpatialAction>)Get(console, "actions")!;
                    Require(!controls[ConsoleAction.CheckCapture].gameObject.activeInHierarchy && !controls[ConsoleAction.DismissCapture].gameObject.activeInHierarchy, "Continuation exposed first-capture recovery controls.");
                }
                else if (cancelled)
                {
                    Require(ReferenceEquals(Get(app, "session"), prior), "Cancelled late response applied proposal.");
                    Require(!snapshots.ContainsKey("synthetic-new"), "Cancelled late response associated new pixels.");
                    Require(strip.Stage == DialogueStage.Error && strip.FullText.Contains("Mac may still finish"), "Cancellation was mislabeled completion.");
                }
                else
                {
                    var returned = (SessionView)Get(app, "session")!;
                    Require(returned.Items[0].Grounding.ObservationId == "synthetic-original" && console.SelectedItemId == "synthetic-target", "Returned selected-source reader lost original association.");
                    Require(ReferenceEquals(snapshots["synthetic-new"], current), "Fresh view was associated with another source.");
                    Require(returned.Items[0].Note == PersonalWords && ContextReview.Evidence(returned.Items[0]).Contains(PersonalWords), "Exact personal words were paraphrased or lost in reader.");
                    Require(ContextReview.Evidence(returned.Items[0]).Contains("한글"), "Original OCR text disappeared from reader.");
                    Require(returned.Items[0].Status == "proposed" && returned.Items[0].Confidence == .4f, "Question response confirmed or changed existing model certainty.");
                    Require(strip.FullText == returned.Dialogue!.Text && strip.SpeakerText.StartsWith("Boopy") && strip.Stage == DialogueStage.Response && !strip.FullText.StartsWith("Suggested answer:"), "Actual proposed response was not attributed/displayed correctly.");
                }
                Require(!((Voice)Get(app, "voice")!).Recording, "Synthetic dispatch started microphone.");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }
        private const string PersonalWords = "I felt Much Colder. 그 여행은 추웠어요.";
        private static SessionView View(bool response)
        {
            var view = new SessionView { Id = "synthetic-session", ReferentId = "synthetic-target", State = "review", Model = new ModelRef { Provider = "fixture", Id = "synthetic-proposal" } };
            view.Items.Add(new Item { Id = "synthetic-target", Kind = "text", Label = "Synthetic label", Statement = "Synthetic source interpretation.", Text = new List<string> { "한글" }, Note = PersonalWords, Status = "proposed", Confidence = .4f, Grounding = new Grounding { Kind = "box", ObservationId = "synthetic-original", Box = new Box2 { X0 = .1f, Y0 = .1f, X1 = .2f, Y1 = .2f } } });
            view.Observations.Add(new ObservationRef { Id = "synthetic-original" });
            if (response) { view.Observations.Add(new ObservationRef { Id = "synthetic-new" }); view.Utterances.Add(new UtteranceRef { Id = "synthetic-question", Text = "What does the recorded text mean?" }); view.Dialogue = new DialogueView { Speaker = "boopy", UtteranceId = "synthetic-question", At = "1970-01-01T00:00:00Z", Text = "Synthetic source interpretation." }; }
            return view;
        }
        private static Snapshot SnapshotAt(float x) => new Snapshot(new byte[] { 1, 2 }, 80, 80, new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc), new Pose(new Vector3(x, 0, 0), Quaternion.identity), new DepthGrid { Columns = 1, Rows = 1, Meters = new float?[] { null } }, new CameraInfo { FocalLength = new float[] { 40, 40 }, PrincipalPoint = new float[] { 40, 40 }, SensorResolution = new int[] { 80, 80 } });
        private sealed class ReplyHandler : HttpMessageHandler
        {
            public int Posts; public string? Target; public bool FramePresent; public SessionView Result = new SessionView(); public Action? OnPost; public string? Failure;
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
            {
                if (request.Method == HttpMethod.Get) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}}") });
                Posts++; var body = JObject.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult()); Target = (string?)body["cues"]?["targetItemId"]; FramePresent = body.ContainsKey("frame");
                OnPost?.Invoke();
                if (Failure == "transport") throw new HttpRequestException("Synthetic connection failure");
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Failure == "malformed" ? "not-json" : Wire.Write(Result), System.Text.Encoding.UTF8, "application/json") });
            }
        }
        private static void Set(object target, string name, object? value) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(target, value);
        private static object? Get(object target, string name) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(target);
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
