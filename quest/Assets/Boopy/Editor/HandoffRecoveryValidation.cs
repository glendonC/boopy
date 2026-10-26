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
        private static void RecoveryLayouts(string path)
        {
            ScriptCoverage.Install();new HandoffRecoveryStore(path).Save(Anchor());using var fixture=new Fixture(path);
            var current=View(false);current.Id="ses_current_render";Call(fixture.App,"Apply",current);Call(fixture.App,"RestoreHandoffRecovery");
            fixture.Console.Activate(ConsoleAction.Options);
            foreach(var large in new[] {false,true})
            {
                if((fixture.Console.ComfortScale>1f)!=large)fixture.Console.Activate(ConsoleAction.Size);
                RenderRecovery(fixture,"context-"+(large?"large":"standard"));
            }
            Release(fixture,ConsoleAction.Handoff);
            fixture.Handler.Complete(0,HttpStatusCode.OK,Complete(new HandoffRequest {RequestId=Identity,PackageId="ctx_recovery"}));
            foreach(var large in new[] {false,true})
            {
                if((fixture.Console.ComfortScale>1f)!=large)fixture.Console.Activate(ConsoleAction.Size);
                var card=fixture.Console.GetComponentsInChildren<SpatialSurface>().Single(surface=>surface.name=="Evidence instrument");
                Require(card.BodyText.Contains("Preparation ID: "+Identity) && card.BodyText.Contains("Dismiss removes only this headset recovery record.")
                    && card.BodyText.Contains("Not sent yet"),"Recovery render lacks exact identity, local dismissal scope or no-delivery state.");
                RenderRecovery(fixture,"receipt-"+(large?"large":"standard"));
            }
        }
        private static void RenderRecovery(Fixture fixture,string name)
        {
            fixture.Eyes.rotation=Quaternion.identity;
            var follow=fixture.Root.AddComponent<FollowConsole>();follow.Initialize(fixture.Eyes,fixture.Console.transform);
            fixture.Console.Place(follow.DesiredPosition);UnityEngine.Object.DestroyImmediate(follow);
            fixture.Console.RefreshVisuals(1f);Physics.SyncTransforms();
            var camera=fixture.Eyes.GetComponent<Camera>();
            if(camera==null)camera=fixture.Eyes.gameObject.AddComponent<Camera>();
            camera.fieldOfView=58;camera.aspect=1;camera.nearClipPlane=.05f;camera.clearFlags=CameraClearFlags.SolidColor;
            camera.backgroundColor=new Color(.15f,.17f,.19f);camera.allowHDR=false;camera.allowMSAA=false;
            var target=new RenderTexture(1000,1000,24);target.Create();var image=new Texture2D(1000,1000,TextureFormat.RGB24,false);var prior=RenderTexture.active;
            try
            {
                camera.targetTexture=target;camera.aspect=1;
                foreach(var text in fixture.Console.GetComponentsInChildren<TextMeshPro>())text.ForceMeshUpdate(true,true);
                // Save the exact projection first, including when a subsequent layout assertion fails.
                camera.Render();RenderTexture.active=target;image.ReadPixels(new Rect(0,0,1000,1000),0,0);image.Apply();
                var output=Path.Combine(Path.GetTempPath(),"boopy-handoff-recovery-"+name+".png");File.WriteAllBytes(output,image.EncodeToPNG());Debug.Log("Boopy recovery synthetic render: "+output);
                foreach(var text in fixture.Console.GetComponentsInChildren<TextMeshPro>())
                {
                    Require(!text.isTextOverflowing,"Recovery copy overflows in "+name+": "+text.name+" = "+text.text);
                    foreach(var glyph in text.textInfo.characterInfo.Take(text.textInfo.characterCount).Where(g=>g.isVisible))
                        foreach(var corner in new[] {glyph.bottomLeft,glyph.topRight})
                        {
                            var at=camera.WorldToViewportPoint(text.transform.TransformPoint(corner));
                            Require(at.z>0 && at.x>=0 && at.x<=1 && at.y>=0 && at.y<=1,"Recovery copy leaves viewport in "+name+": "+text.name+" = "+text.text);
                        }
                }
                var controls=fixture.Console.GetComponentsInChildren<SpatialAction>().Where(action=>action.GetComponent<BoxCollider>().enabled).ToArray();
                for(var x=0;x<controls.Length;x++)for(var y=x+1;y<controls.Length;y++)
                    Require(!controls[x].GetComponent<BoxCollider>().bounds.Intersects(controls[y].GetComponent<BoxCollider>().bounds),
                        "Recovery controls overlap: "+controls[x].Action+" / "+controls[y].Action);
            }
            finally {camera.targetTexture=null;RenderTexture.active=prior;UnityEngine.Object.DestroyImmediate(target);UnityEngine.Object.DestroyImmediate(image);}
        }

        private static void OpenRecovery(Fixture fixture){fixture.Console.Activate(ConsoleAction.Options);Release(fixture,ConsoleAction.Handoff);}
        private sealed class Fixture:IDisposable
        {
            public readonly GameObject Root;public readonly Transform Eyes;public readonly ContextConsole Console;
            public readonly DialogueStrip Dialogue;public readonly BoopyApp App;public readonly SessionScene Scene;
            public readonly RecoveryTransport Handler=new RecoveryTransport();public readonly HandoffRecoveryStore Store;
            public Fixture(string path)
            {
                Root=new GameObject("Synthetic durable preparation fixture");Eyes=new GameObject("Synthetic eyes").transform;Eyes.SetParent(Root.transform,false);
                Console=ContextConsole.Create(Root.transform,Eyes);Console.Place(Vector3.forward);Dialogue=DialogueStrip.Create(Root.transform,Eyes);Console.DockDialogue(Dialogue);
                Scene=SessionScene.Create(Root.transform,Root.AddComponent<RoomCamera>(),Eyes);Scene.PlaceConsole(Console);
                Store=new HandoffRecoveryStore(path);App=Root.AddComponent<BoopyApp>();
                Set(App,"head",Eyes);Set(App,"console",Console);Set(App,"dialogue",Dialogue);Set(App,"scene",Scene);
                Set(App,"client",new ServiceClient(handler:Handler));Set(App,"handoffRecoveryStore",Store);Set(App,"handoffPollMilliseconds",0);
            }
            public void Dispose()=>UnityEngine.Object.DestroyImmediate(Root);
        }
        private static SessionView View(bool committed)
        {
            var view=new SessionView {Id="ses_recovery",State=committed?"committed":"review",Model=new ModelRef {Provider="fixture",Id="synthetic"},
                Committed=committed?new Committed {PackageId="ctx_recovery",At="1970-01-01T12:00:00.000Z"}:null};
            view.Items.Add(new Item {Id="itm_recovery",Kind="object",Label="Synthetic source",Status="proposed",Grounding=new Grounding {Kind="box",ObservationId="older-observation",Box=new Box2 {X0=.4f,Y0=.4f,X1=.6f,Y1=.6f}}});return view;
        }
        private static HandoffStatus Pending(HandoffRequest selected)=>new HandoffStatus {SessionId="ses_recovery",PackageId=selected.PackageId,RequestId=selected.RequestId,
            ReceiptId="handoff_11111111-1111-4111-8111-111111111111",SelectionSha256=new string('a',64),Attempt=1,State="preparing-local"};
        private static HandoffStatus Complete(HandoffRequest selected)=>HandoffPreparationValidation.Completed(selected,"ses_recovery");
        private sealed class RecoveryTransport:HttpMessageHandler
        {
            public readonly List<string> Paths=new List<string>();public readonly List<HttpMethod> Methods=new List<HttpMethod>();public readonly List<TaskCompletionSource<HttpResponseMessage>> Status=new List<TaskCompletionSource<HttpResponseMessage>>();
            public readonly TaskCompletionSource<HttpResponseMessage> CommitReply=new TaskCompletionSource<HttpResponseMessage>();
            public readonly TaskCompletionSource<HttpResponseMessage> SessionReply=new TaskCompletionSource<HttpResponseMessage>();
            public int Commits,Prepares,SessionReads;public bool HoldCommit,HoldSession;public bool SessionCommitted=true;public HandoffRequest? LastSelection;
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancel)
            {
                var path=request.RequestUri!.AbsolutePath;Paths.Add(path);Methods.Add(request.Method);
                if(path=="/v1/health")return Task.FromResult(Reply(HttpStatusCode.OK,new {ok=true,service="boopy",interpreter=new {provider="fixture",model="synthetic"}}));
                if(path=="/v1/sessions/ses_recovery"){Require(request.Method==HttpMethod.Get,"Session recovery must be GET-only.");SessionReads++;return HoldSession?SessionReply.Task:Task.FromResult(Reply(HttpStatusCode.OK,View(SessionCommitted)));}
                if(path.EndsWith("/commit",StringComparison.Ordinal)){Commits++;return HoldCommit?CommitReply.Task:Task.FromResult(Reply(HttpStatusCode.OK,View(true)));}
                Require(path.Contains("/handoff-preparations"),"Recovery touched unrelated service endpoint.");
                if(request.Method==HttpMethod.Post){Prepares++;LastSelection=Wire.Read<HandoffRequest>(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());}
                else Require(request.Method==HttpMethod.Get,"Preparation status must be GET-only.");
                var pending=new TaskCompletionSource<HttpResponseMessage>();Status.Add(pending);return pending.Task;
            }
            public void Complete(int index,HttpStatusCode code,object body)=>Status[index].SetResult(Reply(code,body));
        }
        private static HttpResponseMessage Reply(HttpStatusCode code,object body)=>new HttpResponseMessage(code){Content=new StringContent(Wire.Write(body))};
        private static void Release(Fixture fixture,ConsoleAction action)
        {
            fixture.Console.RefreshVisuals(1f);fixture.Dialogue.RefreshVisuals(1f);Physics.SyncTransforms();
            var control=fixture.Console.GetComponentsInChildren<SpatialAction>().Single(value=>value.Action==action);
            fixture.Eyes.rotation=Quaternion.LookRotation(control.transform.position-fixture.Eyes.position,Vector3.up);
            Set(fixture.App,"pendingControl",action);Set(fixture.App,"pendingUsesHandRay",false);
            Require((bool)Call(fixture.App,"ReleaseControl",new HandInput(true,null,null))!,"Released recovery control did not activate.");
        }
        private static string State(Fixture fixture)=>(string)Get(fixture.App,"handoffState")!;
        private static object? Call(object target,string name,params object[] args)=>target.GetType().GetMethod(name,Flags)!.Invoke(target,args);
        private static object? Get(object target,string name)=>target.GetType().GetField(name,Flags)!.GetValue(target);
        private static void Set(object target,string name,object? value)=>target.GetType().GetField(name,Flags)!.SetValue(target,value);
        private static void Require(bool value,string words){if(!value)throw new InvalidOperationException(words);}
    }
}
