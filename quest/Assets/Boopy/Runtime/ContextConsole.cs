#nullable enable
using System.Collections.Generic;
using System.Linq;
using Boopy.Client;
using TMPro;
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>Independent status, selected evidence and save modules. Full sources open only on request.</summary>
    public sealed class ContextConsole : MonoBehaviour
    {
        private readonly EvidenceNavigator navigator = new EvidenceNavigator();
        private readonly Dictionary<ConsoleAction, SpatialAction> actions = new Dictionary<ConsoleAction, SpatialAction>();
        private SpatialSurface? header, card, dock, options, bar;
        private Transform? head;
        private TextMeshPro? itemCount, pageCount;
        private DialogueStrip? dockedDialogue;
        private bool voicePreparing, openingGreeted;
        private string connectionState = "checking";
        private bool? liveSceneAvailable;
        private bool speechAvailable, buttonRecording;
        private BoxCollider? headerHit, evidenceHit;
        private CompanionOrb? companion;
        private SessionView? view;
        private bool captureRecovery, dialogueVisible, controlsOnly;
        private bool handoffRecordAvailable, handoffRecoveryOffered, handoffStorageFailed;
        private string? recoveryPackageId, recoveryPreparationId;
        public bool HandoffRecoveryVisible => handoffOpen && handoffRecordAvailable;
        public void SetHandoffRecovery(bool available, bool offered, string? packageId, string? requestId, bool storageFailed)
        {
            handoffRecordAvailable = available; handoffRecoveryOffered = offered; handoffStorageFailed = storageFailed;
            recoveryPackageId = packageId; recoveryPreparationId = requestId;
            Compose(); Assemble();
        }
        private readonly List<ContextualAction> suggestions = new List<ContextualAction>();
        private string? suppressedSuggestionSession, suppressedSuggestionUtterance, suppressedSuggestionAt;
        private readonly Dictionary<ConsoleAction, string> shownSuggestionIds = new Dictionary<ConsoleAction, string>();
        private string? dismissedChoiceId, dismissedChoiceSession, nextTurnInstruction;
        // A presented task owns the answer's group: its one control, or none.
        private bool taskShown;
        private string? taskActionLabel;
        private bool settingsOpen;
        private float conversationPanelHeight;
        private string? suppressedCardSession, suppressedCardId;
        private bool keepChoiceVisible;
        private bool busy, reduced, optionsOpen, actionsOpen, interactionLocked, readerOpen, savePreview, handoffOpen;
        private string mode = "";
        private string recoveryErrorWords = "";
        private string processingWords = "Thinking…";
        private float requestAt;
        private float animationTime;
        private ConsoleAction focused;
        private int overflow;
        private float height;
        public bool SoundEnabled { get; private set; } = true;
        public bool VoiceEnabled { get; private set; }
        private bool voicePreferred = true;
        public EvidenceInputPolicy InputPolicy { get; } = new EvidenceInputPolicy();
        public float ComfortScale { get; private set; } = 1f;
        public float LayoutCenterOffset => (height - (bar?.Size.y ?? 0f)) * .5f * ComfortScale;
        public Vector2 LayoutSize => new Vector2(SpatialTheme.Width + SpatialTheme.KeepoutMargin * 2f, height + SpatialTheme.KeepoutMargin * 2f) * ComfortScale;
        public string? SelectedItemId => navigator.Selected?.Id;
        public bool Reading => readerOpen || savePreview || handoffOpen || (optionsOpen && !settingsOpen && !controlsOnly);
        public bool SavePreviewOpen => savePreview;
        public bool ReaderOpen => readerOpen;
        public bool ReducedMotion => reduced;
        public bool ContextObstructed => controlsOnly && optionsOpen && !settingsOpen;
        public bool HasVisibleBar => bar != null && bar.gameObject.activeInHierarchy;
        public bool HasFocus => focused != ConsoleAction.None;
        public bool InteractionLocked => interactionLocked;
        public bool CaptionHasTrailingAction => actions.TryGetValue(ConsoleAction.Cancel, out var cancel) && cancel.gameObject.activeInHierarchy && cancel.transform.parent == header?.transform
            || actions.TryGetValue(ConsoleAction.Options, out var more) && more.gameObject.activeInHierarchy && more.transform.parent == header?.transform;
        public bool Reviewing => mode == "review";

        public static ContextConsole Create(Transform parent, Transform head)
        {
            var go = new GameObject("Context instruments"); go.transform.SetParent(parent, false);
            var console = go.AddComponent<ContextConsole>(); console.head = head;
            console.header = SpatialSurface.Create(go.transform, "Intent instrument");
            console.header.SetChrome(false);
            console.header.SetCompanionInset(true);
            console.companion = CompanionOrb.Create(console.header.transform);
            console.card = SpatialSurface.Create(go.transform, "Evidence instrument");
            console.dock = SpatialSurface.Create(go.transform, "Save dock");
            console.options = SpatialSurface.Create(go.transform, "Comfort options");
            console.dock.SetChrome(false);
            console.bar = SpatialSurface.Create(go.transform, "Control bar");
            console.bar.Configure("", "", "", bottomSpace: .060f);
            console.bar.SetChrome(false);
            console.Add(ConsoleAction.Talk, "Talk", console.bar, .112f);
            console.Add(ConsoleAction.FinishTalk, "Finish", console.bar, .112f);
            console.itemCount = SpatialTheme.Text(console.card.transform, "Item position", SpatialTheme.Utility, SpatialTheme.Ivory);
            console.itemCount.alignment = TextAlignmentOptions.Center; console.itemCount.rectTransform.sizeDelta = new Vector2(.10f, .025f);
            console.pageCount = SpatialTheme.Text(console.card.transform, "Text position", SpatialTheme.Utility, SpatialTheme.Ivory);
            console.pageCount.alignment = TextAlignmentOptions.Center; console.pageCount.rectTransform.sizeDelta = new Vector2(.10f, .025f);
            console.Add(ConsoleAction.PreviousItem, "Previous", console.card, .132f);
            console.Add(ConsoleAction.NextItem, "Next", console.card, .132f);
            console.Add(ConsoleAction.ToggleDetails, "Source", console.card, .115f);
            console.Add(ConsoleAction.Confirm, "Confirm", console.card, .125f);
            console.Add(ConsoleAction.ToggleIncluded, "Exclude", console.card, .125f);
            console.Add(ConsoleAction.PreviousText, "Earlier", console.card, .132f);
            console.Add(ConsoleAction.NextText, "Read more", console.card, .160f);
            console.Add(ConsoleAction.PrepareSave, "Prepare context", console.dock, .300f);
            console.Add(ConsoleAction.UseCurrentView, "Use current view", console.dock, .245f);
            console.Add(ConsoleAction.UseSpokenOnly, "Without a photo", console.dock, .175f);
            console.Add(ConsoleAction.CheckCapture, "Check capture", console.dock, .210f);
            console.Add(ConsoleAction.DismissCapture, "Start new", console.dock, .145f);
            console.Add(ConsoleAction.Save, "Use this context", console.dock, .270f);
            console.Add(ConsoleAction.Back, "Back", console.dock, .145f);
            console.Add(ConsoleAction.Handoff, "Use context", console.dock, .210f);
            console.Add(ConsoleAction.Review, "Conversation", console.dock, .400f);
            console.Add(ConsoleAction.ChoiceOne, "", console.dock, .400f);
            console.Add(ConsoleAction.ChoiceTwo, "", console.dock, .400f);
            console.Add(ConsoleAction.ChoiceThree, "", console.dock, .400f);
            console.Add(ConsoleAction.SendChoice, "Send to Boopy", console.dock, .400f);
            console.Add(ConsoleAction.FollowUpOne, "", console.dock, .400f);
            console.Add(ConsoleAction.FollowUpTwo, "", console.dock, .400f);
            console.Add(ConsoleAction.AnswerTask, "", console.dock, .400f);
            console.Add(ConsoleAction.Options, "Context", console.bar, .128f);
            console.Add(ConsoleAction.PauseScene, "Pause", console.bar, .132f);
            console.Add(ConsoleAction.Actions, "Actions", console.dock, .240f);
            console.Add(ConsoleAction.Settings, "Settings", console.bar, .132f);
            console.Add(ConsoleAction.Size, "Size: standard", console.options, .200f);
            console.Add(ConsoleAction.Sound, "Sound: on", console.options, .200f);
            console.Add(ConsoleAction.Speech, "Voice: off", console.options, .200f);
            console.Add(ConsoleAction.EvidenceSource, "Include photo: on", console.options, .400f);
            console.Add(ConsoleAction.Motion, "Motion: full", console.options, .200f);
            console.Add(ConsoleAction.Cancel, "Stop", console.bar, .128f);
            console.headerHit = console.header.gameObject.AddComponent<BoxCollider>();
            console.evidenceHit = console.card.gameObject.AddComponent<BoxCollider>();
            if (Application.isPlaying)
            {
                console.SoundEnabled = PlayerPrefs.GetInt("Boopy.Sound", 1) != 0;
                console.LoadVoicePreference();
                console.reduced = PlayerPrefs.GetInt("Boopy.Motion", 1) == 0;
                console.ComfortScale = PlayerPrefs.GetInt("Boopy.LargeText", 0) == 1 ? 1.2f : 1f;
            }
            console.ShowCapture(); console.bar.Assemble(0f, console.reduced); return console;
        }

        /// <summary>
        /// A task takes the answer's own group: the session's follow-ups, choice and evidence choice
        /// give way, and the task's one control, when it has one, sits directly under the dialogue
        /// line where the follow-ups go. Null draws no control. The global bar does not change.
        /// </summary>
        public void ShowTask(string? actionLabel)
        {
            taskShown = true; taskActionLabel = actionLabel;
            Compose();
        }

        /// <summary>The session's own answer group returns.</summary>
        public void EndTask()
        {
            if (!taskShown) return;
            taskShown = false; taskActionLabel = null;
            Compose();
        }

        public bool TaskShown => taskShown;

        public void SetScenePaused(bool paused) => actions[ConsoleAction.PauseScene].Label(paused ? "Resume" : "Pause");
        public void SetLiveSceneCapability(bool? available) { liveSceneAvailable = available; Compose(); }

        public void SetConnectionStatus(string status, bool available)
        {
            connectionState = status == "connected" ? "connected" : status == "unavailable" ? "unavailable" : "checking";
            // A refresh in progress does not override an existing explicit voice choice.
            if (connectionState != "checking") { speechAvailable = available; VoiceEnabled = available && voicePreferred; }
            if (mode == "capture") ConfigureOpening();
            Compose();
        }
        public void SetButtonRecording(bool recording) { buttonRecording = recording; Compose(); }
        public bool TryGreetOpening()
        {
            if (openingGreeted || connectionState != "connected" || mode != "capture" || view != null || busy
                || captureRecovery || handoffRecordAvailable || handoffRecoveryOffered || handoffStorageFailed
                || dialogueVisible || controlsOnly || companion == null || header == null
                || !isActiveAndEnabled || !gameObject.activeInHierarchy || !header.gameObject.activeInHierarchy || header.Opacity < .95f) return false;
            openingGreeted = true;
            companion.Greet();
            return true;
        }
        private void ConfigureOpening()
        {
            var words = connectionState == "checking" ? "Connecting to your Mac…"
                : connectionState == "unavailable" ? "Connect the headset by USB.\nStart Boopy on your Mac."
                : "Hi, I’m Boopy. Show me what you want kept.";
            header?.Configure("", connectionState == "connected" ? "" : "Boopy", words, .145f);
        }

        private void LoadVoicePreference() => voicePreferred = PlayerPrefs.GetInt("Boopy.Voice", 1) != 0;
        private void SaveVoicePreference() { PlayerPrefs.SetInt("Boopy.Voice", voicePreferred ? 1 : 0); PlayerPrefs.Save(); }

        private void Add(ConsoleAction action, string label, SpatialSurface parent, float width)
            => actions.Add(action, SpatialAction.Create(parent.transform, action, label, width));
        public void Place(Vector3 point) { transform.position = point; gameObject.SetActive(true); if(controlsOnly) { controlsOnly=false; Compose(); } Face(); }
        public void ShowControlsOnly(Vector3 point) { transform.position=point; controlsOnly=true; gameObject.SetActive(true); Compose(); Face(); }
        public void AttendTo(Vector3 worldPoint, bool objectAttention = false)
        {
            if (companion == null) return;
            var direction = companion.transform.InverseTransformPoint(worldPoint);
            if (objectAttention) companion.FlyToward(direction);
            else { companion.ReturnHome(); companion.SetAttention(direction); }
        }
        public void SetSelectedAccent(int? slot)
        {
            if (card == null) return;
            var accent = slot.HasValue ? ObjectAccents.Color(slot.Value) : default;
            card.SetIdentityAccent(slot.HasValue && readerOpen && !savePreview && !handoffOpen
                ? new Color(accent.X, accent.Y, accent.Z, 1f) : (Color?)null);
        }
        public void SetCaptureRecovery(bool available)
        {
            if (captureRecovery == available) return;
            captureRecovery = available;
            if (available) { actionsOpen = false; optionsOpen = false; readerOpen = false; savePreview = false; handoffOpen = false; ClearFocus(); header?.Configure("", "Capture status", string.IsNullOrEmpty(recoveryErrorWords) ? header.BodyText : recoveryErrorWords, .145f); }
            Compose(); Assemble();
        }
        public void Hide() { companion?.SetVisible(false); gameObject.SetActive(false); }
        /// <summary>Reserve the full subtitle paging target above actual visible global surfaces.
        /// The shared console pose also preserves its interaction lock and large-text scale.</summary>
        public bool TryFallbackPose(float halfHeight, out Vector3 position, out Quaternion rotation)
        {
            position = default; rotation = transform.rotation;
            if (!HasVisibleBar) return false;
            var top = float.NegativeInfinity;
            foreach (var surface in new[] { bar, options })
                if (surface != null && surface.gameObject.activeInHierarchy)
                    top = Mathf.Max(top, surface.transform.localPosition.y + surface.Size.y / 2f);
            position = transform.TransformPoint(new Vector3(0, top + SpatialTheme.Gap + halfHeight, -.008f));
            return true;
        }
        public void SetInteractionLocked(bool locked) => interactionLocked = locked;
        public void DockDialogue(DialogueStrip strip) { dockedDialogue = strip; strip.DockTo(header!, this); }
        public void SetDialogueVisible(bool visible)
        {
            dialogueVisible = visible;
            header?.SetTextVisible(!visible);
            Compose();
        }
        public void SetSpeaking(float activity) => companion?.SetSpeaking(activity);
        public void SetVoicePreparing(bool preparing)
        {
            voicePreparing = preparing;
            // This independent wait never locks Talk or changes the returned answer.
            dockedDialogue?.SetVoicePreparing(preparing);
            companion?.SetState(preparing ? "processing" : busy && mode != "processing" ? "processing" : mode == "capture" ? "idle" : mode);
        }
        public void SetCompanionFrozen(bool frozen) => companion?.SetFrozen(frozen);
        public void SetReducedMotion(bool on) { reduced = on; Assemble(); }
        public void ShowCapture(string? target = null) { Stage("capture", "", ""); ConfigureOpening(); Compose(); }
        public void ShowListening(bool correcting = false) => Stage("listening", "", "Listening…\nLet go when you’re done.");
        public void ShowProcessing(bool targeted = false) { voicePreparing = false; processingWords = "Sending…"; requestAt = Time.unscaledTime; Stage("processing", "", processingWords); }
        public void ShowTurnProgress(TurnProgress progress)
        {
            // The owning request/generation is checked by BoopyApp before reaching this surface.
            if (mode != "processing" || progress == null) return;
            processingWords = progress.Words;
            header?.SetBody(processingWords);
        }
        public void ShowCheckingCapture() { processingWords = "Checking…"; requestAt = Time.unscaledTime; Stage("processing", "", processingWords); }
        public void ShowInterpretationFailure(string words) => Stage("error", "Could not answer", words);
        public void ShowError(string words)
        {
            recoveryErrorWords = words;
            if (!ContextReview.CanSave(view)) { Stage("error", captureRecovery ? "Capture status" : "Capture needs attention", words); return; }
            busy = false;
            header!.SetTrailingInset(false);
            mode = "review";
            optionsOpen = false;
            header!.Configure("", captureRecovery ? "Capture status" : "", words, captureRecovery ? .145f : .078f);
            Compose();
            Assemble();
            gameObject.SetActive(true);
        }

        private void Stage(string next, string heading, string words)
        {
            var changed = mode != next; mode = next; busy = next == "processing"; actionsOpen = false; optionsOpen = false; savePreview = false; handoffOpen = false;
            if (next == "listening" || next == "processing") readerOpen = false;
            header!.SetTrailingInset(false);
            header.Configure("", heading, words, .145f);
            Compose(); if (changed) Assemble(); gameObject.SetActive(true);
        }

        public void Render(SessionView returned)
        {
            var newSession = view?.Id != returned.Id;
            var referentChanged = !string.IsNullOrWhiteSpace(returned.ReferentId) && view?.ReferentId != returned.ReferentId;
            if (newSession) { handoffState = "not-prepared"; handoffRequestId = null; }
            view = returned; busy = false;
            speechAvailable = connectionState != "unavailable" && returned.SpeechOutputAvailable;
            VoiceEnabled = speechAvailable && voicePreferred;
            if (newSession) { optionsOpen = false; settingsOpen = false; actionsOpen = false; readerOpen = false; savePreview = false; handoffOpen = false; taskShown = false; taskActionLabel = null; }
            if (!ContextReview.CanSave(returned)) savePreview = false;
            if (returned.Committed != null) { readerOpen = false; savePreview = false; }
            header!.SetTrailingInset(false);
            var preferred = newSession || referentChanged || navigator.Selected == null ? returned.ReferentId : null;
            navigator.SetItems(returned.Items, preferred);
            mode = returned.Committed != null ? "saved" : (ContextReview.CanSave(returned) || returned.Dialogue?.Choice?.Supported == true) ? "review" : "error";
            if (mode == "saved") header!.Configure("", "", HandoffStatusWords, .145f);
            else if (mode == "error") header!.Configure("", "", returned.Notice ?? "I couldn’t work that out. Please try again.", .076f);
            else header!.Configure("", "", returned.Dialogue?.Choice?.Supported == true ? returned.Dialogue.Text : "Talk to continue.", .145f);
            if (ChoiceDismissed()) header.Configure("Next turn", "", nextTurnInstruction ?? "Talk to continue.", .145f);
            if (navigator.DetailsOpen) Pages();
            Compose(); Assemble(); gameObject.SetActive(true);
        }
    }
}
