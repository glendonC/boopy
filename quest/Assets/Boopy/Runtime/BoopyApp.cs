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
    }
}
