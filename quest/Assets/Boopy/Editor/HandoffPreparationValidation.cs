#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.IO;
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
    /// <summary>Actual released controls and app lifecycle, with synthetic transport only.</summary>
    public static class HandoffPreparationValidation
    {
        private const BindingFlags Flags = BindingFlags.Instance | BindingFlags.NonPublic;
        public static void ValidateAll()
        {
            Validate();
            HudRedesignValidation.ValidateAll();
            EvidenceInputValidation.Validate();
            ManualHandoffValidation.Validate();
            FirstTurnExperienceValidation.Validate();
            SpeechValidation.Validate();
        }
        public static void Validate()
        {
            ValidateJourney(false);
            ValidateJourney(true);
            Debug.Log("Boopy handoff preparation passed: explicit commit/package, native job receipt, stop/focus recovery; no consumer delivery.");
        }
        private static void ValidateJourney(bool disconnect)
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var root = new GameObject("Synthetic handoff control journey");
            var previous = SynchronizationContext.Current; SynchronizationContext.SetSynchronizationContext(null);
            var directory = Path.Combine(Path.GetTempPath(), "boopy-handoff-control-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory);
            try
            {
                var eyes = new GameObject("Synthetic eyes").transform; eyes.SetParent(root.transform, false);
                var console = ContextConsole.Create(root.transform, eyes); console.Place(Vector3.forward);
                var dialogue = DialogueStrip.Create(root.transform, eyes); console.DockDialogue(dialogue);
                var app = root.AddComponent<BoopyApp>();
                var transport = new ControlledTransport();
                using var client = new ServiceClient(handler: transport);
                Set(app, "head", eyes); Set(app, "console", console); Set(app, "dialogue", dialogue); Set(app, "client", client);
                Set(app, "handoffRecoveryStore", new HandoffRecoveryStore(Path.Combine(directory,"identity")));
                // Keep continuations on the invoking editor thread; network completions remain controlled.
                Set(app, "handoffPollMilliseconds", 0);
                var view = Review(); Call(app, "Apply", view);
                console.Activate(ConsoleAction.PrepareSave);
                Release(app, eyes, console, ConsoleAction.Save);
                Require(transport.Commits == 1 && transport.Pending.Count == 1, "Use this context did not commit then start preparation.");
                var selection = (HandoffRequest)Get(app, "handoffSelection")!;
                Require(selection.PackageId == "ctx_synthetic" && selection.Memory == null && selection.References == null,
                    "Handoff inferred older memory or reference selection.");
                Require(transport.PreparationBody != null && JObject.Parse(transport.PreparationBody).Count == 2,
                    "Preparation sent fields outside explicit package/request identity.");
                Require(GetState(app) == "preparing-local" && console.HandoffStatusWords.Contains("Preparing")
                    && !console.HandoffStatusWords.Contains("Prepared"), "Pending preparation appeared ready.");
                Require(console.GetComponentsInChildren<SpatialAction>().Any(control => control.Action == ConsoleAction.Cancel),
                    "Preparation has no visible Stop control.");
                if (!disconnect)
                {
                    transport.Complete(0, HttpStatusCode.Accepted, Pending(selection));
                    Require(transport.Pending.Count == 2 && GetState(app) == "preparing-local", "Pending job was not polled or was labelled ready.");
                    transport.Complete(1, HttpStatusCode.OK, Completed(selection));
                }
                else
                {
                    transport.Pending[0].SetException(new HttpRequestException("Synthetic USB loss"));
                    Require(GetState(app) == "interrupted" && !(bool)Get(app, "busy")!, "Lost connection did not retain a recoverable preparation.");
                    console.Activate(ConsoleAction.Options);
                    Release(app, eyes, console, ConsoleAction.Handoff);
                    Require(transport.Pending.Count == 2 && transport.Prepares == 1 && transport.Commits == 1,
                        "Explicit check duplicated commit/preparation rather than recovering the same request.");
                    transport.Complete(1, HttpStatusCode.OK, Pending(selection));
                    Require(transport.Pending.Count == 3, "Recovery did not resume pending-job polling.");
                    // Stop cancels only this wait; an intentionally cancellation-ignoring late result cannot update UI.
                    Release(app, eyes, console, ConsoleAction.Cancel);
                    transport.Complete(2, HttpStatusCode.OK, Completed(selection));
                    Require(GetState(app) == "interrupted" && Get(app, "handoffSelection") == selection,
                        "Stop accepted a late completion or discarded the recoverable request identity.");
                    console.Activate(ConsoleAction.Options); Release(app, eyes, console, ConsoleAction.Handoff);
                    Require(transport.Pending.Count == 4, "Stopped preparation could not be checked explicitly.");
                    Call(app, "OnFocusLost");
                    transport.Complete(3, HttpStatusCode.OK, Completed(selection));
                    Require(GetState(app) == "interrupted" && !dialogue.gameObject.activeSelf,
                        "Late response after focus loss changed preparation UI.");
                    Call(app, "OnFocusAcquired");
                    console.Activate(ConsoleAction.Options); Release(app, eyes, console, ConsoleAction.Handoff);
                    Require(transport.Pending.Count == 5, "Focus recovery did not retain the same preparation request.");
                    transport.Complete(4, HttpStatusCode.OK, Completed(selection));
                }
                Require(GetState(app) == "prepared-local" && !(bool)Get(app, "busy")!, "Verified receipt did not finish local preparation.");
                Require(console.HandoffStatusWords == "Prepared on your Mac. Not sent yet.", "Receipt implies consumer delivery.");
                Require(transport.Prepares == 1 && transport.Commits == 1 && Get(app, "handoffSelection") == selection,
                    "Recovery duplicated work or changed idempotency identity.");
                var words = (string)Call(console, "ManualHandoffWords")!;
                Require(!words.Contains("export") && words.Contains("Not sent") && words.Contains(selection.RequestId),
                    "Prepared receipt still asks for CLI export or claims delivery.");
                Require(view.Items[0].Status == "proposed" && Get(app, "pendingEvidence") == null,
                    "Preparation confirmed a model claim or created new capture.");
                if (!disconnect)
                {
                    console.Activate(ConsoleAction.Options); Release(app, eyes, console, ConsoleAction.Handoff);
                    Require(transport.Pending.Count == 3 && transport.Prepares == 1, "Opening prepared status did not check the existing receipt.");
                    var changed = Completed(selection); changed.SourceState = "changed";
                    transport.Complete(2, HttpStatusCode.OK, changed);
                    Require(GetState(app) == "changed" && console.HandoffStatusWords.Contains("Sources changed")
                        && transport.Prepares == 1 && Get(app, "handoffSelection") == selection,
                        "Changed sources appeared prepared or automatically created another packet.");
                    console.Activate(ConsoleAction.Options); Release(app, eyes, console, ConsoleAction.Handoff);
                    var replacement = (HandoffRequest)Get(app, "handoffSelection")!;
                    Require(replacement.RequestId != selection.RequestId && replacement.PackageId == selection.PackageId
                        && transport.Prepares == 2 && transport.Commits == 1 && transport.Pending.Count == 4,
                        "Explicit Prepare again did not create exactly one fresh request for the same immutable package.");
                    transport.Complete(3, HttpStatusCode.OK, Completed(replacement));
                    Require(GetState(app) == "prepared-local", "New explicit preparation failed to return its fresh receipt.");
                }
            }
            finally { SynchronizationContext.SetSynchronizationContext(previous); UnityEngine.Object.DestroyImmediate(root); Directory.Delete(directory,true); }
        }
        private static SessionView Review()
        {
            var view = new SessionView { Id = "ses_synthetic", State = "review", Model = new ModelRef { Provider = "fixture", Id = "synthetic" } };
            view.Items.Add(new Item { Id = "itm_synthetic", Kind = "object", Label = "Synthetic proposed source", Status = "proposed", Origin = "model" });
            return view;
        }
        private static HandoffStatus Pending(HandoffRequest selection) => new HandoffStatus {
            SessionId = "ses_synthetic", PackageId = selection.PackageId, RequestId = selection.RequestId,
            ReceiptId = "handoff_11111111-1111-4111-8111-111111111111", SelectionSha256 = new string('a', 64), Attempt = 1, State = "preparing-local",
        };
        internal static HandoffStatus Completed(HandoffRequest selection, string sessionId = "ses_synthetic")
        {
            var result = Pending(selection); result.SessionId = sessionId; result.State = "prepared-local"; result.SourceState = "unchanged";
            result.Receipt = new HandoffReceipt { ReceiptId = result.ReceiptId, RequestId = result.RequestId, PackageId = result.PackageId,
                State = "prepared-local", SelectionSha256 = result.SelectionSha256, BaselineSha256 = result.SelectionSha256,
                PacketSha256 = result.SelectionSha256, SourceSnapshotSha256 = result.SelectionSha256,
                PreparedAt = "1970-01-01T12:00:00.000Z", HistoricalSnapshot = true, Delivery = "not-sent",
                SelectedPackageIds = new List<string> { selection.PackageId }, SelectedSourceIds = new List<string> { selection.PackageId + ":itm_synthetic" },
                Memory = new HandoffMemoryResult { Status = "disabled", ReturnedSources = 0 },
                References = new HandoffReferenceResult { Status = "disabled", ReturnedAssociations = 0 },
            }; return result;
        }
        private sealed class ControlledTransport : HttpMessageHandler
        {
            public int Commits, Prepares;
            public string? PreparationBody;
            public readonly List<TaskCompletionSource<HttpResponseMessage>> Pending = new List<TaskCompletionSource<HttpResponseMessage>>();
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel)
            {
                var path = request.RequestUri!.AbsolutePath;
                if (path == "/v1/health") return Task.FromResult(Reply(HttpStatusCode.OK,
                    "{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"},\"handoffPreparationAvailable\":true}"));
                if (path.EndsWith("/commit", StringComparison.Ordinal))
                {
                    Commits++; var view = Review(); view.State = "committed";
                    view.Committed = new Committed { PackageId = "ctx_synthetic", At = "1970-01-01T12:00:00.000Z" };
                    return Task.FromResult(Reply(HttpStatusCode.OK, Wire.Write(view)));
                }
                Require(path.Contains("/handoff-preparations"), "Preparation touched an unrelated endpoint.");
                if (request.Method == HttpMethod.Post) { Prepares++; PreparationBody = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult(); }
                var pending = new TaskCompletionSource<HttpResponseMessage>(); Pending.Add(pending); return pending.Task;
            }
            public void Complete(int index, HttpStatusCode status, HandoffStatus body) => Pending[index].SetResult(Reply(status, Wire.Write(body)));
            private static HttpResponseMessage Reply(HttpStatusCode status, string body) => new HttpResponseMessage(status) { Content = new StringContent(body) };
        }
        private static void Release(BoopyApp app, Transform eyes, ContextConsole console, ConsoleAction action)
        {
            console.RefreshVisuals(1f); Physics.SyncTransforms();
            var control = console.GetComponentsInChildren<SpatialAction>().Single(value => value.Action == action);
            eyes.rotation = Quaternion.LookRotation(control.transform.position - eyes.position, Vector3.up);
            Set(app, "pendingControl", action); Set(app, "pendingUsesHandRay", false);
            Require((bool)Call(app, "ReleaseControl", new HandInput(true, null, null))!, "Control release did not activate.");
        }
        private static string GetState(BoopyApp app) => (string)Get(app, "handoffState")!;
        private static object? Call(object target, string name, params object[] args) => target.GetType().GetMethod(name, Flags)!.Invoke(target, args);
        private static object? Get(object target, string name) => target.GetType().GetField(name, Flags)!.GetValue(target);
        private static void Set(object target, string name, object? value) => target.GetType().GetField(name, Flags)!.SetValue(target, value);
        private static void Require(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
    }
}
