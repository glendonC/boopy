#nullable enable
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using TMPro;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    public static class HandoffRecoveryValidation
    {
        private const BindingFlags Flags = BindingFlags.Instance | BindingFlags.NonPublic;
        private const string Identity = "11111111-1111-4111-8111-111111111111";
        public static void Validate()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var previous = SynchronizationContext.Current; SynchronizationContext.SetSynchronizationContext(null);
            var directory = Path.Combine(Path.GetTempPath(), "boopy-recovery-controls-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory);
            try
            {
                PrecommitRestart(Path.Combine(directory, "precommit"));
                UncommittedRestart(Path.Combine(directory, "uncommitted"));
                foreach (var state in new[] { "preparing-local", "prepared-local", "failed" }) RestartedPreparation(Path.Combine(directory, state), state);
                StorageFailure(Path.Combine(directory, "corrupt"), true);
                StorageFailure(Path.Combine(directory, "write-failure"), false);
                LatestInterpretationFailure(Path.Combine(directory, "failure-caption"));
                CancelledRetry(Path.Combine(directory, "cancelled-retry"));
                CancelledRecovery(Path.Combine(directory, "cancelled-session"), true, false);
                CancelledRecovery(Path.Combine(directory, "cancelled-status"), false, false);
                CancelledRecovery(Path.Combine(directory, "timed-out-session"), true, true);
                CancelledRecovery(Path.Combine(directory, "timed-out-status"), false, true);
                FailedRecovery(Path.Combine(directory, "failed-session"), true, false);
                FailedRecovery(Path.Combine(directory, "failed-status"), false, false);
                FailedRecovery(Path.Combine(directory, "failed-recovery-storage"), true, true);
                MissingRetryFailsOnce(Path.Combine(directory, "missing-retry"));
                RecoveryLayouts(Path.Combine(directory, "render"));
                Debug.Log("Boopy durable preparation recovery passed: object recreation, GET-only check, exact IDs, local dismissal, no old poses, latest typed failure.");
            }
            finally { SynchronizationContext.SetSynchronizationContext(previous); Directory.Delete(directory, true); }
        }
        public static void ValidateAll()
        {
            Validate();
            HandoffPreparationValidation.ValidateAll();
        }
        /// <summary>Current wearer-feedback checks plus clearly synthetic character/control previews.</summary>
        public static void ValidateExperienceAndRender()
        {
            ValidateAll();
            ControlBarValidation.Render();
            LiveSceneHudValidation.RenderPreview();
            CompanionPreview.Render();
            CaptureScanValidation.ValidateAndRender();
        }
        private static HandoffRecoveryRecord Anchor(string? packageId = "ctx_recovery") => new HandoffRecoveryRecord {
            SessionId = "ses_recovery", PackageId = packageId, RequestId = Identity,
        };
        private static void PrecommitRestart(string path)
        {
            string requestId;
            using (var first = new Fixture(path))
            {
                first.Handler.HoldCommit = true; Call(first.App, "Apply", View(false));
                first.Console.Activate(ConsoleAction.PrepareSave); Release(first, ConsoleAction.Save);
                var record = first.Store.Load(); Require(record != null && record.PackageId == null && first.Handler.Commits == 1,
                    "Commit was sent without an ID-only durable precommit anchor.");
                requestId = record!.RequestId;
                Call(first.App, "OnFocusLost"); first.Handler.CommitReply.SetResult(Reply(HttpStatusCode.OK, View(true)));
                Require(first.Store.Load()?.PackageId == null && first.Handler.Prepares == 0, "Lost commit response invented a package or sent preparation.");
            }
            using (var second = new Fixture(path))
            {
                Call(second.App, "RestoreHandoffRecovery"); Require(second.Handler.Paths.Count == 0, "Startup automatically read or sent context.");
                OpenRecovery(second);
                Require(second.Handler.SessionReads == 1 && second.Handler.Status.Count == 1 && second.Handler.Prepares == 0 && second.Handler.Commits == 0,
                    "Restart check did not GET the exact session and preparation only.");
                Require(second.Handler.Methods.All(method=>method==HttpMethod.Get),"Restart recovery issued a non-GET request.");
                second.Handler.Complete(0, HttpStatusCode.NotFound, new { });
                Require(State(second) == "missing" && second.Store.Load()?.RequestId == requestId
                    && second.Store.Load()?.PackageId == "ctx_recovery" && second.Handler.Prepares == 0,
                    "Missing preparation automatically POSTed or lost the precommit request.");
                second.Console.Activate(ConsoleAction.Options); Release(second, ConsoleAction.Handoff);
                Require(second.Handler.Prepares == 1 && second.Handler.LastSelection?.RequestId == requestId && second.Handler.Commits == 0,
                    "Separate explicit Prepare did not reuse its durable request identity.");
                second.Handler.Complete(1, HttpStatusCode.OK, Complete(second.Handler.LastSelection!));
                Require(State(second) == "prepared-local", "Recovered precommit selection could not deliberately prepare.");
            }
        }
        private static void RestartedPreparation(string path, string state)
        {
            new HandoffRecoveryStore(path).Save(Anchor());
            using (var first = new Fixture(path))
            {
                // An unrelated current room annotation must not survive explicit restoration of older context.
                var current = View(false); current.Id = "ses_current"; current.Items[0].Grounding.ObservationId = "current-observation";
                first.Scene.Remember("current-observation", new Snapshot(new byte[] {255,216,255,217}, 128,96,
                    DateTime.UtcNow, new Pose(Vector3.zero, Quaternion.identity), new DepthGrid {Columns=1,Rows=1,Meters=new float?[] {1}},
                    new CameraInfo {FocalLength=new[] {100f,100f},PrincipalPoint=new[] {64f,48f},SensorResolution=new[] {128,96}}));
                Call(first.App, "Apply", current); Require(((IDictionary)Get(first.Scene, "snapshots")!).Count == 1, "Stale-pose fixture is not grounded.");
                Call(first.App, "RestoreHandoffRecovery"); Require(first.Handler.Paths.Count == 0, "Loading IDs contacted the Mac.");
                OpenRecovery(first);
                Require(((IDictionary)Get(first.Scene, "snapshots")!).Count == 0 && (string?)Get(first.Scene, "renderedSessionId") == "ses_recovery",
                    "Recovery retained the unrelated current room scene or old source poses.");
                var selected = new HandoffRequest {RequestId=Identity,PackageId="ctx_recovery"};
                if (state == "preparing-local")
                {
                    first.Handler.Complete(0, HttpStatusCode.OK, Pending(selected));
                    Require(first.Handler.Status.Count == 2 && first.Handler.Prepares == 0, "Pending recovery did not poll read-only.");
                    // Explicit stop followed by a new current conversation cannot receive a late old completion.
                    Release(first, ConsoleAction.Cancel);
                    Call(first.App, "OnFocusLost");
                    first.Handler.Complete(1, HttpStatusCode.OK, Complete(selected));
                    Require(State(first) == "interrupted" && !first.Dialogue.gameObject.activeSelf && first.Store.Load()?.RequestId == Identity,
                        "Stopped/lost-focus recovery accepted a late reply or erased its durable anchor.");
                }
                else
                {
                    var status = Complete(selected);
                    if (state == "failed") { status.State="failed"; status.SourceState=null; status.Receipt=null; status.Reason="interrupted"; }
                    first.Handler.Complete(0,HttpStatusCode.OK,status);
                    Require(State(first) == state && first.Handler.Prepares == 0 && first.Handler.Commits == 0,
                        "Read-only recovery retried a failure or misrepresented completion.");
                    Require(first.Store.Load()?.RequestId == Identity, "Recovery discarded a completed/failed anchor.");
                    if(state=="prepared-local")
                    {
                        Release(first,ConsoleAction.Back);
                        Require(ReferenceEquals(Get(first.App,"session"),current) && ((IDictionary)Get(first.Scene,"snapshots")!).Count==0,
                            "Back lost the current conversation or restamped its old room pose.");
                        OpenRecovery(first);first.Handler.Complete(1,HttpStatusCode.OK,Complete(selected));
                        var newer=View(false);newer.Id="ses_newer_explicit_talk";Call(first.App,"Apply",newer);
                        Require((bool)Get(first.App,"handoffRecoveryOffered")! && first.Store.Load()?.RequestId==Identity,
                            "New Talk hid or replaced the earlier completed preparation anchor.");
                        OpenRecovery(first);first.Handler.Complete(2,HttpStatusCode.OK,Complete(selected));Release(first,ConsoleAction.Back);
                        Require(ReferenceEquals(Get(first.App,"session"),newer),"Earlier preparation returned to an obsolete conversation instead of the newer Talk.");
                    }
                }
            }
            using (var recreated = new Fixture(path))
            {
                Call(recreated.App, "RestoreHandoffRecovery"); OpenRecovery(recreated);
                recreated.Handler.Complete(0,HttpStatusCode.OK,Complete(new HandoffRequest {RequestId=Identity,PackageId="ctx_recovery"}));
                Require(State(recreated) == "prepared-local" && recreated.Handler.Prepares == 0, "Completed anchor did not survive object recreation.");
                Require(recreated.Handler.Methods.All(method=>method==HttpMethod.Get),"Completed recovery issued a non-GET request.");
                // A Check on an existing receipt must not POST when a later read returns failed.
                recreated.Console.Activate(ConsoleAction.Options); Release(recreated,ConsoleAction.Handoff);
                var failed=Pending(new HandoffRequest {RequestId=Identity,PackageId="ctx_recovery"});failed.State="failed";failed.Reason="interrupted";
                recreated.Handler.Complete(1,HttpStatusCode.OK,failed);
                Require(State(recreated)=="failed" && recreated.Handler.Prepares==0,"Check preparation silently retried a failed status.");
                recreated.Console.Activate(ConsoleAction.Options); Release(recreated,ConsoleAction.Handoff);
                recreated.Handler.Complete(2,HttpStatusCode.OK,failed);
                Require(recreated.Handler.Prepares==1,"Separate Retry action did not authorize one POST.");
                recreated.Handler.Complete(3,HttpStatusCode.OK,Complete(recreated.Handler.LastSelection!));
                recreated.Console.Activate(ConsoleAction.Options); Release(recreated,ConsoleAction.Handoff);
                recreated.Handler.Complete(4,HttpStatusCode.OK,Complete(recreated.Handler.LastSelection!));
                Release(recreated,ConsoleAction.DismissCapture);
                Require(recreated.Store.Load()==null && recreated.Dialogue.FullText.Contains("Context stays on your Mac"),
                    "Dismiss failed to clear only the local recovery record.");
            }
        }
        private static void UncommittedRestart(string path)
        {
            new HandoffRecoveryStore(path).Save(Anchor(null));
            using var fixture=new Fixture(path);fixture.Handler.SessionCommitted=false;
            Call(fixture.App,"RestoreHandoffRecovery");OpenRecovery(fixture);
            Require(fixture.Handler.SessionReads==1 && fixture.Handler.Status.Count==0 && fixture.Handler.Commits==0 && fixture.Handler.Prepares==0,
                "Uncommitted recovery automatically committed or requested a guessed package.");
            Require(((SessionView)Get(fixture.App,"session")!).State=="review" && fixture.Store.Load()?.RequestId==Identity,
                "Uncommitted exact session or precommit ID was lost.");
        }
        private static void StorageFailure(string path, bool corrupt)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            if(corrupt)File.WriteAllText(path,"{synthetic-corrupt");else Directory.CreateDirectory(path);
            using var fixture=new Fixture(path);
            if(corrupt)Call(fixture.App,"RestoreHandoffRecovery");
            Call(fixture.App,"Apply",View(false));
            var work=(Task)Call(fixture.App,"Commit")!;work.GetAwaiter().GetResult();
            Require(fixture.Handler.Commits==0 && fixture.Handler.Prepares==0 && !(bool)Get(fixture.App,"busy")!,
                "Unavailable recovery storage allowed a mutation or locked ordinary input.");
            Require(fixture.Dialogue.FullText.Contains("No new preparation was sent"),"Storage failure lacks honest mutation status.");
            if(!corrupt)Directory.Delete(path);
            fixture.Console.Activate(ConsoleAction.Options);Release(fixture,ConsoleAction.Handoff);Release(fixture,ConsoleAction.DismissCapture);
            Require(!(bool)Get(fixture.App,"handoffStorageFailed")! && fixture.Handler.Commits==0,"Explicit local dismissal failed or mutated Mac context.");
        }
        private static void LatestInterpretationFailure(string path)
        {
            using var fixture=new Fixture(path);var view=View(false);
            view.Utterances.Add(new UtteranceRef {Id="latest-synthetic",Text="Synthetic question",Kind="ask"});
            var words="I can’t reach the model on your Mac. Try again once it’s running.";
            view.InterpretationFailure=new InterpretationFailure {Code="interpreter_unavailable",UtteranceId="latest-synthetic",Message=words};
            Call(fixture.App,"Apply",view);
            Require(fixture.Dialogue.Stage==DialogueStage.Error && fixture.Dialogue.FullText==words && (string?)Get(fixture.Console,"mode")=="error",
                "Latest actual model failure did not produce exact Error caption/pose.");
            view.InterpretationFailure.Code="interpreter_failed";view.InterpretationFailure.Message="The model could not interpret this synthetic turn.";
            Call(fixture.App,"Apply",view);
            Require(fixture.Dialogue.Stage==DialogueStage.Error && fixture.Console.GetComponentsInChildren<TMPro.TextMeshPro>()
                .Any(text=>text.name=="Title"&&text.text=="Could not answer"),"Generic interpretation failure was incorrectly labelled unavailable.");
            view.InterpretationFailure.UtteranceId="older-synthetic";view.Dialogue=new DialogueView {Speaker="boopy",UtteranceId="latest-synthetic",Text="Current synthetic reply."};
            Call(fixture.App,"Apply",view);
            Require(fixture.Dialogue.Stage==DialogueStage.Response && fixture.Dialogue.FullText=="Current synthetic reply.","Historical failure replaced a later actual response.");
            Require(fixture.Handler.Paths.Count==0,"Failure presentation called a provider or service.");
        }
        private static void CancelledRetry(string path)
        {
            new HandoffRecoveryStore(path).Save(Anchor());using var fixture=new Fixture(path);
            Call(fixture.App,"RestoreHandoffRecovery");OpenRecovery(fixture);
            var selected=new HandoffRequest {RequestId=Identity,PackageId="ctx_recovery"};
            var failed=Pending(selected);failed.State="failed";failed.Reason="interrupted";
            fixture.Handler.Complete(0,HttpStatusCode.OK,failed);
            fixture.Console.Activate(ConsoleAction.Options);Release(fixture,ConsoleAction.Handoff);
            Require(fixture.Handler.Status.Count==2 && fixture.Handler.Prepares==0,"Retry must check its retained request before POST.");
            Release(fixture,ConsoleAction.Cancel);fixture.Handler.Complete(1,HttpStatusCode.OK,failed);
            Require(fixture.Handler.Prepares==0 && State(fixture)=="interrupted","A cancelled delayed failed GET launched a preparation POST.");
        }
        private static void MissingRetryFailsOnce(string path)
        {
            new HandoffRecoveryStore(path).Save(Anchor());using var fixture=new Fixture(path);
            Call(fixture.App,"RestoreHandoffRecovery");OpenRecovery(fixture);
            var selected=new HandoffRequest {RequestId=Identity,PackageId="ctx_recovery"};
            var failed=Pending(selected);failed.State="failed";failed.Reason="interrupted";
            fixture.Handler.Complete(0,HttpStatusCode.OK,failed);
            fixture.Console.Activate(ConsoleAction.Options);Release(fixture,ConsoleAction.Handoff);
            fixture.Handler.Complete(1,HttpStatusCode.NotFound,new {});
            Require(fixture.Handler.Prepares==1 && fixture.Handler.Status.Count==3,"Missing status did not issue exactly one authorized retry.");
            fixture.Handler.Complete(2,HttpStatusCode.OK,failed);
            Require(fixture.Handler.Prepares==1 && fixture.Handler.Status.Count==3 && State(fixture)=="failed"
                && !(bool)Get(fixture.App,"busy")!,"An immediate failed retry response caused a second POST for one action.");
        }
        private static void CancelledRecovery(string path, bool beforeSession, bool timeout)
        {
            new HandoffRecoveryStore(path).Save(Anchor()); using var fixture = new Fixture(path);
            fixture.Handler.HoldSession = beforeSession;
            var current = View(false); current.Id = "ses_current_cancel"; Call(fixture.App, "Apply", current);
            Call(fixture.App, "RestoreHandoffRecovery"); OpenRecovery(fixture);
            Require(fixture.Dialogue.Stage == DialogueStage.Working, "Recovery fixture did not enter a real pending check.");
            var wait = (CancellationTokenSource)Get(fixture.App, "handoffWait")!;
            if (timeout)
            {
                // Shorten this existing production deadline, without waiting 45 seconds.
                wait.CancelAfter(1);
                Require(wait.Token.WaitHandle.WaitOne(1000), "Synthetic recovery deadline did not expire.");
            }
            else Release(fixture, ConsoleAction.Cancel);
            var selected = new HandoffRequest {RequestId=Identity,PackageId="ctx_recovery"};
            if (beforeSession) fixture.Handler.SessionReply.SetResult(Reply(HttpStatusCode.OK, View(true)));
            else fixture.Handler.Complete(0, HttpStatusCode.OK, Complete(selected));
            Require(State(fixture) == "interrupted" && !(bool)Get(fixture.App,"busy")!
                && (string?)Get(fixture.Console,"handoffState") == "interrupted",
                "Ended recovery left app/receipt checking or input busy.");
            Require(fixture.Dialogue.Stage == DialogueStage.Error && fixture.Dialogue.FullText.Contains("Preparation status unknown")
                && fixture.Dialogue.FullText.Contains("Nothing has been sent"),
                "Ended recovery left a Working shimmer or implied delivery/completion.");
            fixture.Dialogue.RefreshVisuals(20f);
            Require(!fixture.Dialogue.FullText.Contains("Still waiting") && fixture.Store.Load()?.RequestId == Identity
                && fixture.Handler.Prepares == 0 && fixture.Handler.Commits == 0,
                "Ended recovery lost its identity, mutated context or continued waiting.");
            if (beforeSession) Require(ReferenceEquals(Get(fixture.App,"session"),current), "Cancelled session read replaced the current conversation.");
            else
            {
                Release(fixture, ConsoleAction.Back);
                Require(ReferenceEquals(Get(fixture.App,"session"),current), "Cancelled receipt read lost the return conversation.");
            }
            fixture.Handler.HoldSession = false; OpenRecovery(fixture);
            var index = beforeSession ? 0 : 1;
            fixture.Handler.Complete(index, HttpStatusCode.OK, Complete(selected));
            Require(State(fixture) == "prepared-local" && fixture.Handler.Methods.All(method=>method==HttpMethod.Get)
                && fixture.Store.Load()?.RequestId == Identity,
                "Explicit check after cancellation/timeout did not recover the same receipt using GET only.");
        }
        private static void FailedRecovery(string path, bool beforeSession, bool storageFailure)
        {
            new HandoffRecoveryStore(path).Save(Anchor()); using var fixture = new Fixture(path);
            fixture.Handler.HoldSession = beforeSession;
            var current = View(false); current.Id = "ses_current_failure"; Call(fixture.App, "Apply", current);
            Call(fixture.App,"RestoreHandoffRecovery"); OpenRecovery(fixture);
            if (storageFailure)
            {
                File.Delete(path); Directory.CreateDirectory(path);
                fixture.Handler.SessionReply.SetResult(Reply(HttpStatusCode.OK, View(true)));
            }
            else if (beforeSession) fixture.Handler.SessionReply.SetResult(Reply(HttpStatusCode.ServiceUnavailable,new {}));
            else fixture.Handler.Complete(0,HttpStatusCode.ServiceUnavailable,new {});
            Require(State(fixture)=="interrupted" && (string?)Get(fixture.Console,"handoffState")=="interrupted"
                && !(bool)Get(fixture.App,"busy")! && fixture.Dialogue.Stage==DialogueStage.Error,
                "Failed recovery left checking/Working presentation or locked input.");
            Require(fixture.Handler.Prepares==0 && fixture.Handler.Commits==0
                && ((HandoffRecoveryRecord)Get(fixture.App,"handoffRecoveryRecord")!).RequestId==Identity,
                "Failed recovery mutated context or replaced its retained identity.");
            if (beforeSession && !storageFailure)
                Require(ReferenceEquals(Get(fixture.App,"session"),current),"Failed session read replaced current conversation.");
            if (storageFailure)
            {
                Require(fixture.Handler.Status.Count==0 && fixture.Dialogue.FullText.Contains("No new preparation was sent"),
                    "Recovery storage failure continued service work or lost its actionable error.");
                Directory.Delete(path);
            }
        }
    }
}
