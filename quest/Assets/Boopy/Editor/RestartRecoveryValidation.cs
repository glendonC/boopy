#nullable enable
using System;
using System.Collections;
using System.IO;
using System.Linq;
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
    public static class RestartRecoveryValidation
    {
        private const string Identity = "00000000-0000-4000-8000-000000000042";
        public static void Validate()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            ScriptCoverage.Install();
            foreach (var outcome in new[] { "pending", "succeeded", "dismiss", "corrupt", "clear-failed", "save-failed", "null-store" }) ValidateCase(outcome);
            Debug.Log("Boopy restart recovery validation passed (synthetic private UUID; no replay, pixels, microphone or device result).");
        }
        private static void ValidateCase(string outcome)
        {
            var directory = Path.Combine(Path.GetTempPath(), "boopy-restart-validation-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            var path = Path.Combine(directory, "capture-id");
            var root = new GameObject("Synthetic restart recovery");
            try
            {
                var store = new CaptureRecoveryStore(path);
                if (outcome == "corrupt") File.WriteAllText(path, "synthetic malformed record");
                else if (outcome == "save-failed") Directory.CreateDirectory(path);
                else store.Save(Identity);
                var eyes = new GameObject("Synthetic eyes").transform; eyes.SetParent(root.transform, false);
                var console = ContextConsole.Create(root.transform, eyes);
                var scene = SessionScene.Create(root.transform, root.AddComponent<RoomCamera>(), eyes);
                var app = root.AddComponent<BoopyApp>();
                var handler = new ReceiptHandler { State = outcome == "succeeded" ? "succeeded" : "pending" };
                Set(app, "recoveryStore", outcome == "null-store" ? null : store); Set(app, "console", console); Set(app, "scene", scene);
                Set(app, "client", new ServiceClient(handler: handler));
                if (outcome == "save-failed" || outcome == "null-store")
                {
                    Set(app, "status", StatusLine.Create(root.transform, eyes, Visuals.Quad()));
                    Set(app, "pendingEvidence", new EvidenceTurn(true));
                    ((Task)Invoke(app, "Send", new byte[] { 1, 2, 3 })!).GetAwaiter().GetResult();
                    Require((bool)Get(app, "recoveryStorageFailed")! && handler.Requests == 0, "Disk failure was silent or contacted Mac.");
                    Offered(console); return;
                }
                Invoke(app, "RestoreCaptureRecovery");
                Require(handler.Requests == 0 && Get(app, "session") == null && Get(app, "unresolvedSnapshot") == null, "Restore replayed request, applied context or invented pixels.");
                Require(!((Voice)Get(app, "voice")!).Recording, "Restore started microphone.");
                Offered(console);
                // Only what the headset knows: it restarted and heard nothing back. Whether the Mac finished is Check capture's to find.
                if (outcome != "corrupt")
                    Require(Header(console) == "Boopy restarted before it heard back from your Mac. The picture is gone from the headset.",
                        "The restart notice says more than the headset knows: " + Header(console));
                if (outcome == "corrupt")
                {
                    Require((bool)Get(app, "recoveryStorageFailed")!, "Corrupt recovery was treated as empty.");
                    Require(Header(console).Contains("recover", StringComparison.OrdinalIgnoreCase) || Header(console).Contains("storage", StringComparison.OrdinalIgnoreCase), "Corrupt storage has no visible explanation.");
                    Invoke(app, "DismissCapture"); Require(!File.Exists(path) && handler.Requests == 0, "Corrupt dismissal failed or contacted Mac."); return;
                }
                Require((string?)Get(app, "unresolvedStartId") == Identity, "Restart lost exact capture identity.");
                if (outcome == "clear-failed") { File.Delete(path); Directory.CreateDirectory(path); }
                if (outcome == "dismiss" || outcome == "clear-failed")
                {
                    Invoke(app, "DismissCapture");
                    Require(handler.Requests == 0, "Dismiss replayed/mutated capture.");
                    if (outcome == "clear-failed") { Require((string?)Get(app, "unresolvedStartId") == Identity && (bool)Get(app, "recoveryStorageFailed")!, "Failed clear falsely dismissed recovery."); Offered(console); }
                    else Require(store.Load() == null && Get(app, "unresolvedStartId") == null, "Explicit dismissal did not clear disk and memory.");
                    return;
                }
                ((Task)Invoke(app, "CheckCapture")!).GetAwaiter().GetResult();
                Require(handler.Requests == 1 && handler.Posts == 0, "Restart check repeated mutation or requested more than once.");
                if (outcome == "pending") { Require(new CaptureRecoveryStore(path).Load() == Identity && Get(app, "session") == null, "Pending receipt lost persisted identity or applied state."); Offered(console); }
                else
                {
                    Require(new CaptureRecoveryStore(path).Load() == null && Get(app, "unresolvedStartId") == null, "Verified success retained recovery record.");
                    var view = (SessionView)Get(app, "session")!;
                    Require(view.Id == "synthetic-recovered" && console.SelectedItemId == "synthetic-item", "Verified context not available in reader.");
                    Require(((IDictionary)Get(scene, "snapshots")!).Count == 0 && ((IDictionary)Get(scene, "overlays")!).Count == 0 && ((IDictionary)Get(scene, "chips")!).Count == 0, "Restart fabricated old world grounding.");
                    Require(!((Voice)Get(app, "voice")!).Recording, "Receipt replayed voice.");
                }
            }
            finally { UnityEngine.Object.DestroyImmediate(root); Directory.Delete(directory, true); }
        }
        private sealed class ReceiptHandler : HttpMessageHandler
        {
            public int Requests, Posts; public string State = "pending";
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
            {
                Requests++; if (request.Method == HttpMethod.Post) Posts++;
                Require(request.Method == HttpMethod.Get && request.RequestUri!.AbsolutePath == "/v1/session-starts/" + Identity, "Recovery used another route or mutation.");
                var view = new SessionView { Id = "synthetic-recovered", State = "review", ReferentId = "synthetic-item" };
                view.Observations.Add(new ObservationRef { Id = "synthetic-original" });
                view.Items.Add(new Item { Id = "synthetic-item", Label = "Synthetic source", Status = "proposed", Confidence = .3f, Grounding = new Grounding { Kind = "box", ObservationId = "synthetic-original", Box = new Box2 { X0 = .1f, Y0 = .1f, X1 = .4f, Y1 = .4f } } });
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Wire.Write(new StartRecoveryView { RequestId = Identity, SessionId = view.Id, Status = State, View = State == "succeeded" ? view : null })) });
            }
        }
        private static void Offered(ContextConsole console) { foreach (var action in new[] { ConsoleAction.CheckCapture, ConsoleAction.DismissCapture }) Require(console.GetComponentsInChildren<SpatialAction>(true).Any(surface => surface.gameObject.activeSelf && surface.Action == action), "Recovery choice missing."); }
        private static string Header(ContextConsole console) => console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Intent instrument").BodyText;
        private static void Set(object target, string name, object? value) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(target, value);
        private static object? Get(object target, string name) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(target);
        private static object? Invoke(object target, string name, params object?[] args) => target.GetType().GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(target, args);
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
