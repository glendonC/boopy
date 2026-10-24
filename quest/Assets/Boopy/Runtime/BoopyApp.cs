#nullable enable
using System;
using System.Linq;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using UnityEngine;
#if UNITY_ANDROID && !UNITY_EDITOR
using UnityEngine.Android;
#endif

namespace Boopy.Quest
{
    /// <summary>
    /// The loop on the headset: look, pinch and hold, talk, let go; see what Boopy understood in
    /// the room; correct it with a pinch or a few words; say "save it". The headset captures,
    /// points, renders and forwards. The Mac decides what anything means.
    /// </summary>
    public sealed class BoopyApp : MonoBehaviour
    {
        private const string CameraPermission = "horizonos.permission.HEADSET_CAMERA";
        private const string ScenePermission = "com.oculus.permission.USE_SCENE";
        private const float FocusDwellSeconds = 0.35f;

        private ServiceClient? client;
        private RoomCamera? room;
        private PassthroughView? passthrough;
        private SessionScene? scene;
        private StatusLine? status;
        private DialogueStrip? dialogue;
        private SpeechPlayback? speechPlayback;
        private CancellationTokenSource? speechRequest;
        private int speechGeneration;
        private bool pendingDialogue;
        // A pinch begun on the reader's card or on Settings, with its ray, until it is a tap or a hold.
        private Ray? pagePinch;
        private ContextConsole? console;
        private bool pendingUsesHandRay;
        private ConsoleAction pendingControl;
        private ConsoleAction hoveredControl;
        private InteractionAudio? feedback;
        private FollowConsole? following;
        private CancellationTokenSource? captureRequest;
        private CancellationTokenSource? handoffWait;
        private HandoffRequest? handoffSelection;
        private HandoffRecoveryStore? handoffRecoveryStore;
        private HandoffRecoveryRecord? handoffRecoveryRecord;
        private bool handoffRecoveryOffered, handoffStorageFailed;
        private SessionView? handoffReturnSession;
        private bool handoffSubmitted;
        private int handoffGeneration;
        private string handoffState = "not-prepared";
        private int handoffPollMilliseconds = 250;
        private Reticle? gaze;
        private Reticle? pointer;
        private Reticle? marker;
        private HandInput? left;
        private HandInput? right;
        private readonly Voice voice = new Voice();
        private Transform? head;
        private Transform? pocket;

        private SessionView? session;
        private bool busy;
        private readonly ButtonTalk buttonTalk = new ButtonTalk();
        private CancellationTokenSource? healthCheck;
        private int healthGeneration;
        private bool connectionSpeechAvailable;
        private bool? connectionLiveSceneAvailable;
        private float nextHealthAt;
        private bool inputAllowed = true;

        // What was captured when the fingers met: the frame, the cues, the card under the ray.
        private HandInput? active;
        private Snapshot? pending;
        private Cues? pendingCues;
        private string? pendingTarget;
        private CancellationTokenSource? capturePreparation;
        private int captureGeneration;
        private bool captureReady;
        private EvidenceTurn? pendingEvidence;
        private string? cancelledWaitNotice;
        // Persist only the uncertain request identity. Pixels, speech and room placement stay in memory.
        private string? unresolvedStartId;
        private Snapshot? unresolvedSnapshot;
        private CaptureRecoveryStore? recoveryStore;
        private bool recoveryStorageFailed;
        private LiveSceneHud? liveHud;
        private CaptureScanCue? captureScan;
        private CancellationTokenSource? liveRequest;
        private readonly string liveStreamId = Guid.NewGuid().ToString();
        private int liveSequence;
        private float nextSceneAt;
        private bool liveScenePaused;
        private bool reportedLiveScene;
        private bool NeedsCaptureRecovery => unresolvedStartId != null || recoveryStorageFailed;

        private Chip? dwellChip;
        private float dwellSince;

        // The task presented on the session's subject; null shows the session's own presentation.
        private InteractionPresentation? task;
        // Only the current session's task is ever drawn or answered.
        private InteractionPresentation? PresentedTask => task != null && session != null && task.SessionId == session.Id ? task : null;
        // One task per session. Its open ids are made once, so asking again is the same open.
        private string? taskSessionId, taskOpenEventId, taskOpenId;
        private CancellationTokenSource? taskOpen;
        // The button recording is an answer to the presented task, not a Talk turn.
        private bool answeringTask;
        // Boopy's thinking phrases while a turn is with the Mac, one order for the whole app run. A turn that sends
        // no picture never says Boopy is looking.
        private ThinkingPhrases thinking = new ThinkingPhrases(Environment.TickCount);
        private ThinkingPhrases thinkingWithoutPicture = new ThinkingPhrases(Environment.TickCount + 1, picture: false);
        private ThinkingPhrases Thinking(bool picture) => picture ? thinking : thinkingWithoutPicture;

        private void Start()
        {
            var rig = FindAnyObjectByType<OVRCameraRig>();
            if (rig == null)
            {
                Debug.LogError("Boopy: the scene has no OVRCameraRig. Run Boopy > Build Scene.");
                enabled = false;
                return;
            }
            head = rig.centerEyeAnchor;
            pocket = rig.leftHandAnchor;
            left = new HandInput(false, rig.leftHandAnchor.GetComponentInChildren<OVRHand>(true), rig.leftHandAnchor.GetComponentInChildren<OVRSkeleton>(true));
            right = new HandInput(true, rig.rightHandAnchor.GetComponentInChildren<OVRHand>(true), rig.rightHandAnchor.GetComponentInChildren<OVRSkeleton>(true));

            passthrough = new PassthroughView(gameObject);
            passthrough.Start(Time.unscaledTime);
            room = gameObject.AddComponent<RoomCamera>();
            scene = SessionScene.Create(transform, room, head);
            status = StatusLine.Create(transform, head, Visuals.Quad());
            dialogue = DialogueStrip.Create(transform, head);
            speechPlayback = SpeechPlayback.Create(transform);
            console = ContextConsole.Create(transform, head);
            console.DockDialogue(dialogue);
            liveHud = LiveSceneHud.Create(transform, head, room);
            captureScan = CaptureScanCue.Create(transform);
            liveScenePaused=PlayerPrefs.GetInt("Boopy.LiveScenePaused",0)==1;
            feedback = InteractionAudio.Create(console.transform);
            feedback.SetEnabled(console.SoundEnabled);
            scene.SetReducedMotion(console.ReducedMotion);
            following = gameObject.AddComponent<FollowConsole>();
            following.Initialize(head, console.transform);
            scene.MoveConsole(console, following.DesiredPosition);
            gaze = Reticle.Create("Gaze reticle", transform, head);
            pointer = Reticle.Create("Hand reticle", transform, head, 0.0012f, ReticleRole.Hand);
            marker = Reticle.Create("Cue marker", transform, head, 0.003f, ReticleRole.Capture);
            pointer.Hide();
            marker.Hide();
            client = new ServiceClient();
            recoveryStore = new CaptureRecoveryStore(Path.Combine(Application.persistentDataPath, "pending-capture-id"));
            handoffRecoveryStore = new HandoffRecoveryStore(Path.Combine(Application.persistentDataPath, "preparation-identity"));

            OVRManager.InputFocusLost += OnFocusLost;
            OVRManager.InputFocusAcquired += OnFocusAcquired;

            var font = HangulFont.Install();
            Debug.Log(font == null ? "Boopy: no Korean font found; Hangul will not render." : $"Boopy: Korean from {font}.");
            SayStatus(null);
            RestoreCaptureRecovery();
            RestoreHandoffRecovery();
            if (!NeedsCaptureRecovery)
            {
                RequestPermissions();
            }
            _ = CheckMac();
        }

        private void OnDestroy()
        {
            StopHandoffWait();
            taskOpen?.Cancel();
            healthCheck?.Cancel(); healthGeneration++;
            liveRequest?.Cancel();
            StopSpeech();
            captureRequest?.Cancel();
            DiscardRecording();
            OVRManager.InputFocusLost -= OnFocusLost;
            OVRManager.InputFocusAcquired -= OnFocusAcquired;
            client?.Dispose();
        }

        /// <summary>Focus lost to a system menu: hands give no input, and a recording in progress is dropped (VRC.Quest.Input.4).</summary>
        private void OnFocusLost()
        {
            StopHandoffWait();
            healthCheck?.Cancel(); healthGeneration++;
            console?.SetConnectionStatus("checking", connectionSpeechAvailable);
            connectionLiveSceneAvailable = null;
            console?.SetLiveSceneCapability(null);
            liveRequest?.Cancel();
            liveHud?.SetActive(false, console?.ReducedMotion ?? false);
            captureRequest?.Cancel();
            StopSpeech();
            inputAllowed = false;
            feedback?.SetEnabled(false);
            hoveredControl = ConsoleAction.None;
            DiscardRecording();
            active = null;
            pendingControl = ConsoleAction.None;
            pendingDialogue = false;
            pagePinch = null;
            dialogue?.Hide();
            dialogue?.SetInteractionLocked(false);
            console?.ClearFocus();
            RestoreConsole();
            marker?.Hide();
            status?.SetActivity(false, false);
            Debug.Log("Boopy: input focus lost.");
        }

        private void OnFocusAcquired()
        {
            inputAllowed = true;
            _ = CheckMac();
            feedback?.SetEnabled(console?.SoundEnabled ?? true);
            if (!busy) SayStatus(null);
            if (!busy && cancelledWaitNotice != null) ReportFailure(cancelledWaitNotice);
            else if (!busy && session != null) Apply(session);
            Debug.Log("Boopy: input focus acquired.");
        }

        private void RequestPermissions()
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            var missing = new[] { CameraPermission, ScenePermission, Permission.Microphone }
                .Where(permission => !Permission.HasUserAuthorizedPermission(permission))
                .ToArray();
            if (missing.Length == 0) return;
            SayStatus("Boopy needs the cameras, the room's depth and the microphone to see what you point at.");
            Permission.RequestUserPermissions(missing);
#endif
        }

        // Notices share the companion anchor; the lower fallback is used only when that
        // anchor cannot be placed clear of captured objects. Never show competing captions.
        private void SayStatus(string? words, float seconds = 0f)
        {
            if (string.IsNullOrWhiteSpace(words)) { status?.Say(null); dialogue?.ClearNotice(); return; }
            if (console != null && (scene?.ConsolePlaced != false || console.ContextObstructed) && console.gameObject.activeInHierarchy && dialogue != null)
            {
                status?.Say(null);
                dialogue.ShowNotice(words!, seconds);
            }
            else status?.Say(words, seconds);
        }

        private async Task CheckMac(bool announce = true)
        {
            if (client == null || console == null || !inputAllowed || !isActiveAndEnabled) return;
            healthCheck?.Cancel();
            using var check = new CancellationTokenSource(); healthCheck = check;
            var generation = ++healthGeneration;
            if (announce) console.SetConnectionStatus("checking", connectionSpeechAvailable);
            try
            {
                var health = await client.ReadHealthAsync(check.Token);
                if (check.IsCancellationRequested || generation != healthGeneration || !inputAllowed || !isActiveAndEnabled) return;
                connectionSpeechAvailable = health?.SpeechOutputAvailable ?? false;
                connectionLiveSceneAvailable = health?.LiveSceneAvailable;
                console.SetLiveSceneCapability(connectionLiveSceneAvailable);
                if (connectionLiveSceneAvailable != true)
                {
                    liveRequest?.Cancel();
                    liveHud?.SetActive(false, console.ReducedMotion);
                }
                console.SetConnectionStatus(health == null ? "unavailable" : "connected", connectionSpeechAvailable);
            }
            catch (OperationCanceledException) { }
            finally { if (ReferenceEquals(healthCheck, check)) { healthCheck = null; nextHealthAt = Time.unscaledTime + 5f; } }
        }

        private void Update()
        {
            if (inputAllowed && healthCheck == null && Time.unscaledTime >= nextHealthAt) _ = CheckMac(false);
            console?.InputPolicy.SetInteractionState(inputAllowed, busy);
            captureScan?.Refresh(Time.unscaledDeltaTime, inputAllowed && isActiveAndEnabled && console != null && !console.InputPolicy.SpokenOnly && !NeedsCaptureRecovery && scene?.ConsolePlaced == true);
            console?.SetSpeaking(inputAllowed && !busy && !voice.Recording ? speechPlayback?.Activity ?? 0f : 0f);
            dialogue?.SetCancelableWait(busy && captureRequest != null && !captureRequest.IsCancellationRequested);
            if (head == null || room == null || scene == null || gaze == null || pointer == null || left == null || right == null) return;
            if (inputAllowed && !busy && !voice.Recording) console?.TryGreetOpening();
            var now = Time.unscaledTime;
            ExpireButtonRecording(now);
            passthrough?.Poll(now);
            // Read both hands before drawing or resolving targets: never use last frame's ray.
            var rightPinch = right.Update(head, now, inputAllowed);
            var leftPinch = left.Update(head, now, inputAllowed);

            var gazeRay = new Ray(head.position, head.forward);
            var aiming = active != null ? (active.RayActive ? active : null)
                : leftPinch == PinchEvent.Began && left.RayActive ? left
                : right.RayActive ? right : left.RayActive ? left : null;
            if (following != null && console != null)
            {
                var frozen = !inputAllowed || active != null || pendingDialogue || console.ContainsRay(gazeRay)
                    || (aiming != null && console.ContainsRay(aiming.Ray));
                console.SetInteractionLocked(frozen);
                console.SetCompanionFrozen(!inputAllowed || console.HasFocus || console.Reading || pendingControl != ConsoleAction.None);
                var target = following.DesiredPosition;
                scene.MoveConsole(console, following.Advance(target, frozen));
                dialogue?.SetFallback(!scene.ConsolePlaced);
            }
            var gazeChip = scene.ChipHitBy(gazeRay, 5f, out var onChip);
            if (scene.TryGetActiveAnchor(out var sourceAnchor)) console?.AttendTo(sourceAnchor, true);
            else console?.AttendTo(gazeChip != null ? gazeChip.transform.position : head.position, gazeChip != null);
            var gazeControl = ControlHit(gazeRay, out var onControl);
            if (gazeControl != ConsoleAction.None) gaze.Show(onControl, true);
            else if (gazeChip != null) gaze.Show(onChip, true);
            else if (room.TryHit(gazeRay, 6f, out var point, out _)) gaze.Show(point, true);
            else gaze.Show(head.position + head.forward * 1.5f, false);

            Chip? handChip = null;
            var handControl = ConsoleAction.None;

            if (aiming != null)
            {
                handChip = scene.ChipHitBy(aiming.Ray, 5f, out var handOnChip);
                handControl = ControlHit(aiming.Ray, out var handOnControl);
                if (handControl != ConsoleAction.None) pointer.Show(handOnControl, true);
                else if (handChip != null) pointer.Show(handOnChip, true);
                else if (room.TryHit(aiming.Ray, 6f, out var handPoint, out _)) pointer.Show(handPoint, true);
                else pointer.Hide();
            }
            else
            {
                pointer.Hide();
            }

            var focusedControl = aiming != null ? handControl : gazeControl;
            dialogue?.FocusFallbackAction(inputAllowed && focusedControl == ConsoleAction.Cancel);

            if (focusedControl != hoveredControl && inputAllowed && active == null && !busy)
            {
                if (focusedControl != ConsoleAction.None) feedback?.Play(AudioCue.Hover);
                hoveredControl = focusedControl;
            }
            if (active == null && !busy)
                UpdateFocus(focusedControl != ConsoleAction.None ? null : aiming != null ? handChip : gazeChip, now);
            if (console?.ReaderOpen == true) scene.FocusItem(console.SelectedItemId);
            console?.SetSelectedAccent(scene.AccentFor(console.SelectedItemId));
            if (!inputAllowed) console?.ClearFocus();
            else if (pendingControl == ConsoleAction.None) console?.FocusAt(aiming != null ? aiming.Ray : gazeRay);
            if (pendingControl != ConsoleAction.None && active != null)
            {
                var ray = pendingUsesHandRay ? active.Ray : new Ray(head.position, head.forward);
                var pressed = (!pendingUsesHandRay || active.RayActive) && ControlHit(ray, out _) == pendingControl;
                console?.SetPressed(pressed);
                dialogue?.PressFallbackAction(pressed && pendingControl == ConsoleAction.Cancel);

            }
            Handle(rightPinch, right);
            Handle(leftPinch, left);
            var sceneHand = active != null ? (active.RayActive ? active : null) : aiming;
            liveHud?.SetAttentionRays(gazeRay, sceneHand != null ? sceneHand.Ray : (Ray?)null);
            UpdateLiveScene(now);
            var blocked = right.BlockedAttempt ?? left.BlockedAttempt;
            if (inputAllowed && active == null && !busy && blocked != null)
            {
                SayStatus(blocked == "palm" || blocked == "system"
                    ? "Turn your palm away from your face and try again."
                    : "Keep your hand where the headset can see it.", 5f);
            }
            status?.SetActivity(voice.Recording, busy);
            marker?.SetActivity(voice.Recording, busy);
            pointer.SetActivity(voice.Recording, false);
        }

        // Background perception yields to the wearer's current conversation and controls.
        private bool AmbientSceneAllowed => connectionLiveSceneAvailable == true && inputAllowed &&
            console != null && !console.InputPolicy.SpokenOnly && !NeedsCaptureRecovery && !liveScenePaused &&
            !busy && !voice.Recording && speechRequest == null && speechPlayback?.Playing != true && !console.Reading && !console.HasFocus;

        private bool AmbientCaptureAllowed => AmbientSceneAllowed && liveHud?.HasPresentationFocus != true;

        private bool ApplyLiveSceneResult(SceneObservation result, SceneObservationRequest sourceRequest,
            Snapshot snapshot, CancellationTokenSource request, float now)
        {
            if (request.IsCancellationRequested || !AmbientCaptureAllowed || !isActiveAndEnabled || liveHud == null
                || snapshot.SourceTime == null || !CameraFrameTime.IsFresh(snapshot.SourceTime.Value, now)) return false;
            var applied = liveHud.Show(result, sourceRequest, snapshot, now);
            if (applied && !reportedLiveScene) { Debug.Log("Boopy: live scene first update applied."); reportedLiveScene = true; }
            return applied;
        }

        private void UpdateLiveScene(float now)
        {
            if(liveHud==null || room==null || console==null)return;
            var enabled = AmbientSceneAllowed;
            liveHud.SetActive(enabled,console.ReducedMotion);
            liveHud.SetPaused(liveScenePaused);
            console.SetScenePaused(liveScenePaused);
            if(!enabled || liveScenePaused) { liveRequest?.Cancel(); return; }
            var occupied = new System.Collections.Generic.List<LabelRect>();
            scene?.AppendPresentationKeepouts(occupied, console);
            liveHud.RefreshAttention(now, occupied, new LabelRect(-.12f, -.09f, .12f, .09f), console.ComfortScale);
            if (!AmbientCaptureAllowed) { liveRequest?.Cancel(); return; }
            if(!room.Ready || voice.Recording || liveRequest!=null || now<nextSceneAt)return;
            _ = ObserveScene();
        }

        private async Task ObserveScene()
        {
            if(room==null || client==null || liveHud==null || !AmbientCaptureAllowed)return;
            using var request = new CancellationTokenSource(); liveRequest=request;
            try
            {
                var snapshot=room.Capture();
                if(snapshot?.SourceTime==null || !CameraFrameTime.IsFresh(snapshot.SourceTime.Value,Time.unscaledTime)) {
                    nextSceneAt=Time.unscaledTime+.4f;
                    return;
                }
                liveHud.SetProcessing(true);
                var sourceRequest = new SceneObservationRequest {
                    StreamId=liveStreamId, FrameId=Guid.NewGuid().ToString(), Sequence=liveSequence++, Frame=snapshot.ToFrame()
                };
                var result=await client.ObserveSceneAsync(sourceRequest,request.Token);
                ApplyLiveSceneResult(result,sourceRequest,snapshot,request,Time.unscaledTime);
                nextSceneAt=Time.unscaledTime+.4f;
            }
            catch(OperationCanceledException) { nextSceneAt=Time.unscaledTime+1f; }
            catch(Exception failure) {
                if (!request.IsCancellationRequested && AmbientCaptureAllowed && isActiveAndEnabled) {
                    liveHud?.Unavailable();
                    if(inputAllowed && !busy && !voice.Recording) SayStatus("Scene recognition unavailable. Retrying…",3f);
                    Debug.LogWarning("Boopy: live scene unavailable: "+failure.GetType().Name);
                }
                nextSceneAt=Time.unscaledTime+3f;
            }
            finally { liveHud?.SetProcessing(false); if(ReferenceEquals(liveRequest,request))liveRequest=null; }
        }

        /// <summary>A chip unfolds after a ray rests on it briefly, so sweeping past does not open everything.</summary>
        private void UpdateFocus(Chip? chip, float now)
        {
            if (chip != dwellChip)
            {
                dwellChip = chip;
                dwellSince = now;
                scene?.Focus(null);
            }
            else if (chip != null && now - dwellSince >= FocusDwellSeconds)
            {
                scene?.Focus(chip);
                console?.Inspect(session?.Items.FirstOrDefault(item => item.Id == chip.ItemId));
            }
        }

        private void Handle(PinchEvent pinch, HandInput hand)
        {
            if (pinch == PinchEvent.None) return;
            // Only the hand that began a pinch continues it; a pinch begun while busy is ignored to its end.
            if (pinch == PinchEvent.Began ? active != null : active != hand) return;
            if (pendingDialogue && pinch != PinchEvent.Began)
            {
                if (pinch != PinchEvent.Holding) { pendingDialogue = false; active = null; dialogue?.SetInteractionLocked(false); }
                return;
            }
            // On the reader's card or Settings a tap pages it, as does a release that never came as a hold (a slow frame can span
            // the threshold); held past the hold threshold, the pinch is talking, aimed where it began, as a hold means everywhere.
            if (pagePinch != null && pinch != PinchEvent.Began)
            {
                var aim = pagePinch.Value; pagePinch = null; active = null; dialogue?.SetInteractionLocked(false);
                if (pinch == PinchEvent.Tapped || pinch == PinchEvent.Released) console?.NextPage();
                else if (pinch == PinchEvent.Holding) BeginTalkInternal(hand, false, aim);
                return;
            }
            switch (pinch)
            {
                case PinchEvent.Began:
                    StopSpeech();
                    if (!buttonTalk.Recording && !busy && dialogue?.HitPage(hand.RayActive ? hand.Ray : new Ray(head!.position, head.forward)) == true)
                    {
                        active = hand; pendingDialogue = true; dialogue.SetInteractionLocked(true); dialogue.NextPage(); return;
                    }
                    // The reader's card and Settings wait to see whether the pinch is a tap, which pages, or a hold, which talks.
                    if (!buttonTalk.Recording && !busy && console?.HitPage(hand.RayActive ? hand.Ray : new Ray(head!.position, head.forward)) == true)
                    {
                        active = hand; pagePinch = hand.RayActive ? hand.Ray : new Ray(head!.position, head.forward); dialogue?.SetInteractionLocked(true); return;
                    }
                    var control = ControlHit(hand.RayActive ? hand.Ray : new Ray(head!.position, head.forward), out _);
                    if (buttonTalk.Recording && control != ConsoleAction.FinishTalk && control != ConsoleAction.Cancel && control != ConsoleAction.PauseScene) return;
                    if (busy && control != ConsoleAction.Cancel && control != ConsoleAction.PauseScene) return;
                    if (control != ConsoleAction.None)
                    {
                        // Selection never captures; only an explicit Talk release below starts recording.
                        active = hand;
                        pendingControl = control;
                        pendingUsesHandRay = hand.RayActive;
                        console?.FocusAt(hand.RayActive ? hand.Ray : new Ray(head!.position, head.forward));
                        console?.SetPressed(true);
                        dialogue?.PressFallbackAction(pendingControl == ConsoleAction.Cancel);
                        feedback?.Play(AudioCue.Press);
                        pendingTarget = (control == ConsoleAction.Confirm || control == ConsoleAction.ToggleIncluded) ? console?.SelectedItemId : null;
                        return;
                    }
                    pendingControl = ConsoleAction.None;
                    BeginTalk(hand);
                    break;
                case PinchEvent.Holding:
                    if (pendingControl != ConsoleAction.None) return;
                    if (!voice.Recording) SayStatus("Microphone unavailable. Allow microphone access in Settings.");
                    break;
                case PinchEvent.Tapped:
                    if (ReleaseControl(hand)) return;
                    DiscardRecording();
                    dialogue?.Hide();
                    active = null;
                    marker?.Hide();
                    // A stray tap leaves the task's line in place; the hint shows over it and gives it back.
                    ShowTask();
                    if (pendingTarget != null) _ = Act(pendingTarget);
                    else SayStatus("Tap Talk to start speaking.", 4f);
                    RestoreConsole();
                    break;
                case PinchEvent.Released:
                    if (ReleaseControl(hand)) return;
                    active = null;
                    FinishRecording();
                    break;
                case PinchEvent.Cancelled:
                    if (buttonTalk.Recording)
                    {
                        pendingControl = ConsoleAction.None; active = null;
                        console?.SetPressed(false); console?.ClearFocus();
                        return;
                    }
                    dialogue?.Show(DialogueStage.Error, "Pinch interrupted. Keep your hand in view and try again.");
                    pendingControl = ConsoleAction.None;
                    console?.SetPressed(false);
                    RestoreConsole();
                    DiscardRecording();
                    active = null;
                    marker?.Hide();
                    SayStatus("Pinch interrupted. Keep your hand in view and try again.", 4f);
                    break;
            }
        }

        private void ExpireButtonRecording(float now)
        {
            if (!buttonTalk.Expired(now)) return;
            var answer = answeringTask;
            DiscardRecording(); active = null; pendingControl = ConsoleAction.None;
            marker?.Hide(); RestoreConsole();
            dialogue?.Show(DialogueStage.Error, answer ? TryAnswerAgain("Recording stopped.", PresentedTask) : "Recording stopped. Tap Talk to try again.");
        }

        private void FinishRecording()
        {
            buttonTalk.End(); console?.SetButtonRecording(false);
            if (answeringTask) { FinishAnswer(); return; }
            if (!captureReady)
            {
                DiscardRecording(); marker?.Hide(); RestoreConsole();
                dialogue?.Show(DialogueStage.Error, "Recording wasn’t ready. Tap Talk to try again.");
                return;
            }
            var wav = voice.End(); feedback?.SetRecording(false);
            if (wav == null)
            {
                DiscardRecording(); marker?.Hide(); RestoreConsole();
                dialogue?.Show(DialogueStage.Error, "No speech recorded. Tap Talk to try again.");
                feedback?.Play(AudioCue.Failure); return;
            }
            feedback?.Play(AudioCue.CaptureOff);
            _ = Send(wav);
        }

        // The retry words name the control the person sees, labeled with the Mac's prompt.
        private static string TryAnswerAgain(string what, InteractionPresentation? answered) =>
            what + " Tap " + (answered?.AnswerLabel ?? "Answer") + " to try again.";

        /// <summary>
        /// The task's one action: the same button recording Talk uses, with its listening caption
        /// and Finish. It records an answer to this task only: no frame, no capture, no Talk turn.
        /// </summary>
        private void BeginAnswer()
        {
            if (PresentedTask?.AnswerLabel == null || !inputAllowed || busy || buttonTalk.Recording || voice.Recording || !MicrophoneAllowed()) return;
            StopSpeech();
            cancelledWaitNotice = null;
            captureScan?.Hide();
            answeringTask = true;
            console?.ShowListening(false);
            dialogue?.Show(DialogueStage.Listening, "Listening… Tap Finish when done.");
            SayStatus(null);
            feedback?.SetRecording(true); voice.Begin();
            if (!voice.Recording)
            {
                answeringTask = false;
                feedback?.SetRecording(false); feedback?.Play(AudioCue.Failure);
                RestoreConsole();
                dialogue?.Show(DialogueStage.Error, "Microphone unavailable. Allow microphone access in Settings.");
                Debug.Log("Boopy: answer blocked reason=microphone-unavailable.");
                return;
            }
            buttonTalk.Begin(Time.unscaledTime);
            console?.SetButtonRecording(true);
        }

        private void FinishAnswer()
        {
            answeringTask = false;
            var wav = voice.End(); feedback?.SetRecording(false);
            var answered = PresentedTask;
            if (wav == null || answered == null)
            {
                DiscardRecording(); RestoreConsole();
                dialogue?.Show(DialogueStage.Error, TryAnswerAgain("No speech recorded.", answered));
                feedback?.Play(AudioCue.Failure); return;
            }
            feedback?.Play(AudioCue.CaptureOff);
            _ = SendAnswer(answered, wav);
        }

        /// <summary>
        /// The answer goes to the task with the revision the person answered. The audio stays in
        /// memory for this request only. A stale revision shows the Mac's current task instead;
        /// no words gets its own retry line; any other refusal shows the Mac's words.
        /// </summary>
        private async Task SendAnswer(InteractionPresentation answered, byte[] wav)
        {
            if (client == null || session == null || console == null) return;
            var sessionId = session.Id;
            const string saving = "Saving on your Mac…";
            busy = true;
            SayStatus(null);
            console.ShowProcessing(false, saving);
            dialogue?.Show(DialogueStage.Working, saving);
            using var request = new CancellationTokenSource();
            captureRequest = request;
            dialogue?.SetCancelableWait(true);
            // A new event for each answer; a retry after a lost reply reuses it, so the Mac records the answer once.
            var eventId = TaskIds.NewEventId();
            string? reply = null, failure = null;
            try
            {
                reply = await AnswerAsync(answered, eventId, wav, request.Token);
                request.Token.ThrowIfCancellationRequested();
            }
            catch (OperationCanceledException) { failure = "Stopped waiting. The Mac may still record this answer."; }
            catch (ServiceException refused) when (refused.Status == 422 && refused.Code == "no_words")
            {
                failure = TryAnswerAgain("No speech recorded.", answered);
            }
            catch (ServiceException refused) when (refused.Status == 409 && refused.Code == "stale_revision")
            {
                // The task changed on the Mac: present what it has now, never this headset's guess.
                try
                {
                    reply = await client.ReadTaskAsync(answered.TaskId, request.Token);
                    request.Token.ThrowIfCancellationRequested();
                    if (reply == null) failure = refused.Message;
                }
                catch (OperationCanceledException) { failure = "Stopped waiting. The Mac may still record this answer."; }
                catch (ServiceException unread) { failure = unread.Message; }
                catch (Exception) { failure = "Couldn't get the reply. The Mac may still finish this turn. Reconnect before trying again."; }
            }
            catch (ServiceException refused) { failure = refused.Message; }
            catch (Exception) { failure = "Couldn't get the reply. The Mac may still finish this turn. Reconnect before trying again."; }
            finally
            {
                if (ReferenceEquals(captureRequest, request)) captureRequest = null;
                dialogue?.SetCancelableWait(false);
                busy = false;
                console.SetBusy(false);
            }
            if (session?.Id != sessionId) return;
            if (failure != null || reply == null)
            {
                cancelledWaitNotice = failure ?? "Couldn't get the reply. The Mac may still finish this turn. Reconnect before trying again.";
                ReportFailure(cancelledWaitNotice);
                return;
            }
            RestoreConsole();
            try { PresentTask(reply); }
            catch (ArgumentException)
            {
                cancelledWaitNotice = "The Mac returned an invalid task. Nothing on the headset changed.";
                ReportFailure(cancelledWaitNotice);
                return;
            }
            Debug.Log("Boopy: task answer recorded on the Mac. Not sent.");
        }

        private async Task<string> AnswerAsync(InteractionPresentation answered, string eventId, byte[] wav, CancellationToken cancel)
        {
            try
            {
                return await client!.AnswerTaskAsync(answered.TaskId, answered.SessionId, answered.Revision, eventId, wav, cancel);
            }
            catch (ServiceException lost) when (lost.Code == "connection_lost" && !cancel.IsCancellationRequested)
            {
                // Lost, not refused: the retry is the same event, never a second answer.
                return await client!.AnswerTaskAsync(answered.TaskId, answered.SessionId, answered.Revision, eventId, wav, cancel);
            }
        }

        private bool MicrophoneAllowed()
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            if (!Permission.HasUserAuthorizedPermission(Permission.Microphone))
            {
                Permission.RequestUserPermission(Permission.Microphone);
                dialogue?.Show(DialogueStage.Error, "Allow microphone access, then tap Talk.");
                return false;
            }
#endif
            return true;
        }

        private void BeginTalk(HandInput hand) => BeginTalkInternal(hand, false);

        private void BeginTalkInternal(HandInput hand, bool fromButton, Ray? aim = null)
        {
            if (!inputAllowed || busy || buttonTalk.Recording || !MicrophoneAllowed()) return;
            if (NeedsCaptureRecovery)
            {
                ReportFailure(recoveryStorageFailed ? "Could not read or update capture recovery. Choose New to clear the local record, then try again." : "Check the earlier capture, or choose New. It may still finish on the Mac.");
                return;
            }
            console?.InputPolicy.SetInteractionState(inputAllowed, busy);
            pendingEvidence = console?.InputPolicy.Begin();
            if (pendingEvidence == null) return;
            if (pendingEvidence.RequiresPicture && (room == null || !room.Ready))
            {
                SayStatus("Camera not ready. Allow camera access, then try again.", 6f);
                dialogue?.Show(DialogueStage.Error, "Camera not ready. Allow camera access, then try again.");
                feedback?.Play(AudioCue.Failure);
                console?.InputPolicy.End(); pendingEvidence = null;
                Debug.Log("Boopy: talk blocked reason=camera-not-ready.");
                return;
            }
            cancelledWaitNotice = null;
            captureScan?.Hide();
            pending = null; pendingCues = null; pendingTarget = null;
            active = hand;
            if (session == null || session.State == "committed")
            {
                scene?.Clear();
                if (console != null) scene?.PlaceConsole(console);
            }
            // Resolve the correction target before the listening stage hides review hit areas; a held pinch on the reader aims
            // where it began.
            var ray = aim ?? (hand.RayActive ? hand.Ray : new Ray(head!.position, head.forward));
            var targetId = fromButton ? null : pendingEvidence.SpokenOnly
                ? (console?.ReaderOpen == true ? console.HitTarget(ray, out _) : null)
                : scene?.ChipHitBy(ray, 5f, out _)?.ItemId ?? console?.HitTarget(ray, out _);
            console?.ShowListening(targetId != null);
            dialogue?.Show(DialogueStage.Listening, fromButton ? "Listening… Tap Finish when done." : "Listening… Release to finish.");
            SayStatus(null);
            try
            {
                feedback?.SetRecording(true); voice.Begin();
                if (!voice.Recording)
                {
                    active = null;
                    console?.InputPolicy.End(); pendingEvidence = null;
                    feedback?.SetRecording(false);
                    feedback?.Play(AudioCue.Failure);
                    SayStatus("Microphone unavailable. Allow microphone access in Settings.", 6f);
                    dialogue?.Show(DialogueStage.Error, "Microphone unavailable. Allow microphone access in Settings.");
                    RestoreConsole();
                    Debug.Log("Boopy: talk blocked reason=microphone-unavailable.");
                    return;
                }
                if (fromButton)
                {
                    buttonTalk.Begin(Time.unscaledTime); active = null;
                    console?.SetButtonRecording(true);
                }
                var evidenceTurn = pendingEvidence!;
                pendingTarget = targetId;
                captureReady = false;
                _ = CaptureAfterAcknowledgement(hand, targetId, evidenceTurn, ++captureGeneration, fromButton);

            }
            catch (Exception failure)
            {
                DiscardRecording();
                active = null;
                pending = null;
                pendingCues = null;
                pendingTarget = null;
                console?.InputPolicy.End(); pendingEvidence = null;
                marker?.Hide();
                feedback?.Play(AudioCue.Failure);
                SayStatus("I couldn’t start recording. Let go and try again.", 6f);
                dialogue?.Show(DialogueStage.Error, "I couldn’t start recording. Let go and try again.");
                RestoreConsole();
                Debug.LogWarning($"Boopy: capture failed: {failure.GetType().Name}.");
            }
        }

        private async Task CaptureAfterAcknowledgement(HandInput hand, string? targetId, EvidenceTurn evidenceTurn, int generation, bool fromButton = false)
        {
            using var preparation = new CancellationTokenSource();
            capturePreparation = preparation;
            try
            {
                // Give the actual listening acknowledgement one render opportunity while
                // recording already runs. The saved source pose/time is taken below, not at pinch.
                await Awaitable.NextFrameAsync(preparation.Token);
                if (generation != captureGeneration || (fromButton ? !buttonTalk.Recording : active != hand) || pendingEvidence != evidenceTurn ||
                    !inputAllowed || !isActiveAndEnabled || !voice.Recording) return;
                if (evidenceTurn.RequiresPicture)
                {
                    Capture(hand, targetId, !fromButton);
                    if (pending == null) throw new InvalidOperationException("The capture source is unavailable.");
                    if (scene?.ConsolePlaced == true) captureScan?.Begin(pending, console?.ReducedMotion ?? false);
                }
                else { pending = null; pendingTarget = targetId; pendingCues = new Cues { TargetItemId = targetId }; }
                captureReady = true;
            }
            catch (OperationCanceledException) { }
            catch (Exception failure)
            {
                if (generation != captureGeneration) return;
                DiscardRecording(); active = null; pending = null; pendingCues = null; pendingTarget = null;
                marker?.Hide(); feedback?.Play(AudioCue.Failure);
                console?.ShowError("I couldn’t get a picture. Please try again.");
                dialogue?.Show(DialogueStage.Error, "I couldn’t get a picture. Please try again.");
                Debug.LogWarning($"Boopy: capture failed: {failure.GetType().Name}.");
            }
            finally { if (ReferenceEquals(capturePreparation, preparation)) capturePreparation = null; }
        }

        /// <summary>
        /// The frame and cues after the listening acknowledgement. By the end of the sentence the head
        /// may have moved. The hand's ray wins over head direction.
        /// </summary>
        private void Capture(HandInput hand, string? targetId, bool includePointer = true)
        {
            if (room == null || gaze == null || scene == null) return;
            pendingTarget = targetId;
            pending = room.Capture();
            var cues = new Cues { TargetItemId = pendingTarget };
            if (pending != null)
            {
                var gazeImage = room.ToImage(gaze.Point, pending.Pose);
                if (gazeImage != null)
                {
                    cues.Gaze = new Cue { Point = gazeImage, World = World(gaze.Point), OnSurface = gaze.OnSurface };
                }
                if (includePointer && hand.RayActive && room.TryHit(hand.Ray, 6f, out var handPoint, out _))
                {
                    var handImage = room.ToImage(handPoint, pending.Pose);
                    if (handImage != null)
                    {
                        cues.Pointer = new PointerCue { Point = handImage, World = World(handPoint), OnSurface = true, Hand = hand.Right ? "right" : "left" };
                    }
                    marker?.Show(handPoint, true);
                }
                else
                {
                    marker?.Show(gaze.Point, gaze.OnSurface);
                }
            }
            pendingCues = cues;
        }

        // Constructed on Unity's synchronization context; transport never mutates scene objects.
        private IProgress<TurnProgress> TurnProgressFor(CancellationTokenSource request, string? expectedSession = null) =>
            new Progress<TurnProgress>(progress => ApplyTurnProgress(request, expectedSession, progress));

        private void ApplyTurnProgress(CancellationTokenSource request, string? expectedSession, TurnProgress progress)
        {
            if (!ReferenceEquals(captureRequest, request) || request.IsCancellationRequested || !busy ||
                !inputAllowed || !isActiveAndEnabled || (expectedSession != null && session?.Id != expectedSession)) return;
            // The actual stage goes to the console's processing line; the strip keeps Boopy's thinking phrases.
            console?.ShowTurnProgress(progress);
        }

        // Work on an outlined subject: Boopy goes beside it, faces it, and on arrival lights it with one sweep. A turn
        // without a photo, and a follow-up that names no observation, leave Boopy home. Its eyes and glow still show that it thinks.
        private void VisitSubject(bool picture)
        {
            if (!picture || scene == null || console == null) return;
            var place = scene;
            if (!place.TryGetSubjectVisit(console.transform.position, out var visit, out var anchor, out var outline)) return;
            console.VisitSubject(visit, anchor, outline, () => place.SweepSubject(visit), () => place.SubjectSweepProgress);
        }

        private async Task Send(byte[] wav)
        {
            if (client == null || status == null || scene == null) return;
            busy = true;
            SayStatus(null);
            console?.ShowProcessing(pendingTarget != null);
            var evidenceTurn = pendingEvidence ?? new EvidenceTurn(false);
            dialogue?.ShowThinking(Thinking(evidenceTurn.RequiresPicture));
            VisitSubject(evidenceTurn.RequiresPicture);
            Debug.Log("Boopy: sending capture to Mac.");
            var snapshot = pending;
            using var request = new CancellationTokenSource();
            captureRequest = request;
            dialogue?.SetCancelableWait(true);
            SessionView? speechView = null, taskView = null;
            bool restoreAfterWait = false;
            try
            {
                var speech = new SpeechData { Wav = Convert.ToBase64String(wav) };
                var frame = snapshot?.ToFrame();
                if (frame != null) { frame.Source = "current-surroundings"; frame.TimestampTrusted = false; }
                SessionView view;
                var starting = session == null || session.State == "committed";
                if (starting)
                {
                    if (evidenceTurn.RequiresPicture && snapshot == null)
                    {
                        ReportFailure("The camera is not ready. Allow camera access, then try again.");
                        return;
                    }
                    var start = evidenceTurn.Start(speech, pendingCues ?? new Cues(), frame);
                    start.RequestId = Guid.NewGuid().ToString("D");
                    if (!TryPersistCapture(start.RequestId)) return;
                    unresolvedStartId = start.RequestId;
                    unresolvedSnapshot = snapshot;
                    view = await client.StartStreamingAsync(start, TurnProgressFor(request), request.Token);
                }
                else
                {
                    view = await client.UtterStreamingAsync(session.Id, evidenceTurn.Utter(speech, pendingCues, frame), TurnProgressFor(request, session.Id), request.Token);
                }
                request.Token.ThrowIfCancellationRequested();
                // A recovered start returns the current projection. Its original pixels belong
                // to the first observation, never a later observation from another turn.
                var observation = starting ? view.Observations.FirstOrDefault() : view.Observations.LastOrDefault();
                if (snapshot != null && observation != null) scene.Remember(observation.Id, snapshot);
                if (starting && !ClearCaptureRecovery()) return;
                Apply(view);
                speechView = view;
                // A first turn with Boopy's line on a grounded referent may be the session's task.
                // Its follow-ups wait for the Mac's answer, so they never flash and vanish.
                if (starting && TaskTurn(view)) { taskView = view; console?.ShowTask(null); }
                Debug.Log($"Boopy: received session state={view.State} items={view.Items.Count}.");
            }
            catch (OperationCanceledException)
            {
                restoreAfterWait = true;
                cancelledWaitNotice = "Stopped waiting. The Mac may still finish this capture.";
                ReportFailure(cancelledWaitNotice);
            }
            catch (ServiceException refused)
            {
                Debug.LogWarning($"Boopy: request refused status={refused.Status}.");
                if (refused.Code == "service_unavailable") ClearCaptureRecovery();
                cancelledWaitNotice = refused.Message;
                ReportFailure(refused.Message);
            }
            catch (Exception failure)
            {
                Debug.LogWarning($"Boopy: request failed: {failure.GetType().Name}");
                cancelledWaitNotice = NeedsCaptureRecovery
                    ? "Mac connection lost. Check the earlier capture before starting another."
                    : "Couldn't get the reply. The Mac may still finish this turn. Reconnect before trying again.";
                ReportFailure(cancelledWaitNotice);
            }
            finally
            {
                captureRequest = null;
                dialogue?.SetCancelableWait(false);
                busy = false;
                console?.SetBusy(false);
                pending = null;
                pendingEvidence = null; console?.InputPolicy.End();
                console?.SetCaptureRecovery(NeedsCaptureRecovery);
                marker?.Hide();
                if (restoreAfterWait && isActiveAndEnabled && inputAllowed && dialogue?.gameObject.activeSelf == false && cancelledWaitNotice != null) ReportFailure(cancelledWaitNotice);
            }
            if (speechView != null) _ = Speak(speechView);
            if (taskView != null) _ = OpenTask(taskView);
        }

        /// <summary>A tap on a card: a proposal becomes confirmed; anything else goes back to a proposal.</summary>
        private async Task Act(string itemId, string? explicitAction = null)
        {
            StopSpeech();
            if (client == null || session == null || session.State == "committed" || busy || NeedsCaptureRecovery) return;
            var item = session.Items.FirstOrDefault(candidate => candidate.Id == itemId);
            if (item == null) return;
            busy = true;
            console?.SetBusy(true);
            try
            {
                var action = explicitAction ?? (item.Status == "proposed" ? "confirm" : "reset");
                Apply(await client.ActAsync(session.Id, new ActionRequest { ItemId = itemId, Action = action }));
            }
            catch (ServiceException refused)
            {
                ReportFailure(refused.Message);
            }
            catch (Exception)
            {
                ReportFailure("Mac connection lost. Reconnect USB and try again.");
            }
            finally
            {
                busy = false;
                console?.SetBusy(false);
            }
        }

        /// <summary>
        /// One task view on the parts already in the scene: the chip on the outlined subject, the
        /// docked dialogue line with "Not sent" in its speaker line, and at most one control under it.
        /// The view must belong to the current session. A view with neither its chip and line, an
        /// answer, nor the wrong-item status gives the session's own presentation back.
        /// </summary>
        public void PresentTask(string json)
        {
            var presented = InteractionPresentation.Read(json);
            if (session == null || presented.SessionId != session.Id)
                throw new ArgumentException("The task belongs to another session.");
            if (!presented.Presentable)
            {
                var shown = task != null;
                EndTask();
                if (shown && inputAllowed && isActiveAndEnabled) Apply(session);
                return;
            }
            task = presented;
            if (inputAllowed && isActiveAndEnabled) ShowTask();
        }

        private void ShowTask()
        {
            var shown = PresentedTask;
            if (shown == null) return;
            scene?.PresentTask(shown);
            dialogue?.SetComfort(console?.ComfortScale ?? 1f, console?.ReducedMotion ?? false);
            dialogue?.ShowTask(shown.SpeakerLine, shown.Caption);
            console?.ShowTask(shown.AnswerLabel);
            dialogue?.SetFallback(scene != null && !scene.ConsolePlaced);
        }

        private void EndTask()
        {
            var shown = task != null;
            task = null;
            if (shown) scene?.PresentTask(null);
            console?.EndTask();
        }

        // The Mac decides whether a task exists. The headset asks only when the first turn ends
        // with Boopy's line, no choice on that line, and a referent grounded on an observation.
        private static bool TaskTurn(SessionView view)
        {
            var latest = view.Utterances.LastOrDefault()?.Id;
            var referent = view.Items.FirstOrDefault(item => item.Id == view.ReferentId);
            return view.State == "review" && !string.IsNullOrWhiteSpace(latest) && view.Dialogue != null
                && view.Dialogue.Speaker == "boopy" && view.Dialogue.UtteranceId == latest
                && !string.IsNullOrWhiteSpace(view.Dialogue.Text) && view.Dialogue.Choice == null
                && referent != null && !ContextReview.IsExcluded(referent) && referent.Grounding.ObservationId != null;
        }

        /// <summary>
        /// Ask the Mac for the session's task and present it. No task, or any failure, keeps the
        /// session's own presentation and shows no error. A lost reply is asked again with the same
        /// ids, which is the same open.
        /// </summary>
        private async Task OpenTask(SessionView view)
        {
            if (client == null) { console?.EndTask(); return; }
            if (taskSessionId != view.Id)
            {
                taskSessionId = view.Id; taskOpenEventId = TaskIds.NewEventId(); taskOpenId = TaskIds.NewTaskId();
            }
            taskOpen?.Cancel();
            using var opening = new CancellationTokenSource();
            taskOpen = opening;
            string? json = null;
            try
            {
                try { json = await client.OpenTaskAsync(view.Id, taskOpenEventId!, taskOpenId!, opening.Token); }
                catch (ServiceException lost) when (lost.Code == "connection_lost" && !opening.IsCancellationRequested)
                {
                    json = await client.OpenTaskAsync(view.Id, taskOpenEventId!, taskOpenId!, opening.Token);
                }
            }
            catch (OperationCanceledException) { return; }
            catch (Exception failure) { Debug.Log($"Boopy: no task for this turn ({failure.GetType().Name})."); }
            finally { if (ReferenceEquals(taskOpen, opening)) taskOpen = null; }
            // A later turn, a tap or a new recording owns the presentation now.
            if (!ReferenceEquals(session, view)) return;
            InteractionPresentation? opened = null;
            try { if (json != null) opened = InteractionPresentation.Read(json); }
            catch (ArgumentException) { }
            if (opened == null || opened.SessionId != view.Id || !opened.Presentable || busy || voice.Recording || buttonTalk.Recording)
            {
                console?.EndTask();
                return;
            }
            task = opened;
            Debug.Log("Boopy: task presented on the selected subject. Not sent.");
            if (inputAllowed && isActiveAndEnabled) ShowTask();
        }

        private void Apply(SessionView view)
        {
            cancelledWaitNotice = null;
            StopSpeech();
            // Only the same view, applied again after focus or enable, keeps its task. A new view,
            // such as a later Talk turn, returns to the session's own presentation.
            var keepTask = task != null && ReferenceEquals(view, session) && task.SessionId == view.Id;
            if (!keepTask) EndTask();
            if (!inputAllowed || !isActiveAndEnabled) { session = view; return; }
            var acknowledgement = AudioFeedback.ForTransition(session, view);
            if (acknowledgement != null) feedback?.Play(acknowledgement.Value);
            var newConversation = session?.Id != view.Id;
            if (newConversation) handoffReturnSession = null;
            if (session?.Id != view.Id || (handoffSelection != null && handoffSelection.PackageId != view.Committed?.PackageId))
            {
                StopHandoffWait(); handoffSelection = null; handoffSubmitted = false; handoffState = "not-prepared";
            }
            session = view;
            if (handoffRecoveryRecord != null && handoffRecoveryRecord.SessionId != view.Id) handoffRecoveryOffered = true;
            console?.Render(view);
            console?.SetHandoffState(handoffState, handoffSelection?.RequestId);
            UpdateHandoffRecoveryPresentation();
            dialogue?.SetComfort(console?.ComfortScale ?? 1f, console?.ReducedMotion ?? false);
            var latestTurn = view.Utterances.LastOrDefault()?.Id;
            var response = view.Dialogue != null && view.Dialogue.UtteranceId == latestTurn && view.Dialogue.Speaker == "boopy"
                ? view.Dialogue.Text : view.Notice;
            var interpretationFailure = view.InterpretationFailure;
            var failedInterpretation = interpretationFailure != null && !string.IsNullOrWhiteSpace(latestTurn)
                && interpretationFailure.UtteranceId == latestTurn
                && (interpretationFailure.Code == "interpreter_unavailable" || interpretationFailure.Code == "interpreter_failed");
            if (failedInterpretation && view.State != "committed")
            {
                console?.ShowInterpretationFailure(interpretationFailure!.Message);
                dialogue?.Show(DialogueStage.Error, interpretationFailure.Message);
            }
            else if (view.State == "committed") dialogue?.Show(DialogueStage.LocalSave,
                view.Utterances.LastOrDefault()?.Kind == "commit" && !string.IsNullOrWhiteSpace(response)
                    ? response! : console?.HandoffStatusWords ?? "Context kept on your Mac. Not sent yet.");
            else if (view.Attention != null && view.Attention.UtteranceId == latestTurn &&
                (view.Attention.Action == "clarify" || view.Attention.Action == "fresh-view"))
                dialogue?.Show(view.Attention.Action == "clarify" ? DialogueStage.Clarification : DialogueStage.FreshView,
                    response ?? view.Attention.Reason);
            else if (!string.IsNullOrWhiteSpace(response)) dialogue?.Show(DialogueStage.Response, response!);
            else dialogue?.Hide();
            if (view.State == "committed" && scene != null && pocket != null)
            {
                SayStatus(null);
                scene.Boop(pocket, () => { });
                return;
            }
            scene?.Render(view);
            dialogue?.SetFallback(scene != null && !scene.ConsolePlaced);
            SayStatus(!ContextReview.CanSave(view) && view.Model == null && view.Attention?.Action != "no-visual-work" && string.IsNullOrWhiteSpace(response)
                ? "I didn’t get an answer. Please try again." : null, 8f);
            if (keepTask) ShowTask();
        }

        private ConsoleAction ControlHit(Ray ray, out Vector3 point)
        {
            point = default;
            var fallbackAction = dialogue?.HitFallbackAction(ray, out point) ?? ConsoleAction.None;
            if (fallbackAction != ConsoleAction.None) return fallbackAction;

            return console == null ? ConsoleAction.None : console.HitAction(ray, out point);
        }

        private bool ReleaseControl(HandInput hand)
        {
            if (pendingControl == ConsoleAction.None) return false;
            var control = pendingControl;
            var releaseRay = pendingUsesHandRay ? hand.Ray : new Ray(head!.position, head.forward);
            var stillTargeted = (!pendingUsesHandRay || hand.RayActive) && ControlHit(releaseRay, out _) == control;
            pendingControl = ConsoleAction.None;
            console?.SetPressed(false);
            dialogue?.PressFallbackAction(false);

            active = null;
            if (!stillTargeted) { pendingTarget = null; console?.ClearFocus(); return true; }
            if (control == ConsoleAction.Talk) BeginTalkInternal(hand, true);
            else if (control == ConsoleAction.AnswerTask) BeginAnswer();
            else if (control == ConsoleAction.FinishTalk) { if (buttonTalk.Recording) FinishRecording(); }
            else if (control == ConsoleAction.Cancel)
            {
                if (buttonTalk.Recording)
                {
                    // A cancelled recording, an answer or a Talk turn, gives back the task's line.
                    DiscardRecording(); marker?.Hide(); RestoreConsole();
                    ShowTask();
                }
                else captureRequest?.Cancel();
            }
            else if(control==ConsoleAction.PauseScene) {
                liveScenePaused=!liveScenePaused;
                PlayerPrefs.SetInt("Boopy.LiveScenePaused",liveScenePaused?1:0);
                liveHud?.SetPaused(liveScenePaused);
                console?.SetScenePaused(liveScenePaused);
                if(liveScenePaused)liveRequest?.Cancel();
            }
            else if (control == ConsoleAction.CheckCapture) _ = CheckCapture();
            else if (control == ConsoleAction.DismissCapture) { if (console?.HandoffRecoveryVisible == true) DismissHandoffRecovery(); else DismissCapture(); }
            else if (control == ConsoleAction.SendChoice) _ = Choose(control);
            else if (control == ConsoleAction.FollowUpOne || control == ConsoleAction.FollowUpTwo) _ = FollowUp(control);
            else if (control == ConsoleAction.Save) _ = Commit();
            else if (control == ConsoleAction.Back && handoffReturnSession != null) RestoreHandoffReturn();
            else if (control == ConsoleAction.Handoff)
            {
                console?.Activate(control);
                _ = handoffRecoveryOffered || handoffStorageFailed ? RecoverHandoff() : CheckHandoff();
                if (console != null) scene?.PlaceConsole(console);
            }
            else if (control == ConsoleAction.Confirm && pendingTarget != null) _ = Act(pendingTarget);
            else if (control == ConsoleAction.ToggleIncluded && pendingTarget != null)
            {
                var item = session?.Items.FirstOrDefault(value => value.Id == pendingTarget);
                if (item != null) _ = Act(pendingTarget, ContextReview.InclusionAction(item));
            }
            else if (console != null)
            {
                console.Activate(control);
                feedback?.SetEnabled(inputAllowed && console.SoundEnabled);
                scene?.SetReducedMotion(console.ReducedMotion);
                dialogue?.SetComfort(console.ComfortScale, console.ReducedMotion);
                // Resizing or opening a reader is an explicit action. Re-reserve its measured
                // extent before placing annotations; hover alone never rearranges the scene.
                if (session != null && session.State != "committed") scene?.Render(session);
                else scene?.PlaceConsole(console);
                if (control == ConsoleAction.Options && console.ContextObstructed)
                {
                    dialogue?.SetFallback(scene?.ConsolePlaced == false);
                    SayStatus("Look toward a clear space to open Context.", 4f);
                }
            }
            return true;
        }

        private void RestoreConsole()
        {
            if (busy) return;
            if (session == null) console?.ShowCapture();
            else
            {
                console?.Render(session);
                if (session.State != "committed" && scene != null && !scene.ConsolePlaced && console != null) console.ShowControlsOnly(console.transform.position);
            }
        }

        private void RestoreCaptureRecovery()
        {
            try
            {
                unresolvedStartId = (recoveryStore ?? throw new InvalidOperationException("Recovery storage is unavailable.")).Load();
                unresolvedSnapshot = null;
                recoveryStorageFailed = false;
                if (unresolvedStartId != null)
                    cancelledWaitNotice = "Boopy restarted before it heard back from your Mac. The picture is gone from the headset.";
            }
            catch (Exception)
            {
                recoveryStorageFailed = true;
                cancelledWaitNotice = "Could not read capture recovery. Choose New to clear the local record. Earlier work may still exist on the Mac.";
            }
            console?.SetCaptureRecovery(NeedsCaptureRecovery);
            if (NeedsCaptureRecovery && cancelledWaitNotice != null) ReportFailure(cancelledWaitNotice);
        }

        private bool TryPersistCapture(string identity)
        {
            try
            {
                (recoveryStore ?? throw new InvalidOperationException("Recovery storage is unavailable.")).Save(identity);
                recoveryStorageFailed = false;
                return true;
            }
            catch (Exception)
            {
                recoveryStorageFailed = true;
                cancelledWaitNotice = "Could not keep capture recovery on the headset. No new capture was sent. Choose New, then try again.";
                ReportFailure(cancelledWaitNotice);
                console?.SetCaptureRecovery(true);
                return false;
            }
        }

        private bool ClearCaptureRecovery()
        {
            try { (recoveryStore ?? throw new InvalidOperationException("Recovery storage is unavailable.")).Clear(); }
            catch (Exception)
            {
                recoveryStorageFailed = true;
                cancelledWaitNotice = "Could not clear the headset recovery record. Check again or choose New; earlier work stays on the Mac.";
                ReportFailure(cancelledWaitNotice);
                console?.SetCaptureRecovery(true);
                return false;
            }
            unresolvedStartId = null;
            unresolvedSnapshot = null;
            recoveryStorageFailed = false;
            console?.SetCaptureRecovery(false);
            return true;
        }

        private void DismissCapture()
        {
            if (busy || !NeedsCaptureRecovery || !ClearCaptureRecovery()) return;
            cancelledWaitNotice = null;
            console?.ShowCapture();
            if (console != null) scene?.PlaceConsole(console);
            SayStatus(null);
            RequestPermissions();
            dialogue?.Show(DialogueStage.Response, "Ready for a new capture. The earlier capture may still finish on the Mac.");
        }

        /// <summary>Explicitly check one uncertain start; never resubmit it or play an old response.</summary>
        private async Task CheckCapture()
        {
            if (busy || !inputAllowed || !isActiveAndEnabled || client == null || !NeedsCaptureRecovery) return;
            if (unresolvedStartId == null)
            {
                RestoreCaptureRecovery();
                return;
            }
            StopSpeech();
            var identity = unresolvedStartId;
            var snapshot = unresolvedSnapshot;
            busy = true;
            SayStatus(null);
            console?.ShowCheckingCapture();
            dialogue?.Show(DialogueStage.Working, "Checking…");
            using var request = new CancellationTokenSource();
            captureRequest = request;
            dialogue?.SetCancelableWait(true);
            try
            {
                var receipt = await client.ReadStartAsync(identity, request.Token);
                request.Token.ThrowIfCancellationRequested();
                if (unresolvedStartId != identity || receipt.RequestId != identity || string.IsNullOrWhiteSpace(receipt.SessionId))
                    throw new InvalidOperationException("Capture identity mismatch.");
                if (receipt.Status == "succeeded" && !string.IsNullOrWhiteSpace(receipt.SessionId) &&
                    receipt.View != null && receipt.View.Id == receipt.SessionId)
                {
                    var observation = receipt.View.Observations.FirstOrDefault();
                    if (snapshot != null && observation != null) scene?.Remember(observation.Id, snapshot);
                    if (!ClearCaptureRecovery()) return;
                    Apply(receipt.View);
                    if (snapshot == null && receipt.View.State != "committed") dialogue?.Show(DialogueStage.Response, "Your earlier conversation is back. Object positions are unavailable after restart.");
                    return;
                }
                var words = receipt.Status == "pending" ? "The Mac is still working. Check again later, or choose New."
                    : receipt.Status == "failed" ? "The earlier capture failed on the Mac. Choose New to capture again."
                    : receipt.Status == "interrupted" ? "The Mac restarted before the capture finished. Choose New to capture again."
                    : "Could not verify this capture. Reconnect USB and check again.";
                cancelledWaitNotice = words;
                ReportFailure(words);
            }
            catch (OperationCanceledException)
            {
                cancelledWaitNotice = "Stopped checking. The earlier capture may still finish on the Mac.";
                ReportFailure(cancelledWaitNotice);
            }
            catch (ServiceException failure) when (failure.Status == 404)
            {
                cancelledWaitNotice = "The Mac returned no receipt for this capture. Check again later, or choose New.";
                ReportFailure(cancelledWaitNotice);
            }
            catch (Exception)
            {
                cancelledWaitNotice = "Could not verify this capture. Reconnect USB and check again, or choose New.";
                ReportFailure(cancelledWaitNotice);
            }
            finally
            {
                captureRequest = null;
                dialogue?.SetCancelableWait(false);
                busy = false;
                console?.SetBusy(false);
                console?.SetCaptureRecovery(NeedsCaptureRecovery);
            }
        }

        // A lost connection or a timeout is not the Mac's own refusal: Boopy did not hear back, so the service's words for a capture
        // do not fit a choice.
        private static bool Unheard(ServiceException failure) => failure.Code == "connection_lost" || failure.Code == "request_timeout";

        private async Task Choose(ConsoleAction control)
        {
            if (client == null || session == null || console == null || busy || NeedsCaptureRecovery || !inputAllowed || !isActiveAndEnabled) return;
            var selection = console.SelectedChoice(control);
            if (selection == null) return;
            var prior = session; var sending = false;
            // Boopy did not hear back: before the send the person can choose again; from the send on the Mac may still answer.
            const string unheardBefore = "Boopy didn't hear back from your Mac. Reconnect, then choose again.";
            const string unheard = "Boopy didn't hear back from your Mac. The Mac may still finish this choice. Reconnect, then Talk to answer.";
            StopSpeech(); busy = true; console.SetBusy(true);
            console.ShowProcessing(false); dialogue?.ShowThinking(Thinking(false));
            using var request = new CancellationTokenSource(); captureRequest = request;
            dialogue?.SetCancelableWait(true);
            SessionView? speechView = null;
            // Before the send nothing was answered: the card stays. The headset's own line comes back with it, and the words
            // show over it for a moment.
            void Offer(string words)
            {
                feedback?.Play(AudioCue.Failure);
                console?.Render(prior); dialogue?.Show(DialogueStage.Response, prior.Dialogue!.Text); dialogue?.ShowNotice(words, 5f);
            }
            try
            {
                // One tap sends the option shown: the Mac records it as the selection, then answers it.
                await client.SelectChoiceAsync(prior.Id, selection, request.Token);
                request.Token.ThrowIfCancellationRequested();
                // A selection overtaken by a newer request, or answered after focus left, is never sent.
                if (!ReferenceEquals(captureRequest, request) || !inputAllowed || !isActiveAndEnabled || !ReferenceEquals(session, prior)) return;
                // From the send on the card is gone, so it is never sent twice.
                console.SuppressDispatchedChoice(); sending = true;
                var returned = await client.SubmitChoiceStreamingAsync(prior.Id, selection, TurnProgressFor(request, prior.Id), request.Token);
                request.Token.ThrowIfCancellationRequested();
                if (!ReferenceEquals(captureRequest, request) || !inputAllowed || !isActiveAndEnabled || !ReferenceEquals(session, prior)) return;
                Apply(returned);
                speechView = returned;
            }
            catch (OperationCanceledException) when (ReferenceEquals(captureRequest, request) && ReferenceEquals(session, prior) && !sending) { Offer("Stopped waiting. You can choose again."); }
            catch (ServiceException failure) when (ReferenceEquals(captureRequest, request) && ReferenceEquals(session, prior) && !sending)
            {
                // The Mac says the choice is no longer available: offered again it would be refused the same way, so it goes, as
                // from the send on.
                if (failure.Code == "stale_choice") { console.SuppressDispatchedChoice(); cancelledWaitNotice = failure.Message; ReportFailure(failure.Message); }
                else Offer(Unheard(failure) ? unheardBefore : failure.Message);
            }
            catch (Exception) when (ReferenceEquals(captureRequest, request) && ReferenceEquals(session, prior) && !sending) { Offer(unheardBefore); }
            catch (OperationCanceledException) when (ReferenceEquals(captureRequest, request) && ReferenceEquals(session, prior)) { cancelledWaitNotice = "Stopped waiting. The Mac may still finish this choice."; ReportFailure(cancelledWaitNotice); }
            catch (ServiceException failure) when (ReferenceEquals(captureRequest, request) && ReferenceEquals(session, prior)) { cancelledWaitNotice = Unheard(failure) ? unheard : failure.Message; ReportFailure(cancelledWaitNotice); }
            catch (Exception) when (ReferenceEquals(captureRequest, request) && ReferenceEquals(session, prior)) { cancelledWaitNotice = unheard; ReportFailure(cancelledWaitNotice); }
            catch (Exception) { /* A replaced request cannot change the current presentation. */ }
            finally { if (ReferenceEquals(captureRequest, request)) { captureRequest = null; dialogue?.SetCancelableWait(false); busy = false; console.SetBusy(false); } }
            if (speechView != null && ReferenceEquals(session, speechView) && inputAllowed && isActiveAndEnabled) _ = Speak(speechView);
        }

        private async Task FollowUp(ConsoleAction control)
        {
            if (client == null || session == null || console == null || busy || NeedsCaptureRecovery || !inputAllowed || !isActiveAndEnabled) return;
            var suggestion = console.SuggestedAction(control);
            var origin = session.Dialogue;
            if (suggestion == null || origin == null) return;
            var priorSession = session.Id;
            console.SuppressSuggestions();
            StopSpeech();
            busy = true;
            SayStatus(null);
            console.ShowProcessing(suggestion.TargetItemId != null);
            // A follow-up works on the recorded view only when it names an observation.
            dialogue?.ShowThinking(Thinking(suggestion.ObservationId != null));
            VisitSubject(suggestion.ObservationId != null);
            using var request = new CancellationTokenSource();
            captureRequest = request;
            dialogue?.SetCancelableWait(true);
            SessionView? speechView = null;
            try
            {
                var returned = await client.FollowUpStreamingAsync(priorSession, origin, suggestion, TurnProgressFor(request, priorSession), request.Token);
                request.Token.ThrowIfCancellationRequested();
                if (!inputAllowed || !isActiveAndEnabled || session?.Id != priorSession) return;
                Apply(returned);
                speechView = returned;
            }
            catch (OperationCanceledException)
            {
                cancelledWaitNotice = "Stopped waiting. The Mac may still finish this question.";
                ReportFailure(cancelledWaitNotice);
            }
            catch (ServiceException failure) { cancelledWaitNotice = failure.Message; ReportFailure(failure.Message); }
            catch (Exception)
            {
                cancelledWaitNotice = "The reply is unavailable. The Mac may still finish this question. Reconnect before asking again.";
                ReportFailure(cancelledWaitNotice);
            }
            finally
            {
                captureRequest = null;
                dialogue?.SetCancelableWait(false);
                busy = false;
                console.SetBusy(false);
            }
            if (speechView != null) _ = Speak(speechView);
        }

        private void UpdateHandoffRecoveryPresentation() => console?.SetHandoffRecovery(
            handoffRecoveryRecord != null || handoffStorageFailed, handoffRecoveryOffered,
            handoffRecoveryRecord?.PackageId, handoffRecoveryRecord?.RequestId, handoffStorageFailed);
        private void RestoreHandoffRecovery()
        {
            try
            {
                handoffRecoveryRecord = (handoffRecoveryStore ?? throw new InvalidOperationException()).Load();
                handoffStorageFailed = false; handoffRecoveryOffered = handoffRecoveryRecord != null;
            }
            catch (Exception) { handoffStorageFailed = true; handoffRecoveryOffered = true; }
            UpdateHandoffRecoveryPresentation();
            if (!NeedsCaptureRecovery && (handoffRecoveryOffered || handoffStorageFailed))
                dialogue?.Show(DialogueStage.Clarification, handoffStorageFailed
                    ? "Could not read preparation recovery. Open Context to dismiss only this headset record. Context stays on your Mac."
                    : "An earlier preparation needs checking. Open Context. Nothing has been sent.");
        }
        private bool TryPersistHandoff(HandoffRecoveryRecord record)
        {
            if (handoffStorageFailed) { ShowHandoffStorageError(); return false; }
            try
            {
                (handoffRecoveryStore ?? throw new InvalidOperationException()).Save(record);
                handoffRecoveryRecord = record; UpdateHandoffRecoveryPresentation(); return true;
            }
            catch (Exception) { handoffStorageFailed = true; handoffRecoveryOffered = true; ShowHandoffStorageError(); return false; }
        }
        private void ShowHandoffStorageError()
        {
            handoffState = "interrupted";
            console?.SetHandoffState(handoffState, handoffRecoveryRecord?.RequestId);
            UpdateHandoffRecoveryPresentation();
            if (inputAllowed && isActiveAndEnabled)
                dialogue?.Show(DialogueStage.Error, "Could not keep preparation recovery. No new preparation was sent. Open Context to dismiss only this headset record; context stays on your Mac.");
        }
        private void DismissHandoffRecovery()
        {
            if (busy) return;
            try { (handoffRecoveryStore ?? throw new InvalidOperationException()).Clear(); }
            catch (Exception) { handoffStorageFailed = true; ShowHandoffStorageError(); return; }
            handoffRecoveryRecord = null; handoffStorageFailed = false; handoffRecoveryOffered = false;
            UpdateHandoffRecoveryPresentation(); console?.Activate(ConsoleAction.Back);
            RestoreHandoffReturn();
            dialogue?.Show(DialogueStage.LocalSave, "Only this headset recovery record was cleared. Context stays on your Mac. Nothing has been sent.");
        }
        private void RestoreHandoffReturn()
        {
            if (busy || handoffReturnSession == null) return;
            var prior = handoffReturnSession; handoffReturnSession = null;
            handoffRecoveryOffered = handoffRecoveryRecord != null && handoffRecoveryRecord.SessionId != prior.Id;
            scene?.Clear(); Apply(prior); UpdateHandoffRecoveryPresentation();
        }
        private async Task RecoverHandoff()
        {
            if (client == null || busy || !inputAllowed || !isActiveAndEnabled || NeedsCaptureRecovery) return;
            if (handoffStorageFailed || handoffRecoveryRecord == null) { ShowHandoffStorageError(); return; }
            StopSpeech(); var anchor = handoffRecoveryRecord; var generation = ++handoffGeneration;
            using var wait = new CancellationTokenSource(); wait.CancelAfter(TimeSpan.FromSeconds(45));
            handoffWait = wait; captureRequest = wait; busy = true;
            handoffState = "checking"; console?.SetHandoffState(handoffState, anchor.RequestId);
            console?.SetBusy(true); dialogue?.Show(DialogueStage.Working, "Checking earlier preparation…"); dialogue?.SetCancelableWait(true);
            try
            {
                var restored = await client.ReadSessionAsync(anchor.SessionId, wait.Token);
                wait.Token.ThrowIfCancellationRequested();
                if (generation != handoffGeneration || !inputAllowed || !isActiveAndEnabled || handoffRecoveryRecord != anchor) return;
                if (restored.Id != anchor.SessionId || (anchor.PackageId != null && restored.Committed?.PackageId != anchor.PackageId))
                    throw new InvalidOperationException("Recovery identity mismatch.");
                // Explicit checking restores the exact conversation without any room pose or microphone replay.
                if (session != null && session.Id != restored.Id && handoffReturnSession == null) handoffReturnSession = session;
                scene?.Clear(); session = restored; console?.Render(restored); scene?.Render(restored);
                console?.Activate(ConsoleAction.Handoff); console?.SetHandoffState("checking", anchor.RequestId); console?.SetBusy(true);
                var packageId = restored.Committed?.PackageId;
                if (packageId == null)
                {
                    handoffRecoveryOffered = false; handoffState = "not-prepared"; UpdateHandoffRecoveryPresentation();
                    Apply(restored);
                    if (restored.InterpretationFailure == null) dialogue?.Show(DialogueStage.Response, "Your earlier context is back. Object positions are unavailable after restart. Use this context only when you are ready.");
                    return;
                }
                if (!TryPersistHandoff(new HandoffRecoveryRecord { SessionId = anchor.SessionId, RequestId = anchor.RequestId, PackageId = packageId })) return;
                handoffSelection = new HandoffRequest { RequestId = anchor.RequestId, PackageId = packageId };
                HandoffStatus receipt;
                try { receipt = await client.ReadHandoffAsync(anchor.SessionId, handoffSelection, wait.Token); }
                catch (ServiceException missing) when (missing.Status == 404)
                {
                    wait.Token.ThrowIfCancellationRequested();
                    if (!CurrentHandoff(generation, anchor.SessionId) || handoffRecoveryRecord?.RequestId != anchor.RequestId) return;
                    handoffSubmitted = false; handoffRecoveryOffered = false;
                    ShowHandoff("missing", generation, anchor.SessionId); UpdateHandoffRecoveryPresentation(); return;
                }
                wait.Token.ThrowIfCancellationRequested();
                if (!CurrentHandoff(generation, anchor.SessionId) || handoffRecoveryRecord?.RequestId != anchor.RequestId) return;
                handoffSubmitted = true; handoffRecoveryOffered = false; UpdateHandoffRecoveryPresentation();
                if (receipt.State == "preparing-local") ShowHandoff("preparing-local", generation, anchor.SessionId);
                while (receipt.State == "preparing-local")
                {
                    await Task.Delay(handoffPollMilliseconds, wait.Token);
                    receipt = await client.ReadHandoffAsync(anchor.SessionId, handoffSelection, wait.Token);
                    wait.Token.ThrowIfCancellationRequested();
                    if (!CurrentHandoff(generation, anchor.SessionId) || handoffRecoveryRecord?.RequestId != anchor.RequestId) return;
                }
                wait.Token.ThrowIfCancellationRequested();
                ShowHandoff(receipt.State == "prepared-local" ? receipt.SourceState == "changed" ? "changed" : "prepared-local" : "failed", generation, anchor.SessionId);
            }
            catch (OperationCanceledException)
            {
                // A check can end before the earlier session becomes current. Do not gate
                // its terminal presentation on CurrentHandoff, or leave a finished GET shimmering.
                if (generation == handoffGeneration && inputAllowed && isActiveAndEnabled)
                {
                    handoffState = "interrupted";
                    console?.SetHandoffState(handoffState, anchor.RequestId);
                    UpdateHandoffRecoveryPresentation();
                    dialogue?.Show(DialogueStage.Error, "Preparation status unknown. Check again. Nothing has been sent.");
                }
            }
            catch (Exception)
            {
                if (generation == handoffGeneration && inputAllowed && isActiveAndEnabled)
                {
                    handoffRecoveryOffered = true; handoffState = "interrupted";
                    console?.SetHandoffState(handoffState, anchor.RequestId);
                    UpdateHandoffRecoveryPresentation();
                    dialogue?.Show(DialogueStage.Error, "Could not verify the earlier preparation. Context stays on your Mac. Check again or dismiss only this headset record.");
                }
            }
            finally
            {
                if (ReferenceEquals(handoffWait, wait))
                {
                    handoffWait = null; if (ReferenceEquals(captureRequest, wait)) captureRequest = null; busy = false;
                    if (generation == handoffGeneration && inputAllowed && isActiveAndEnabled) { console?.SetBusy(false); dialogue?.SetCancelableWait(false); }
                }
            }
        }

        private Task Commit() => PrepareContext(true);
        private Task CheckHandoff() => PrepareContext(false);

        private async Task PrepareContext(bool commit)
        {
            StopSpeech();
            if (client == null || session == null || busy || NeedsCaptureRecovery || !inputAllowed || !isActiveAndEnabled
                || (commit ? !ContextReview.CanSave(session) : session.Committed == null)) return;
            var sessionId = session.Id;
            var replaceChangedSelection = !commit && handoffState == "changed";
            var explicitPreparation = commit || handoffState == "not-prepared" || handoffState == "missing"
                || handoffState == "failed" || handoffState == "changed";
            if (handoffStorageFailed) { ShowHandoffStorageError(); return; }
            var identity = !replaceChangedSelection && handoffRecoveryRecord?.SessionId == sessionId
                ? handoffRecoveryRecord.RequestId : Guid.NewGuid().ToString("D");
            var anchor = new HandoffRecoveryRecord { SessionId = sessionId, RequestId = identity,
                PackageId = commit ? null : session.Committed?.PackageId };
            if (!TryPersistHandoff(anchor)) return;
            var generation = ++handoffGeneration;
            using var wait = new CancellationTokenSource(); wait.CancelAfter(TimeSpan.FromSeconds(45));
            handoffWait = wait; captureRequest = wait; busy = true;
            handoffState = "preparing-local"; console?.SetHandoffState(handoffState, handoffSelection?.RequestId);
            console?.SetBusy(true); SayStatus(null); dialogue?.SetCancelableWait(true);
            if (commit) dialogue?.Show(DialogueStage.Working, "Preparing context…");
            try
            {
                if (commit)
                {
                    var committed = await client.CommitAsync(sessionId, wait.Token);
                    wait.Token.ThrowIfCancellationRequested();
                    if (!CurrentHandoff(generation, sessionId)) return;
                    Apply(committed);
                    // Rendering the committed package must not unlock interaction during preparation.
                    console?.SetBusy(true);
                }
                var packageId = session?.Committed?.PackageId;
                if (string.IsNullOrEmpty(packageId)) throw new InvalidOperationException("Missing committed context.");
                if (replaceChangedSelection || handoffSelection == null || handoffSelection.PackageId != packageId)
                {
                    handoffSelection = new HandoffRequest { RequestId = identity, PackageId = packageId };
                    handoffSubmitted = false;
                }
                var selection = handoffSelection;
                if (!TryPersistHandoff(new HandoffRecoveryRecord { SessionId = sessionId, RequestId = selection.RequestId, PackageId = packageId })) return;
                handoffRecoveryOffered = false; UpdateHandoffRecoveryPresentation();
                ShowHandoff("preparing-local", generation, sessionId);
                HandoffStatus receipt;
                if (handoffSubmitted)
                {
                    var readExistingStatus = false;
                    try { receipt = await client.ReadHandoffAsync(sessionId, selection, wait.Token); readExistingStatus = true; }
                    catch (ServiceException missing) when (missing.Status == 404)
                    {
                        wait.Token.ThrowIfCancellationRequested();
                        if (!CurrentHandoff(generation, sessionId)) return;
                        if (!explicitPreparation) { ShowHandoff("missing", generation, sessionId); return; }
                        receipt = await client.PrepareHandoffAsync(sessionId, selection, wait.Token);
                    }
                    wait.Token.ThrowIfCancellationRequested();
                    if (!CurrentHandoff(generation, sessionId) || session?.Committed?.PackageId != selection.PackageId) return;
                    if (readExistingStatus && receipt.State == "failed" && explicitPreparation) receipt = await client.PrepareHandoffAsync(sessionId, selection, wait.Token);
                }
                else
                {
                    if (!explicitPreparation) { ShowHandoff("missing", generation, sessionId); return; }
                    handoffSubmitted = true;
                    receipt = await client.PrepareHandoffAsync(sessionId, selection, wait.Token);
                }
                while (receipt.State == "preparing-local")
                {
                    wait.Token.ThrowIfCancellationRequested();
                    if (!CurrentHandoff(generation, sessionId)) return;
                    await Task.Delay(handoffPollMilliseconds, wait.Token);
                    receipt = await client.ReadHandoffAsync(sessionId, selection, wait.Token);
                }
                wait.Token.ThrowIfCancellationRequested();
                if (!CurrentHandoff(generation, sessionId) || session?.Committed?.PackageId != selection.PackageId) return;
                ShowHandoff(receipt.State == "prepared-local" ? receipt.SourceState == "changed" ? "changed" : "prepared-local" : "failed", generation, sessionId);
            }
            catch (OperationCanceledException)
            {
                ShowHandoff("interrupted", generation, sessionId);
            }
            catch (ServiceException failure)
            {
                ShowHandoff(failure.Code == "connection_lost" || failure.Code == "request_timeout" ? "interrupted" : "failed", generation, sessionId);
            }
            catch (Exception) { ShowHandoff("failed", generation, sessionId); }
            finally
            {
                if (ReferenceEquals(handoffWait, wait))
                {
                    handoffWait = null;
                    if (ReferenceEquals(captureRequest, wait)) captureRequest = null;
                    busy = false;
                    if (CurrentHandoff(generation, sessionId)) { console?.SetBusy(false); dialogue?.SetCancelableWait(false); }
                }
            }
        }
        private bool CurrentHandoff(int generation, string sessionId) => generation == handoffGeneration
            && session?.Id == sessionId && inputAllowed && isActiveAndEnabled;
        private void ShowHandoff(string state, int generation, string sessionId)
        {
            if (!CurrentHandoff(generation, sessionId)) return;
            handoffState = state; console?.SetHandoffState(state, handoffSelection?.RequestId);
            dialogue?.Show((state == "preparing-local" || state == "checking") ? DialogueStage.Working : DialogueStage.LocalSave, console?.HandoffStatusWords ?? "Context kept on your Mac. Not sent yet.");
            if (console != null) scene?.PlaceConsole(console);
        }
        private void StopHandoffWait()
        {
            if (handoffWait == null) return;
            handoffGeneration++; handoffWait.Cancel();
            if (ReferenceEquals(captureRequest, handoffWait)) captureRequest = null;
            handoffWait = null; busy = false; handoffState = "interrupted";
            console?.SetHandoffState(handoffState, handoffSelection?.RequestId); console?.SetBusy(false);
        }

        private void DiscardRecording()
        {
            captureScan?.Hide();
            answeringTask = false;
            buttonTalk.End(); console?.SetButtonRecording(false);
            captureGeneration++; captureReady = false; capturePreparation?.Cancel();
            voice.Discard();
            pendingEvidence = null; console?.InputPolicy.End();
            if (dialogue?.Stage == DialogueStage.Listening) dialogue.Hide();
            feedback?.SetRecording(false);
        }

        private void ReportFailure(string words)
        {
            captureScan?.Hide();
            if (!inputAllowed || !isActiveAndEnabled) return;
            dialogue?.Show(DialogueStage.Error, words);
            console?.ShowError(words);
            feedback?.Play(AudioCue.Failure);
            if (session != null && session.State == "review") scene?.Render(session);
            else if (console != null) scene?.PlaceConsole(console);
            SayStatus(scene?.ConsolePlaced == true ? null : words, 6f);
        }

        private void StopSpeech()
        {
            speechGeneration++;
            speechRequest?.Cancel();
            speechPlayback?.Stop();
            console?.SetSpeaking(0f);
            console?.SetVoicePreparing(false);
        }
        private void OnDisable()
        {
            StopHandoffWait();
            healthCheck?.Cancel(); healthGeneration++;
            liveRequest?.Cancel(); liveHud?.SetActive(false, console?.ReducedMotion ?? false);
            captureRequest?.Cancel(); StopSpeech(); DiscardRecording(); dialogue?.Hide();
        }
        private void OnEnable()
        {
            if (!busy && inputAllowed && cancelledWaitNotice != null) ReportFailure(cancelledWaitNotice);
            else if (!busy && inputAllowed && session != null) Apply(session);
        }
        private async Task Speak(SessionView returned)
        {
            var response = returned.Dialogue;
            if (!isActiveAndEnabled || client == null || response == null || response.Speaker != "boopy" ||
                !returned.SpeechOutputAvailable || console?.VoiceEnabled != true || busy || voice.Recording || !inputAllowed)
                return;
            var generation = speechGeneration;
            using var request = new CancellationTokenSource();
            speechRequest = request;
            console?.SetVoicePreparing(true);
            try
            {
                var audio = await client.SpeechAsync(returned.Id, new SpeechOutputRequest
                { UtteranceId = response.UtteranceId, ResponseAt = response.At }, request.Token);
                request.Token.ThrowIfCancellationRequested();
                if (!isActiveAndEnabled || generation != speechGeneration || busy || voice.Recording || !inputAllowed || console?.VoiceEnabled != true ||
                    session?.Id != returned.Id || session.Dialogue?.At != response.At ||
                    session.Dialogue?.UtteranceId != response.UtteranceId ||
                    audio.SessionId != returned.Id || audio.UtteranceId != response.UtteranceId ||
                    audio.ResponseAt != response.At || audio.Speaker != "boopy" || audio.MimeType != "audio/wav") return;
                if (audio.Wav.Length > ((SpeechPlayback.MaxBytes + 2) / 3) * 4) throw new FormatException();
                console?.SetVoicePreparing(false);
                speechPlayback?.Play(Convert.FromBase64String(audio.Wav));
            }
            catch (OperationCanceledException) { }
            catch (Exception)
            {
                if (isActiveAndEnabled && generation == speechGeneration && inputAllowed)
                    SayStatus("Voice unavailable. The text response is still here.", 5f);
            }
            finally
            {
                if (ReferenceEquals(speechRequest, request))
                {
                    speechRequest = null;
                    console?.SetVoicePreparing(false);
                }
            }
        }

        private static float[] World(Vector3 point) => new[] { point.x, point.y, point.z };
    }
}
