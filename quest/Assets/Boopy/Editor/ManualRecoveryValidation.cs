#nullable enable
using System;
using System.Linq;
using System.IO;
using TMPro;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    public static class ManualRecoveryValidation
    {
        public static void Validate()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            HangulFont.Install();
            var root = new GameObject("Synthetic manual recovery UI");
            try
            {
                var eyes = new GameObject("Synthetic eyes").transform; eyes.SetParent(root.transform, false);
                var console = ContextConsole.Create(root.transform, eyes); console.Place(new Vector3(0, 0, 1));
                Require(!Visible(console, ConsoleAction.CheckCapture) && !Visible(console, ConsoleAction.DismissCapture), "Recovery appears by default.");
                const string uncertain = "Stopped waiting. The Mac may still finish this capture.";
                console.ShowError(uncertain); console.SetCaptureRecovery(true); console.RefreshVisuals(1f);
                Offered(console);
                Render(console, eyes);
                var header = console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Intent instrument");
                Require(header.BodyText == uncertain, "Recovery erased the uncertainty explanation.");
                foreach (var action in new[] { ConsoleAction.CheckCapture, ConsoleAction.DismissCapture })
                {
                    var button = console.GetComponentsInChildren<SpatialAction>(true).Single(item => item.Action == action);
                    var point = button.transform.position;
                    var ray = new Ray(eyes.position, point - eyes.position);
                    Require(console.HitAction(ray, out _) == action && console.CanRelease(action, ray), "Recovery control hit areas overlap or are missing.");
                    var collider = button.GetComponent<BoxCollider>();
                    Require(collider != null && Mathf.Abs(button.transform.localPosition.x) + collider.size.x / 2 <= SpatialTheme.Width / 2, "Recovery control exceeds dock bounds.");
                }
                console.ShowCheckingCapture(); console.RefreshVisuals(.1f);
                Require(header.BodyText == "Checking…", "Read-only check falsely describes visual capture.");
                Require(!Visible(console, ConsoleAction.CheckCapture) && !Visible(console, ConsoleAction.DismissCapture), "Processing exposes recovery actions.");
                console.ShowError(uncertain); console.SetBusy(true);
                Require(!Visible(console, ConsoleAction.CheckCapture), "Busy operation exposes recovery actions.");
                console.SetBusy(false); Offered(console);
                console.SetCaptureRecovery(false);
                Require(!Visible(console, ConsoleAction.CheckCapture) && Visible(console, ConsoleAction.Settings), "Ordinary no-session settings entry was not restored.");
                console.Render(new SessionView { Id = "synthetic-old", State = "committed", Committed = new Committed { PackageId = "synthetic-package" } });
                Require(Visible(console, ConsoleAction.Options), "Committed context has no deliberate options entry.");
                console.Activate(ConsoleAction.Options);
                Require(Visible(console, ConsoleAction.Handoff), "Ordinary committed receipt is missing.");
                console.ShowError(uncertain); console.SetCaptureRecovery(true); Offered(console);
                Require(!Visible(console, ConsoleAction.Handoff), "Old saved receipt competes with uncertain new capture.");
                console.SetCaptureRecovery(false);
                console.Render(new SessionView { Id = "synthetic-old", State = "committed", Committed = new Committed { PackageId = "synthetic-package" } });
                Require(Visible(console, ConsoleAction.Options) && !Visible(console, ConsoleAction.CheckCapture), "Ordinary saved UI was not restored.");
                console.Activate(ConsoleAction.Options);
                Require(Visible(console, ConsoleAction.Handoff), "Saved context lost its deliberate handoff.");
                var spoken = new SessionView { Id = "synthetic-spoken", State = "review", Attention = new AttentionView { UtteranceId = "synthetic-utterance", Action = "no-visual-work" } };
                spoken.Utterances.Add(new UtteranceRef { Id = "synthetic-utterance", Text = "Synthetic spoken context." });
                spoken.Items.Add(new Item { Id = "synthetic-words", Origin = "person", Status = "confirmed", Kind = "utterance", Confidence = null, Label = "Synthetic words", Statement = "Synthetic spoken context." });
                console.Render(spoken);
                Require(Visible(console, ConsoleAction.Options), "Authored context lacks deliberate actions.");
                console.Activate(ConsoleAction.Options);
                Require(console.Reviewing && Visible(console, ConsoleAction.PrepareSave), "Authored spoken-only context has no save preview.");
                Require(!console.GetComponentsInChildren<TextMeshPro>().Any(text => text.text.Contains("I couldn’t work that out")), "Authored-only review is falsely labeled a capture failure.");
                console.Activate(ConsoleAction.PrepareSave);
                Require(Visible(console, ConsoleAction.Save), "Authored-only save preview has no Save control.");
                spoken.Attention = null; console.Render(spoken);
                Require(Visible(console, ConsoleAction.Save), "A direct action clearing attention hid authored-context Save.");
                var authoredApp = root.AddComponent<BoopyApp>();
                var statusLine = StatusLine.Create(root.transform, eyes, Visuals.Quad());
                Set(authoredApp, "console", console); Set(authoredApp, "status", statusLine);
                typeof(BoopyApp).GetMethod("Apply", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(authoredApp, new object[] { spoken });
                Require(!statusLine.gameObject.activeSelf, "Accepted authored-only context displayed a false missing-interpretation hint.");
                foreach (var state in new[] { "pending", "failed", "interrupted", "succeeded", "mismatch", "missing" }) ValidateFlow(state, false);
                ValidateFlow("succeeded", true);
                ValidateFlow("pending", false, true);
                Debug.Log("Boopy manual recovery controls validation passed (synthetic; no wearer/device result).");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }

        private const string RequestId = "00000000-0000-4000-8000-000000000042";
        private static void ValidateFlow(string state, bool cancel, bool oldCommitted = false)
        {
            var recoveryDirectory = Path.Combine(Path.GetTempPath(), "boopy-manual-validation-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(recoveryDirectory);
            var root = new GameObject("Synthetic recovery flow");
            try
            {
                var eyes = new GameObject("Synthetic eyes").transform; eyes.SetParent(root.transform, false);
                var console = ContextConsole.Create(root.transform, eyes);
                var scene = SessionScene.Create(root.transform, root.AddComponent<RoomCamera>(), eyes);
                var app = root.AddComponent<BoopyApp>();
                Set(app, "recoveryStore", new CaptureRecoveryStore(Path.Combine(recoveryDirectory, "capture-id")));
                var handler = new ReceiptHandler { State = state };
                Set(app, "client", new ServiceClient(handler: handler)); Set(app, "console", console); Set(app, "scene", scene);
                SessionView? previous = oldCommitted ? new SessionView { Id = "synthetic-old", State = "committed", Committed = new Committed { PackageId = "synthetic-old-package" } } : null;
                if (previous != null) { Set(app, "session", previous); console.Render(previous); }
                Set(app, "unresolvedStartId", RequestId);
                var snapshot = new Snapshot(new byte[] { 1, 2 }, 1, 1, new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc), new Pose(Vector3.zero, Quaternion.identity), new DepthGrid(), new CameraInfo());
                Set(app, "unresolvedSnapshot", snapshot);
                console.ShowError("Synthetic uncertain start."); console.SetCaptureRecovery(true);
                if (cancel) handler.BeforeReply = () => ((CancellationTokenSource)Get(app, "captureRequest")!).Cancel();
                ((Task)typeof(BoopyApp).GetMethod("CheckCapture", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(app, null)!).GetAwaiter().GetResult();
                Require(handler.Gets == 1 && handler.Posts == 0, "Manual recovery repeated a mutation.");
                var snapshots = (Dictionary<string, Snapshot>)Get(scene, "snapshots")!;
                if (state == "succeeded" && !cancel)
                {
                    Require(Get(app, "unresolvedStartId") == null && Get(app, "unresolvedSnapshot") == null, "Verified success did not clear local recovery.");
                    Require(((SessionView?)Get(app, "session"))?.Id == "synthetic-session", "Verified receipt not applied.");
                    Require(snapshots.Count == 1 && ReferenceEquals(snapshots["synthetic-first"], snapshot) && !snapshots.ContainsKey("synthetic-later"), "Manual recovery misplaced original pixels.");
                    Require(!Visible(console, ConsoleAction.CheckCapture), "Success kept recovery controls.");
                }
                else
                {
                    Require((string?)Get(app, "unresolvedStartId") == RequestId && ReferenceEquals(Get(app, "unresolvedSnapshot"), snapshot), "Unfinished/cancelled/mismatched check lost original recovery identity.");
                    Require(ReferenceEquals(Get(app, "session"), previous) && snapshots.Count == 0, "Unverified or cancelled receipt applied state/pixels.");
                    Offered(console);
                    if (state == "pending" && !oldCommitted)
                    {
                        typeof(BoopyApp).GetMethod("BeginTalk", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(app, new object?[] { null });
                        Require((string?)Get(app, "unresolvedStartId") == RequestId && console.InputPolicy.Pending == null, "Pending capture entered microphone/camera path or lost identity.");
                        var review = new SessionView { Id = "synthetic-review", State = "review", Model = new ModelRef { Provider = "fixture", Id = "synthetic" } };
                        review.Items.Add(new Item { Id = "synthetic-note", Origin = "person", Status = "confirmed", Kind = "note", Label = "Synthetic", Statement = "Synthetic note." });
                        Require(ContextReview.CanSave(review), "Blocking test lacks an otherwise saveable context.");
                        Set(app, "session", review);
                        ((Task)typeof(BoopyApp).GetMethod("Act", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(app, new object?[] { "synthetic-note", null })!).GetAwaiter().GetResult();
                        ((Task)typeof(BoopyApp).GetMethod("Commit", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(app, null)!).GetAwaiter().GetResult();
                        Require(handler.Gets == 1 && handler.Posts == 0, "An unresolved capture allowed competing mutation.");
                    }
                    if (state == "missing") Require(console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Intent instrument").BodyText.Contains("no receipt"), "404 lacked distinct receipt explanation.");
                    typeof(BoopyApp).GetMethod("DismissCapture", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(app, null);
                    Require(Get(app, "unresolvedStartId") == null && Get(app, "unresolvedSnapshot") == null, "Start new failed to release local pending state.");
                    Require(!Visible(console, ConsoleAction.Handoff) && console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Intent instrument").BodyText.Contains("Connecting to your Mac"), "Start new restored a misleading old save receipt.");
                    Require(handler.Gets == 1 && handler.Posts == 0, "Dismissal contacted or mutated the Mac.");
                }
            }
            finally { UnityEngine.Object.DestroyImmediate(root); Directory.Delete(recoveryDirectory, true); }
        }
        private sealed class ReceiptHandler : HttpMessageHandler
        {
            public int Gets, Posts; public string State = "pending"; public Action? BeforeReply;
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
            {
                if (request.Method == HttpMethod.Post) Posts++; else Gets++;
                Require(request.Method == HttpMethod.Get && request.RequestUri!.AbsolutePath == "/v1/session-starts/" + RequestId, "Check used wrong route or method.");
                BeforeReply?.Invoke();
                if (State == "missing") return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound) { Content = new StringContent("{}") });
                var key = State == "mismatch" ? "00000000-0000-4000-8000-000000000043" : RequestId;
                var status = State == "mismatch" ? "succeeded" : State;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"requestId\":\"" + key + "\",\"sessionId\":\"synthetic-session\",\"status\":\"" + status + "\",\"view\":{\"id\":\"synthetic-session\",\"state\":\"review\",\"observations\":[{\"id\":\"synthetic-first\"},{\"id\":\"synthetic-later\"}]}}") });
            }
        }
        private static void Set(object target, string name, object? value) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(target, value);
        private static object? Get(object target, string name) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(target);

        private static void Render(ContextConsole console, Transform eyes)
        {
            var camera = eyes.gameObject.AddComponent<Camera>(); camera.fieldOfView = 58; camera.nearClipPlane = .05f;
            camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = new Color(.15f, .17f, .19f);
            camera.allowHDR = false; camera.allowMSAA = false;
            console.RefreshVisuals(1f);
            foreach (var text in console.GetComponentsInChildren<TextMeshPro>()) text.ForceMeshUpdate(true, true);
            var target = new RenderTexture(1000, 1000, 24); target.Create();
            var image = new Texture2D(1000, 1000, TextureFormat.RGB24, false); var prior = RenderTexture.active;
            try {
                camera.targetTexture = target; camera.Render(); RenderTexture.active = target;
                image.ReadPixels(new Rect(0, 0, 1000, 1000), 0, 0); image.Apply();
                File.WriteAllBytes(Path.Combine(Path.GetTempPath(), "boopy-manual-recovery.png"), image.EncodeToPNG());
            } finally { camera.targetTexture = null; RenderTexture.active = prior; UnityEngine.Object.DestroyImmediate(target); UnityEngine.Object.DestroyImmediate(image); }
        }
        private static bool Visible(ContextConsole console, ConsoleAction action) => console.GetComponentsInChildren<SpatialAction>(true).Single(item => item.Action == action).gameObject.activeInHierarchy;
        private static void Offered(ContextConsole console)
        {
            Require(Visible(console, ConsoleAction.CheckCapture) && Visible(console, ConsoleAction.DismissCapture), "Idle recovery choice missing.");
            foreach (var action in new[] { ConsoleAction.Save, ConsoleAction.PrepareSave, ConsoleAction.Review, ConsoleAction.Options })
                Require(!Visible(console, action), "Ordinary actions compete with recovery.");
        }
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
