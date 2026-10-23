#nullable enable
using System;
using System.Linq;
using System.Reflection;
using System.Threading;
using Boopy.Client;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>Production input guards and cleanup with synthetic controls; never opens microphone/camera/network.</summary>
    public static class ButtonTalkValidation
    {
        private const BindingFlags Flags = BindingFlags.Instance | BindingFlags.NonPublic;
        public static void Validate()
        {
            ValidateCaptureCueIntegration();
            ValidateTurnProgress();
            ValidateProtectedContext();
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var root = new GameObject("Synthetic explicit Talk lifecycle");
            try
            {
                var eyes = new GameObject("Synthetic eyes").transform; eyes.SetParent(root.transform, false);
                var room = root.AddComponent<RoomCamera>();
                var scene = SessionScene.Create(root.transform, room, eyes);
                var console = ContextConsole.Create(root.transform, eyes); console.SetConnectionStatus("connected", false); console.Place(Vector3.forward);
                var dialogue = DialogueStrip.Create(root.transform, eyes); console.DockDialogue(dialogue);
                var app = root.AddComponent<BoopyApp>();
                Set(app, "head", eyes); Set(app, "room", room); Set(app, "scene", scene);
                Set(app, "console", console); Set(app, "dialogue", dialogue);
                var hand = new HandInput(true, null, null);
                var state = (ButtonTalk)Get(app, "buttonTalk")!;
                // A release away from the Talk target never records or captures.
                Set(app, "pendingControl", ConsoleAction.Talk); eyes.rotation = Quaternion.Euler(0,180,0);
                Call(app, "ReleaseControl", hand);
                Require(!state.Recording && !((Voice)Get(app,"voice")!).Recording && Get(app,"pendingEvidence") == null, "Off-target Talk release started capture.");
                // A deliberate Talk release still respects actual camera readiness.
                Aim(eyes, console, ConsoleAction.Talk); Set(app, "pendingControl", ConsoleAction.Talk);
                Call(app, "ReleaseControl", hand);
                Require(!state.Recording && !((Voice)Get(app,"voice")!).Recording && console.InputPolicy.Pending == null, "Unavailable camera started explicit recording.");
                Require(dialogue.Stage == DialogueStage.Error && dialogue.FullText.Contains("Camera not ready"), "Camera failure is not visible.");
                // A noncontrol pinch cannot start a second microphone or confirm an item while latched.
                Arm(state, console); eyes.rotation = Quaternion.Euler(0,180,0);
                Call(app, "Handle", PinchEvent.Began, hand);
                Require(Get(app,"active") == null && state.Recording && Get(app,"client") == null, "Off-control pinch changed an explicit recording.");
                // A cancelled Finish press keeps the existing recording; explicit Cancel discards it.
                Set(app,"active",hand); Set(app,"pendingControl",ConsoleAction.FinishTalk);
                Call(app,"Handle",PinchEvent.Cancelled,hand);
                Require(state.Recording && Get(app,"active") == null, "Cancelled Finish discarded the recording.");
                Aim(eyes,console,ConsoleAction.Cancel); Set(app,"pendingControl",ConsoleAction.Cancel);
                Call(app,"ReleaseControl",hand);
                Require(!state.Recording && console.InputPolicy.Pending == null && Get(app,"pendingEvidence") == null, "Cancel retained button recording or evidence.");
                // Finish before source preparation and a 30-second timeout discard, never submit.
                Arm(state,console); Call(app,"FinishRecording");
                Require(!state.Recording && Get(app,"captureRequest") == null && Get(app,"client") == null, "Unready Finish started transport.");
                Arm(state,console);
                using(var preparation=new CancellationTokenSource())
                {
                    Set(app,"capturePreparation",preparation); Set(app,"pendingEvidence",console.InputPolicy.Begin());
                    Call(app,"ExpireButtonRecording",30f);
                    Require(!state.Recording && preparation.IsCancellationRequested && Get(app,"pendingEvidence") == null && Get(app,"captureRequest") == null, "Timed-out recording retained preparation or sent speech.");
                    Set(app,"capturePreparation",null);
                }
                Arm(state,console); Call(app,"OnFocusLost");
                Require(!state.Recording && !((Voice)Get(app,"voice")!).Recording && Get(app,"pendingEvidence") == null, "Focus loss retained explicit recording.");
                Debug.Log("Boopy explicit Talk input guards passed; synthetic controls, no microphone, source capture or network.");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }
        public static void ValidateCaptureCueIntegration()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);
            var root=new GameObject("Synthetic app capture acknowledgment cleanup");
            try
            {
                var eyes=new GameObject("Synthetic eyes").transform;eyes.SetParent(root.transform,false);
                var console=ContextConsole.Create(root.transform,eyes);
                var room=root.AddComponent<RoomCamera>();
                var scene=SessionScene.Create(root.transform,room,eyes);
                var cue=CaptureScanCue.Create(root.transform);
                var app=root.AddComponent<BoopyApp>();
                Set(app,"console",console);Set(app,"scene",scene);Set(app,"captureScan",cue);
                // No head/room/input/client dependencies are installed on the app: Update must
                // clear forbidden acknowledgment before its hardware-readiness early return.
                void Begin()
                {
                    var source=new Snapshot(new byte[]{255,216,255,217},1280,800,DateTime.UtcNow,Pose.identity,
                        new DepthGrid{Columns=1,Rows=1,Meters=new float?[]{null}},
                        new CameraInfo{FocalLength=new[]{800f,800f},PrincipalPoint=new[]{640f,400f},SensorResolution=new[]{1280,800}},Time.unscaledTime);
                    Require(cue.Begin(source,false) && cue.Visible,"Synthetic app cue did not actually begin.");
                }
                void Hidden(string cause)
                {
                    Require(!cue.Visible && cue.GetComponentsInChildren<LineRenderer>(true).All(line=>!line.enabled),cause+" retained a visible capture acknowledgment.");
                    cue.Refresh(0f,true);Require(!cue.Visible,cause+" allowed a hidden source to replay.");
                    Require(Get(app,"client")==null && Get(app,"pendingEvidence")==null && Get(app,"captureRequest")==null,
                        cause+" unexpectedly created transport or pending capture work.");
                }
                Begin();Call(app,"DiscardRecording");Hidden("DiscardRecording");
                Begin();Call(app,"OnFocusLost");Hidden("OnFocusLost");Set(app,"inputAllowed",true);
                // This is an EditMode fixture for a non-ExecuteAlways MonoBehaviour. Invoke
                // the production callback explicitly; enabled=false alone need not dispatch it.
                // This checks callback cleanup, not PlayMode lifecycle delivery on the headset.
                Begin();app.enabled=false;Call(app,"OnDisable");Hidden("OnDisable");app.enabled=true;
                Begin();Set(app,"inputAllowed",false);Call(app,"ReportFailure","Synthetic ignored background failure.");Hidden("ReportFailure early return");
                Set(app,"inputAllowed",true);
                typeof(SessionScene).GetProperty("ConsolePlaced")!.SetValue(scene,false);
                Require(!scene.ConsolePlaced && Get(app,"head")==null && Get(app,"room")==null,"Protected early-return fixture did not own its preconditions.");
                Begin();Call(app,"Update");Hidden("Protected Update before hardware early return");
                Debug.Log("Boopy app capture cue integration passed: discard, focus, disable, ignored failure and protected early-return cleanup; synthetic sources only.");
            }
            finally {UnityEngine.Object.DestroyImmediate(root);}
        }

        public static void ValidateTurnProgress()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);
            var root=new GameObject("Synthetic streamed turn presentation");
            try
            {
                var eyes=new GameObject("Synthetic eyes").transform;eyes.SetParent(root.transform,false);
                var console=ContextConsole.Create(root.transform,eyes);
                var dialogue=DialogueStrip.Create(root.transform,eyes);console.DockDialogue(dialogue);
                var app=root.AddComponent<BoopyApp>();Set(app,"console",console);Set(app,"dialogue",dialogue);
                using var current=new CancellationTokenSource();using var old=new CancellationTokenSource();
                Set(app,"captureRequest",current);Set(app,"busy",true);Set(app,"inputAllowed",true);
                Set(app,"session",new SessionView{Id="synthetic-current",State="review"});
                console.ShowProcessing();dialogue.ShowThinking(new ThinkingPhrases(3));var phrase=dialogue.FullText;
                var header=(SpatialSurface)typeof(ContextConsole).GetField("header",Flags)!.GetValue(console)!;
                var progress=(TurnProgress)Activator.CreateInstance(typeof(TurnProgress),Flags,null,new object[]{"interpreting"},null)!;
                Call(app,"ApplyTurnProgress",old,"synthetic-current",progress);
                Require(dialogue.FullText==phrase && header.BodyText=="Sending…","A stale request changed the pending caption.");
                Call(app,"ApplyTurnProgress",current,"synthetic-other",progress);
                Require(dialogue.FullText==phrase && header.BodyText=="Sending…","A different session changed the pending caption.");
                Set(app,"inputAllowed",false);Call(app,"ApplyTurnProgress",current,"synthetic-current",progress);
                Require(dialogue.FullText==phrase && header.BodyText=="Sending…","Background progress appeared after focus loss.");
                Set(app,"inputAllowed",true);Call(app,"ApplyTurnProgress",current,"synthetic-current",progress);
                // The actual stage reaches the console's processing line; the strip keeps Boopy's thinking phrase.
                Require(header.BodyText==progress.Words && dialogue.FullText==phrase && dialogue.Stage==DialogueStage.Working,
                    "The actual current stage missed the processing line or replaced the thinking line.");
                dialogue.Show(DialogueStage.Response,"Exact final synthetic answer.");Set(app,"busy",false);
                Call(app,"ApplyTurnProgress",current,"synthetic-current",progress);
                Require(dialogue.FullText=="Exact final synthetic answer.","A queued stage replaced the final answer.");
                Set(app,"busy",true);current.Cancel();Call(app,"ApplyTurnProgress",current,"synthetic-current",progress);
                Require(dialogue.FullText=="Exact final synthetic answer.","Cancelled progress revived a stopped turn.");
                Set(app,"captureRequest",null);
                Debug.Log("Boopy streamed stage lifecycle passed; actual-stage fixtures, no partial answer or provider reasoning.");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }

        public static void ValidateProtectedContext()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);HangulFont.Install();
            var root=new GameObject("Synthetic protected Context release");
            try
            {
                var eyes=new GameObject("Synthetic protected viewer").transform;eyes.SetParent(root.transform,false);
                var room=root.AddComponent<RoomCamera>();var scene=SessionScene.Create(root.transform,room,eyes);
                var console=ContextConsole.Create(root.transform,eyes);console.Place(Vector3.forward);scene.PlaceConsole(console);
                var dialogue=DialogueStrip.Create(root.transform,eyes);console.DockDialogue(dialogue);
                var status=StatusLine.Create(root.transform,eyes,Visuals.Quad());var app=root.AddComponent<BoopyApp>();
                Set(app,"head",eyes);Set(app,"room",room);Set(app,"scene",scene);Set(app,"console",console);Set(app,"dialogue",dialogue);Set(app,"status",status);
                var exact=string.Concat(Enumerable.Repeat("Exact synthetic answer. 기록된 그림이에요. ",12));
                var view=new SessionView {Id="synthetic-context-obstruction",State="review",ReferentId="synthetic-object",Dialogue=new DialogueView {Speaker="boopy",UtteranceId="synthetic-turn",At="1970-01-01T12:00:00Z",Text=exact}};
                view.Utterances.Add(new UtteranceRef {Id="synthetic-turn",Kind="ask",Text="Synthetic question"});
                view.Items.Add(new Item {Id="synthetic-object",Kind="object",Label="Synthetic broad source",Statement="An uncertain proposed source.",Status="proposed",Origin="model",Confidence=.4f,Grounding=new Grounding {Kind="box",ObservationId="synthetic-source",Box=new Box2 {X0=0,Y0=0,X1=1,Y1=1}}});
                foreach(var focal in new[]{32f,16f,8f})
                {
                    scene.Remember("synthetic-source",new Snapshot(new byte[]{255,216,255,217},128,96,DateTime.UtcNow,new Pose(Vector3.zero,Quaternion.identity),new DepthGrid {Columns=1,Rows=1,Meters=new float?[]{1f}},new CameraInfo {FocalLength=new[]{focal,focal},PrincipalPoint=new[]{64f,48f},SensorResolution=new[]{128,96}}));
                    Call(app,"Apply",view);if(!scene.ConsolePlaced)break;
                }
                Require(!scene.ConsolePlaced && (bool)Get(console,"controlsOnly")!,"Synthetic source did not actually trigger protected controls-only placement.");
                dialogue.NextPage();var page=dialogue.VisibleText;var generation=Get(app,"captureGeneration");
                // A tracked hand can select Context without turning away from the protected view.
                // Gaze-aiming here changed the viewer pose and legitimately changed available space.
                console.Activate(ConsoleAction.More);console.RefreshVisuals(1f);Physics.SyncTransforms();
                var context=console.GetComponentsInChildren<SpatialAction>().Single(control=>control.Action==ConsoleAction.Options);
                var ray=new Ray(eyes.position,context.transform.position-eyes.position);
                Require(console.HitAction(ray,out _)==ConsoleAction.Options,"Synthetic Context hand ray misses its target.");
                var hand=new HandInput(true,null,null);
                typeof(HandInput).GetProperty("Ray")!.SetValue(hand,ray);
                typeof(HandInput).GetProperty("RayActive")!.SetValue(hand,true);
                console.SetInteractionLocked(true);
                Set(app,"pendingControl",ConsoleAction.Options);Set(app,"pendingUsesHandRay",true);
                Debug.Log($"Boopy protected Context before release: placed={scene.ConsolePlaced}, obstructed={console.ContextObstructed}, head={eyes.rotation}, console={console.transform.position}, rayActive={hand.RayActive}, resolved={Call(app,"ControlHit",ray,Vector3.zero)}, recovery={Get(console,"captureRecovery")}, busy={Get(console,"busy")}");
                Call(app,"ReleaseControl",hand);console.RefreshVisuals(1f);dialogue.RefreshVisuals(1f);
                Debug.Log($"Boopy protected Context after release: placed={scene.ConsolePlaced}, obstructed={console.ContextObstructed}, notice={dialogue.FullText}, head={eyes.rotation}, console={console.transform.position}, optionsOpen={Get(console,"optionsOpen")}, controlsOnly={Get(console,"controlsOnly")}");
                Require(console.ContextObstructed && !scene.ConsolePlaced,"Context selection weakened source protection.");
                Require(dialogue.gameObject.activeInHierarchy && dialogue.FullText=="Look toward a clear space to open Context.","Protected Context selection has no visible actionable notice.");
                Require(!status.gameObject.activeInHierarchy,"Protected Context notice duplicated the exact-caption channel.");
                Require(console.GetComponentsInChildren<SpatialSurface>(true).Where(surface=>surface.name=="Comfort options" || surface.name=="Intent instrument" || surface.name=="Evidence instrument").All(surface=>!surface.gameObject.activeInHierarchy),"Protected notice exposed attributed conversation panels.");
                dialogue.ClearNotice();Require(dialogue.FullText==exact && dialogue.VisibleText==page,"Context notice lost exact answer or selected page.");
                Require(Equals(Get(app,"captureGeneration"),generation) && Get(app,"captureRequest")==null && Get(app,"pendingEvidence")==null && Get(app,"client")==null,"Context selection started capture or transport.");
                Debug.Log("Boopy protected Context input validation passed: actionable notice, exact page restored, no capture or protection relaxation.");
            }
            finally{UnityEngine.Object.DestroyImmediate(root);}
        }

        private static void Arm(ButtonTalk state, ContextConsole console) { state.End(); state.Begin(0); console.ShowListening(false); console.SetButtonRecording(true); }
        private static void Aim(Transform eyes, ContextConsole console, ConsoleAction action)
        {
            console.RefreshVisuals(1f); Physics.SyncTransforms(); var control=console.GetComponentsInChildren<SpatialAction>().Single(item=>item.Action==action);
            eyes.rotation=Quaternion.LookRotation(control.transform.position-eyes.position,Vector3.up);
        }
        private static object? Call(object target,string name,params object[] args)=>target.GetType().GetMethod(name,Flags)!.Invoke(target,args);
        private static void Set(object target,string name,object? value)=>target.GetType().GetField(name,Flags)!.SetValue(target,value);
        private static object? Get(object target,string name)=>target.GetType().GetField(name,Flags)!.GetValue(target);
        private static void Require(bool value,string message){if(!value)throw new InvalidOperationException(message);}
    }
}
