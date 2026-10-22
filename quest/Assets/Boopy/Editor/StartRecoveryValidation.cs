#nullable enable
using System;
using System.IO;
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
    public static class StartRecoveryValidation
    {
        public static void Validate()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            HangulFont.Install();
            foreach (var spoken in new[] { false, true }) ValidateTurn(spoken);
            Debug.Log("Boopy keyed start recovery validation passed (synthetic; no wearer/device test).");
        }
        private static void ValidateTurn(bool spoken)
        {
            var recoveryDirectory = Path.Combine(Path.GetTempPath(), "boopy-start-validation-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(recoveryDirectory);
            var root = new GameObject("Synthetic keyed start recovery");
            try
            {
                var eyes = new GameObject("Synthetic eyes").transform; eyes.SetParent(root.transform, false);
                var room = root.AddComponent<RoomCamera>();
                var scene = SessionScene.Create(root.transform, room, eyes);
                var status = StatusLine.Create(root.transform, eyes, Visuals.Quad());
                var store = new CaptureRecoveryStore(Path.Combine(recoveryDirectory, "capture-id"));
                var handler = new LostStart { Store = store };
                var client = new ServiceClient(handler: handler);
                var app = root.AddComponent<BoopyApp>(); app.enabled = false;
                Set(app, "recoveryStore", store);
                Set(app, "client", client); Set(app, "scene", scene); Set(app, "status", status);
                var snapshot = new Snapshot(new byte[] { 1, 2, 3 }, 1, 1, new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc), new Pose(Vector3.zero, Quaternion.identity), new DepthGrid(), new CameraInfo());
                Set(app, "pending", spoken ? null : snapshot);
                Set(app, "pendingEvidence", new EvidenceTurn(spoken));
                Set(app, "pendingCues", new Cues());
                var operation = (Task)typeof(BoopyApp).GetMethod("Send", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(app, new object[] { new byte[] { 4, 5, 6 } })!;
                operation.GetAwaiter().GetResult();
                Require(handler.Posts == 1 && handler.ReceiptReads == 1, "Lost start repeated mutation or skipped receipt read.");
                Require(Guid.TryParseExact(handler.RequestId, "D", out _), "New start did not generate a UUID.");
                Require(handler.PicturePresent != spoken, "Spoken start leaked a frame or current-view start dropped it.");
                var remembered = (Dictionary<string, Snapshot>)typeof(SessionScene).GetField("snapshots", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(scene)!;
                if (spoken) Require(remembered.Count == 0, "Spoken start associated stale pixels.");
                else Require(remembered.Count == 1 && ReferenceEquals(remembered["synthetic-first"], snapshot) && !remembered.ContainsKey("synthetic-later"), "Recovered pixels were attached to a later turn.");
                var retained = (SessionView?)typeof(BoopyApp).GetField("session", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(app);
                Require(retained?.Id == "synthetic-session", "Inactive client did not retain recovered actual session.");
                Require(new CaptureRecoveryStore(Path.Combine(recoveryDirectory, "capture-id")).Load() == null, "Verified start did not clear persisted recovery.");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); Directory.Delete(recoveryDirectory, true); }
        }
        private sealed class LostStart : HttpMessageHandler
        {
            public int Posts, ReceiptReads;
            public CaptureRecoveryStore Store = null!;
            public string RequestId = "";
            public bool PicturePresent;
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel)
            {
                if (request.RequestUri!.AbsolutePath == "/v1/health") return Task.FromResult(Reply("{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}}"));
                if (request.Method == HttpMethod.Post)
                {
                    Posts++;
                    var body = JObject.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
                    RequestId = (string?)body["requestId"] ?? ""; PicturePresent = body.ContainsKey("frame");
                    Require(Store.Load() == RequestId, "Capture POST preceded durable recovery identity.");
                    throw new HttpRequestException("Synthetic lost response.");
                }
                ReceiptReads++;
                Require(request.RequestUri.AbsolutePath == "/v1/session-starts/" + RequestId, "Receipt used another key.");
                return Task.FromResult(Reply("{\"requestId\":\"" + RequestId + "\",\"sessionId\":\"synthetic-session\",\"status\":\"succeeded\",\"view\":{\"id\":\"synthetic-session\",\"state\":\"review\",\"observations\":[{\"id\":\"synthetic-first\"},{\"id\":\"synthetic-later\"}]}}"));
            }
            private static HttpResponseMessage Reply(string body) => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body) };
        }
        private static void Set(object target, string name, object? value) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(target, value);
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
