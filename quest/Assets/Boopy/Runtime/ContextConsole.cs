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
        // The shelf's controls; More swaps it in place to Context, Settings and Back.
        private static readonly ConsoleAction[] Shelved = { ConsoleAction.Talk, ConsoleAction.AnswerTask, ConsoleAction.FinishTalk, ConsoleAction.PauseScene,
            ConsoleAction.Cancel, ConsoleAction.Options, ConsoleAction.More, ConsoleAction.ShelfBack };
        private bool moreOpen;
        // The recovery dialog's panel: the line's dark backing, drawn on the header while the dialog shows.
        private MeshRenderer? dialogBacking;
        private Mesh? dialogMesh;
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
            // Sheets and cards take the line's column, as Boopy's line and its words do.
            console.card.SetColumn(true); console.options.SetColumn(true);
            console.dock.SetChrome(false);
            console.bar = SpatialSurface.Create(go.transform, "Control bar");
            // The shelf's surface is exactly one control tall, so the panel above it sits one gap above the controls.
            console.bar.Configure("", "", "", bottomSpace: SpatialTheme.Target - 2f * SpatialTheme.Padding);
            console.bar.SetChrome(false);
            console.Add(ConsoleAction.Talk, "Talk", console.bar, SpatialTheme.ShelfSlot);
            console.Add(ConsoleAction.FinishTalk, "Finish", console.bar, SpatialTheme.ShelfSlot);
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
            console.Add(ConsoleAction.CheckCapture, "Check", console.dock, SpatialTheme.ShelfSlot);
            console.Add(ConsoleAction.DismissCapture, "New", console.dock, SpatialTheme.ShelfSlot);
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
            console.Add(ConsoleAction.AnswerTask, "", console.bar, SpatialTheme.ShelfSlot);
            console.Add(ConsoleAction.Options, "Context", console.bar, SpatialTheme.ShelfSlot);
            console.Add(ConsoleAction.PauseScene, "Pause", console.bar, SpatialTheme.ShelfSlot);
            console.Add(ConsoleAction.Actions, "Actions", console.dock, .240f);
            console.Add(ConsoleAction.Settings, "Settings", console.bar, SpatialTheme.ShelfSlot);
            console.Add(ConsoleAction.More, "More", console.bar, SpatialTheme.ShelfSlot);
            console.Add(ConsoleAction.ShelfBack, "Back", console.bar, SpatialTheme.ShelfSlot);
            console.Add(ConsoleAction.Size, "Size: standard", console.options, .200f);
            console.Add(ConsoleAction.Sound, "Sound: on", console.options, .200f);
            console.Add(ConsoleAction.Speech, "Voice: off", console.options, .200f);
            console.Add(ConsoleAction.EvidenceSource, "Include photo: on", console.options, .400f);
            console.Add(ConsoleAction.Motion, "Motion: full", console.options, .200f);
            console.Add(ConsoleAction.Cancel, "Stop", console.bar, SpatialTheme.ShelfSlot);
            var dialogPlate = new GameObject("Dialog backing"); dialogPlate.transform.SetParent(console.header.transform, false);
            console.dialogMesh = RoundedPlate.Create(1f, 1f, .06f);
            dialogPlate.AddComponent<MeshFilter>().sharedMesh = console.dialogMesh;
            console.dialogBacking = dialogPlate.AddComponent<MeshRenderer>(); console.dialogBacking.sharedMaterial = Visuals.Solid;
            console.dialogBacking.sortingOrder = 0; console.dialogBacking.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            console.dialogBacking.enabled = false;
            var panel = new MaterialPropertyBlock(); panel.SetColor("_Color", SpatialTheme.Panel); console.dialogBacking.SetPropertyBlock(panel);
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
            if (available) { actionsOpen = false; optionsOpen = false; readerOpen = false; savePreview = false; handoffOpen = false; ClearFocus(); header?.Configure("", "Earlier capture", string.IsNullOrEmpty(recoveryErrorWords) ? header.BodyText : recoveryErrorWords, .145f); }
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
        public void ShowProcessing(bool targeted = false, string words = "Sending…") { voicePreparing = false; processingWords = words; Stage("processing", "", processingWords); }
        public void ShowTurnProgress(TurnProgress progress)
        {
            // The owning request/generation is checked by BoopyApp before reaching this surface.
            if (mode != "processing" || progress == null) return;
            processingWords = progress.Words;
            header?.SetBody(processingWords);
        }
        public void ShowCheckingCapture() { processingWords = "Checking…"; Stage("processing", "", processingWords); }
        public void ShowInterpretationFailure(string words) => Stage("error", "Could not answer", words);
        public void ShowError(string words)
        {
            recoveryErrorWords = words;
            if (!ContextReview.CanSave(view)) { Stage("error", captureRecovery ? "Earlier capture" : "Capture needs attention", words); return; }
            busy = false;
            header!.SetTrailingInset(false);
            mode = "review";
            optionsOpen = false;
            header!.Configure("", captureRecovery ? "Earlier capture" : "", words, captureRecovery ? .145f : .078f);
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

        private void Compose()
        {
            if (header == null || card == null || dock == null || options == null || bar == null || evidenceHit == null || headerHit == null) return;
            header.gameObject.SetActive(true);
            if(conversationPanelHeight > 0f) header.Configure("", "", header.BodyText, .145f);
            // Under a docked line the panel starts from its own words' height each time, so a line alone and a line with rows
            // each end one gap above the shelf; a height reserved earlier never lingers.
            else if (dialogueVisible && dockedDialogue != null) header.Configure(header.StateText, header.TitleText, header.BodyText, .145f);
            conversationPanelHeight = 0f; dockedDialogue?.SetConversationContentHeight(0f);
            var recoveryOffered = captureRecovery && !busy && mode != "listening" && mode != "processing";
            // The recovery dialog speaks on the panel itself: no line and no speaker over it. Hiding the line composes again.
            if (recoveryOffered && dockedDialogue != null && dockedDialogue.gameObject.activeSelf) { dockedDialogue.Hide(); return; }
            var evidenceOffered = !captureRecovery && !busy && (mode == "review" || mode == "error") && ChoiceAvailable() && !taskShown;
            var reviewing = mode == "review";
            RefreshSuggestions();
            shownSuggestionIds.Clear();
            card.gameObject.SetActive(!recoveryOffered && !evidenceOffered && (savePreview || handoffOpen || (reviewing && readerOpen && navigator.Selected != null)));
            dock.gameObject.SetActive(mode == "processing" || ((mode != "capture" || recoveryOffered || handoffOpen) && mode != "listening" && (!busy || keepChoiceVisible)));
            options.gameObject.SetActive(!recoveryOffered && !evidenceOffered && optionsOpen && (dock.gameObject.activeSelf || mode == "capture"));
            foreach (var action in actions.Values) action.gameObject.SetActive(false);
            if (dialogBacking != null) dialogBacking.enabled = false;
            actions[ConsoleAction.Handoff].Label(handoffRecoveryOffered ? "Check earlier"
                : handoffState == "prepared-local" ? "Preparation status" : handoffState == "changed" ? "Prepare again"
                : handoffState == "not-prepared" || handoffState == "missing" ? "Prepare context"
                : handoffState == "failed" ? "Retry preparation" : "Check preparation");
            foreach (var action in new[] { ConsoleAction.Review, ConsoleAction.PrepareSave, ConsoleAction.Handoff, ConsoleAction.CheckCapture, ConsoleAction.DismissCapture })
                actions[action].transform.SetParent(dock.transform, false);
            itemCount!.gameObject.SetActive(card.gameObject.activeSelf && !savePreview && !handoffOpen && !navigator.DetailsOpen);
            pageCount!.gameObject.SetActive(card.gameObject.activeSelf && !savePreview && !handoffOpen && navigator.DetailsOpen);
            if (card.gameObject.activeSelf && !savePreview && !handoffOpen)
            {
                var selected = navigator.Selected!;
                var state = ChipStyles.For(selected, false).Tag;
                var words = navigator.DetailsOpen ? navigator.CurrentPage ?? "No additional evidence." : selected.Statement;
                card.Configure(navigator.DetailsOpen ? "Source" : state, selected.Label, words,
                    navigator.DetailsOpen ? .116f : .066f, .130f, maxTitleHeight: .044f);
                // Stable mode capacity prevents hover inspection from moving action targets.
                SetCardCapacity(navigator.DetailsOpen ? .370f : .310f);
                itemCount.text = $"{navigator.ItemIndex + 1} of {navigator.ItemCount}";
                pageCount.text = $"Page {navigator.PageIndex + 1} of {navigator.PageCount}";
                var bottom = -card.Size.y / 2f;
                Put(ConsoleAction.PreviousItem, -.144f, bottom + .102f, !navigator.DetailsOpen && navigator.HasPreviousItem);
                Put(ConsoleAction.NextItem, .144f, bottom + .102f, !navigator.DetailsOpen && navigator.HasNextItem);
                itemCount.transform.localPosition = new Vector3(0, bottom + .102f, -.005f);
                Put(ConsoleAction.ToggleDetails, -.135f, bottom + .035f, true);
                actions[ConsoleAction.ToggleDetails].Label(navigator.DetailsOpen ? "Back" : "Source");
                Put(ConsoleAction.Confirm, .135f, bottom + .035f, navigator.DetailsOpen && navigator.CanConfirmSelected);
                Put(ConsoleAction.ToggleIncluded, .135f, bottom + .035f, !navigator.DetailsOpen);
                actions[ConsoleAction.ToggleIncluded].Label(ContextReview.IsExcluded(selected) ? "Include" : "Exclude");
                if (navigator.DetailsOpen)
                {
                    Put(ConsoleAction.PreviousText, -.144f, bottom + .102f, navigator.HasPreviousPage);
                    Put(ConsoleAction.NextText, .130f, bottom + .102f, navigator.HasNextPage);
                    pageCount.transform.localPosition = new Vector3(-.006f, bottom + .102f, -.005f);
                }
                evidenceHit.center = new Vector3(0, .062f, -.004f);
                evidenceHit.size = new Vector3(card.Size.x, Mathf.Max(.060f, card.Size.y - .150f), .012f);
                evidenceHit.enabled = !busy;
            }
            if (savePreview || handoffOpen)
            {
                card.Configure(savePreview ? "Destination · your Mac" : "For your agent",
                    savePreview ? "Prepare context" : handoffState == "prepared-local" && !handoffRecoveryOffered ? "Ready on your Mac" : "Your selected context",
                    savePreview ? ContextReview.SaveSummary(view!) :
                    ManualHandoffWords(),
                    handoffOpen ? .300f : .180f, .015f, maxTitleHeight: .055f);
                evidenceHit.enabled = false;
            }
            if (dock.gameObject.activeSelf)
            {
                var questionRows = reviewing && !readerOpen && !savePreview && !handoffOpen && !optionsOpen && !recoveryOffered && !evidenceOffered;
                var choice = questionRows ? ActiveChoice() : null;
                var rowHeights = choice == null ? suggestions.Select((suggestion, index) => ConfigureQuestion(index == 0 ? ConsoleAction.FollowUpOne : ConsoleAction.FollowUpTwo, suggestion.Question)).ToArray() : System.Array.Empty<float>();
                var questionHeight = questionRows ? rowHeights.Sum() + SpatialTheme.Gap * rowHeights.Length : 0f;
                dock.Configure("", "", "", bottomSpace: choice == null ? questionHeight + .070f : .015f);
                if (mode == "processing") { }
                else if (recoveryOffered)
                {
                    // A dialog on the panel: its title and one sentence. Its actions, Check and New, lead the row under it.
                    header.Configure("", "Earlier capture", string.IsNullOrEmpty(recoveryErrorWords) ? header.BodyText : recoveryErrorWords, .145f);
                    var column = SpatialTheme.ShelfLeft + SpatialTheme.ShelfWidth / 2f;
                    // The line's dark panel behind the dialog: across the text column with the line's 12 mm side margin, from
                    // the panel's top to its bottom edge, so it too ends one gap above the row.
                    if (dialogBacking != null)
                    {
                        dialogBacking.transform.localPosition = new Vector3(column, 0f, .006f);
                        dialogBacking.transform.localScale = new Vector3(SpatialTheme.ShelfWidth + .024f, header.Size.y, 1f);
                        dialogBacking.enabled = true;
                    }
                    dock.gameObject.SetActive(false);
                }
                else if (evidenceOffered)
                {
                    Put(ConsoleAction.UseCurrentView, -.0975f, 0, true);
                    Put(ConsoleAction.UseSpokenOnly, .120f, 0, true);
                }
                else if (savePreview || handoffOpen)
                {
                    Put(ConsoleAction.Back, -.130f, 0, true);
                    Put(ConsoleAction.Save, .095f, 0, savePreview && ContextReview.CanSave(view) && !busy && !handoffStorageFailed);
                    actions[ConsoleAction.DismissCapture].Label("Dismiss");
                    Put(ConsoleAction.DismissCapture, .095f, 0, handoffOpen && handoffRecordAvailable && !busy);
                }
                else if (reviewing && optionsOpen) { }
                else if (reviewing && readerOpen) Put(ConsoleAction.Review, 0, 0, true);
                else if (reviewing && choice != null)
                {
                    // The option shown is a paragraph of the line. Choose is a tile of the row, named below.
                    dock.gameObject.SetActive(false);
                }
                else if (reviewing && taskActionLabel != null)
                {
                    // The task's line alone on the panel; the Answer tile, labeled with the Mac's prompt, leads the row.
                    actions[ConsoleAction.AnswerTask].Label(taskActionLabel);
                    dock.gameObject.SetActive(false);
                }
                else if (reviewing && suggestions.Count > 0)
                {
                    conversationPanelHeight=rowHeights.Sum()+SpatialTheme.Gap*Mathf.Max(0,rowHeights.Length-1);
                    header.ReserveHeight(dockedDialogue?.ConversationPanelHeight(conversationPanelHeight) ?? .160f+conversationPanelHeight);
                    var top=header.Size.y/2f-.080f+(dockedDialogue?.ConversationAnswerBottom ?? -.064f)-.016f;
                    for(var index=0;index<suggestions.Count;index++)
                    {
                        var control=index==0?ConsoleAction.FollowUpOne:ConsoleAction.FollowUpTwo;
                        actions[control].transform.SetParent(header.transform,false);
                        shownSuggestionIds[control]=suggestions[index].Id;
                        Put(control,.065f,top-rowHeights[index]/2f,true);
                        top-=rowHeights[index]+SpatialTheme.Gap;
                    }
                    dockedDialogue?.SetConversationContentHeight(conversationPanelHeight);
                    dock.gameObject.SetActive(false);
                }

                actions[ConsoleAction.Review].Label(readerOpen ? "Done" : ContextLabel());
                actions[ConsoleAction.PrepareSave].Label("Prepare context");

            }
            if (options.gameObject.activeSelf)
            {
                if (!settingsOpen)
                {
                    var earlier = handoffRecoveryOffered || handoffStorageFailed;
                    var current = ContextReview.CanSave(view) && view?.Committed == null;
                    var extraRow = earlier && current;
                    options.Configure("", "", earlier
                        ? handoffStorageFailed ? "Preparation recovery is unavailable. Dismiss only the headset record; context stays on your Mac."
                            : "An earlier preparation needs checking. Checking restores only that selected context; nothing is sent."
                        : view == null ? "Tell me what you see.\nKeep it on your Mac. Continue online when ready."
                        : ContextReview.ConversationSummary(view) + "\nKeep it on your Mac. Continue online when ready.", maxBodyHeight: .220f,
                        bottomSpace: (extraRow ? .210f : view == null && !earlier ? .015f : .140f) + SettingsRow);
                    var bottom = -options.Size.y / 2f + SettingsRow;
                    SettingsTile(-options.Size.y / 2f);
                    foreach (var action in new[] { ConsoleAction.Review, ConsoleAction.PrepareSave, ConsoleAction.Handoff }) actions[action].transform.SetParent(options.transform, false);
                    Put(ConsoleAction.Review, 0, bottom + (extraRow ? .175f : .105f), navigator.Selected != null);
                    Put(ConsoleAction.PrepareSave, 0, bottom + (extraRow ? .105f : .035f), current && !handoffStorageFailed);
                    Put(ConsoleAction.Handoff, 0, bottom + .035f, earlier || view?.Committed != null);

                }
                else
                {
                    var connectionWords = connectionState == "connected" ? "Boopy is connected to your Mac."
                        : connectionState == "unavailable" ? "Boopy can’t reach your Mac. Check the USB cable."
                        : "Checking the connection to your Mac…";
                    var sceneWords = liveSceneAvailable == true ? "Scene outlines are available."
                        : liveSceneAvailable == false ? "Scene outlines are unavailable." : "Scene outline status is unknown.";
                    var voiceWords = !speechAvailable ? "Voice is unavailable."
                        : VoiceEnabled ? "Voice reads replies aloud." : "Voice is off.";
                    options.Configure("Settings", "", connectionWords + "\n" + sceneWords + "\n" + voiceWords, maxBodyHeight: .180f, bottomSpace: .218f + SettingsRow);
                    var settingsBottom = -options.Size.y / 2f + SettingsRow;
                    SettingsTile(-options.Size.y / 2f);
                    Put(ConsoleAction.Size, -.108f, settingsBottom + .180f, true); Put(ConsoleAction.Sound, .108f, settingsBottom + .180f, true);
                    Put(ConsoleAction.Motion, -.108f, settingsBottom + .109f, true);
                    Put(ConsoleAction.Speech, .108f, settingsBottom + .109f, true);
                    Put(ConsoleAction.EvidenceSource, 0, settingsBottom + .038f, true);
                    actions[ConsoleAction.EvidenceSource].Label(InputPolicy.SpokenOnly ? "Include photo: off" : "Include photo: on");
                    actions[ConsoleAction.Speech].Label(!speechAvailable ? "Voice unavailable" : VoiceEnabled ? "Voice: on" : "Voice: off");
                    actions[ConsoleAction.Speech].SetInteractable(speechAvailable);
                    actions[ConsoleAction.Motion].Label(reduced ? "Motion: reduced" : "Motion: full");
                    actions[ConsoleAction.Size].Label(ComfortScale > 1f ? "Size: large" : "Size: standard");
                    actions[ConsoleAction.Sound].Label(SoundEnabled ? "Sound: on" : "Sound: off");
                }
            }
            // One row of identical tiles under the panel: at most three equal slots, filled from the panel's text column, so
            // the orb stays left of it. The recommended action is the first tile. More swaps the same row in place to
            // Context, Settings and Back.
            foreach(var action in Shelved) actions[action].transform.SetParent(bar.transform,false);
            var asks = reviewing && taskActionLabel != null && !captureRecovery;
            var stop = mode=="processing" || (busy && keepChoiceVisible) || (busy && (handoffState == "preparing-local" || handoffState == "checking"));
            var choiceOnLine = reviewing && !readerOpen && !savePreview && !handoffOpen && !optionsOpen && !recoveryOffered && !evidenceOffered && !controlsOnly ? ActiveChoice() : null;
            // A notice over a line that offers a choice leaves the choice standing: nothing takes its slot until the line returns.
            var choiceUnderNotice = choiceOnLine == null && reviewing && !readerOpen && !savePreview && !handoffOpen && !optionsOpen && !recoveryOffered && !evidenceOffered
                && dockedDialogue?.NoticeShown == true && view?.Dialogue?.Choice?.Supported == true && dockedDialogue.LineText == view.Dialogue.Text;
            if (dockedDialogue != null)
            {
                if (choiceOnLine != null) dockedDialogue.SetItems(choiceOnLine.Options.Select(option => option.Label).ToArray(), true);
                else dockedDialogue.SetItems(System.Array.Empty<string>(), false);
            }
            if (choiceOnLine != null || choiceUnderNotice || busy || captureRecovery || mode=="listening") moreOpen = false;
            // Pause, the privacy stop, keeps slot 2 in every state; each state names its first and third tiles.
            var (first, third) = buttonRecording ? (ConsoleAction.FinishTalk, ConsoleAction.Cancel)
                : stop ? (ConsoleAction.Cancel, ConsoleAction.None)
                : recoveryOffered ? (ConsoleAction.CheckCapture, ConsoleAction.DismissCapture)
                : busy || captureRecovery || mode=="listening" ? (ConsoleAction.None, ConsoleAction.None)
                : moreOpen ? (ConsoleAction.Options, ConsoleAction.ShelfBack)
                : choiceOnLine != null && (dockedDialogue?.ShownItem ?? -1) >= 0 ? (ConsoleAction.Talk, ConsoleAction.SendChoice)
                : choiceUnderNotice ? (ConsoleAction.Talk, ConsoleAction.None)
                : (asks ? ConsoleAction.AnswerTask : ConsoleAction.Talk, ConsoleAction.More);
            if (third == ConsoleAction.SendChoice)
            {
                actions[ConsoleAction.SendChoice].transform.SetParent(bar.transform, false);
                actions[ConsoleAction.SendChoice].Label("Choose");
            }
            var shelf = new[] { first, ConsoleAction.PauseScene, third };
            if (recoveryOffered)
            {
                actions[ConsoleAction.CheckCapture].transform.SetParent(bar.transform, false);
                actions[ConsoleAction.DismissCapture].transform.SetParent(bar.transform, false);
                actions[ConsoleAction.DismissCapture].Label("New");
            }
            actions[ConsoleAction.Cancel].Label(buttonRecording ? "Cancel" : "Stop");
            for (var slot = 0; slot < shelf.Length; slot++)
                if (shelf[slot] != ConsoleAction.None)
                    Put(shelf[slot], SpatialTheme.ShelfLeft + SpatialTheme.ShelfSlot / 2f + slot * (SpatialTheme.ShelfSlot + SpatialTheme.Gap), 0f, true);
            // Empty contextual rows no longer reserve space or draw a second control location.
            if(!actions.Values.Any(action=>action.transform.parent==dock.transform && action.gameObject.activeSelf))dock.gameObject.SetActive(false);
            if(mode=="capture" && !recoveryOffered)options.gameObject.SetActive(optionsOpen);
            headerHit.center = Vector3.back * .004f; headerHit.size = new Vector3(header.Size.x, header.Size.y, .012f);
            headerHit.enabled = !dialogueVisible && !recoveryOffered && !evidenceOffered && reviewing && !savePreview && !busy && view?.IntentId != null;
            // A line alone keeps the subtitle's full paging target; with rows under it the panel is exactly the line and its
            // rows, so it ends one gap above the shelf.
            if (choiceOnLine != null && dockedDialogue != null) header.ReserveHeight(dockedDialogue.PanelHeight);
            else if (conversationPanelHeight <= 0f && !recoveryOffered) header.ReserveHeight(.160f);
            if (companion != null)
            {
                // Beside the line: level with its first words when rows sit under it, otherwise with the middle of a line
                // that sits on the panel's bottom edge.
                var beside = conversationPanelHeight > 0f ? header.Size.y / 2f - .080f
                    : dialogueVisible && dockedDialogue != null ? -header.Size.y / 2f + dockedDialogue.VisibleHeight / 2f : 0f;
                companionHome = new Vector3(-.215f, beside, -.018f);
                // Away beside a subject, or flying back, Boopy keeps its own path home.
                if (visitPoint == null && !returning) companion.transform.localPosition = companionHome;
                companion.SetState(voicePreparing || (busy && mode != "processing") ? "processing" : mode == "capture" ? "idle" : mode);
            }
            // Protected-source fallback permits explicitly opened global settings only.
            // Context shares this surface, but its summary and context actions remain conversation content.
            if (controlsOnly && !settingsOpen) options.gameObject.SetActive(false);
            // An explicit sheet takes the conversation's place; closing it restores the exact caption.
            if (options.gameObject.activeSelf || card.gameObject.activeSelf) header.gameObject.SetActive(false);
            var modules = new[] { bar, options, dock, card, header }.Where(surface => surface.gameObject.activeSelf).ToArray();
            height = modules.Sum(surface => surface.Size.y) + SpatialTheme.Gap * Mathf.Max(0, modules.Length - 1);
            // The bar stays put. Requested content unfolds upward from it.
            var y = -bar.Size.y / 2f;
            foreach (var surface in modules) { surface.transform.localPosition = new Vector3(surface.CenterX, y + surface.Size.y / 2f, 0); y += surface.Size.y + SpatialTheme.Gap; }
            if(controlsOnly) { header.gameObject.SetActive(false); card.gameObject.SetActive(false); dock.gameObject.SetActive(false); headerHit.enabled=false; }
            transform.localScale = Vector3.one * ComfortScale;
            RefreshVisuals(0f);
        }

        private string ContextLabel()
        {
            var label = view?.Items.FirstOrDefault(item => item.Id == view.IntentId)?.Label;
            return string.IsNullOrWhiteSpace(label) ? "Conversation" : label.Length <= 60 ? label : "Conversation";
        }

        /// <summary>Hide this dispatched response's choices locally; its accepted Mac outcome may be unknown.</summary>
        public void SuppressSuggestions()
        {
            if (view?.Dialogue == null) return;
            suppressedSuggestionSession = view.Id;
            suppressedSuggestionUtterance = view.Dialogue.UtteranceId;
            suppressedSuggestionAt = view.Dialogue.At;
            Compose();
        }
        // Production docks its exact caption. Header-only console fixtures retain their standalone behavior.
        private void RefreshSuggestions()
        {
            suggestions.Clear();
            if (taskShown || view?.Dialogue == null || mode != "review" || busy || view.Committed != null
                || view.Id == suppressedSuggestionSession && view.Dialogue.UtteranceId == suppressedSuggestionUtterance && view.Dialogue.At == suppressedSuggestionAt
                || dockedDialogue != null && (!dialogueVisible || dockedDialogue.FullText != view.Dialogue.Text)
                || view.Dialogue.Actions == null || view.Dialogue.Speaker != "boopy" || view.Dialogue.UtteranceId != view.Utterances.LastOrDefault()?.Id) return;
            var ids = new HashSet<string>();
            foreach (var action in view.Dialogue.Actions)
            {
                if (action == null || string.IsNullOrWhiteSpace(action.Id) || view.Dialogue.Actions.Count(candidate => candidate != null && candidate.Id == action.Id) != 1 || !ids.Add(action.Id) || string.IsNullOrWhiteSpace(action.Question) || action.Question.Length > 120) continue;
                if (action.TargetItemId != null && !view.Items.Any(item => item.Id == action.TargetItemId && !ContextReview.IsExcluded(item))) continue;
                if (action.ObservationId != null && !view.Observations.Any(observation => observation.Id == action.ObservationId)) continue;
                suggestions.Add(action);
                if (suggestions.Count == 2) break;
            }
        }
        public ContextualAction? SuggestedAction(ConsoleAction action)
        {
            RefreshSuggestions();
            var index = action == ConsoleAction.FollowUpOne ? 0 : action == ConsoleAction.FollowUpTwo ? 1 : -1;
            return index >= 0 && index < suggestions.Count && actions[action].gameObject.activeInHierarchy
                && shownSuggestionIds.TryGetValue(action, out var id) && suggestions[index].Id == id
                && actions[action].AccessibleLabel == suggestions[index].Question ? suggestions[index] : null;
        }
        // A choice shows only on Boopy's line, its options paged under its prompt.
        private ChoiceCard? ActiveChoice() => !taskShown && view?.Dialogue?.Choice is ChoiceCard choice && choice.Supported
            && dockedDialogue != null && dialogueVisible && dockedDialogue.FullText == view.Dialogue.Text
            && view.Dialogue.Text.Trim() == choice.Prompt.Trim()
            && view.Dialogue.Speaker == "boopy" && view.Dialogue.UtteranceId == view.Utterances.LastOrDefault()?.Id
            && view.Committed == null && !(view.Id == suppressedCardSession && choice.Id == suppressedCardId) && mode == "review" ? choice : null;
        public void SuppressDispatchedChoice()
        {
            suppressedCardSession = view?.Id; suppressedCardId = view?.Dialogue?.Choice?.Id; Compose();
        }
        /// <summary>The option the line shows, which Choose sends; null when no choice is offered.</summary>
        public ChoiceSelection? SelectedChoice(ConsoleAction control)
        {
            var choice = ActiveChoice();
            if (choice == null || busy || controlsOnly || control != ConsoleAction.SendChoice || !actions[control].gameObject.activeInHierarchy || dockedDialogue == null) return null;
            var index = dockedDialogue.ShownItem;
            if (index < 0 || index >= choice.Options.Count || index >= dockedDialogue.Items.Count || dockedDialogue.Items[index] != choice.Options[index].Label) return null;
            return new ChoiceSelection { UtteranceId = view!.Dialogue!.UtteranceId, ResponseAt = view.Dialogue.At, CardId = choice.Id, OptionId = choice.Options[index].Id };
        }

        private float ConfigureQuestion(ConsoleAction action, string question)
        {
            var control = actions[action]; control.Label(question); control.SetLeftAligned(true);
            var text = control.GetComponentsInChildren<TextMeshPro>(true).Single(label => label.name == "Verb");
            var height = Mathf.Max(SpatialTheme.Target, SpatialTheme.Height(text, question, .384f) + .020f);
            text.rectTransform.sizeDelta = new Vector2(.384f, height - .012f);
            control.GetComponent<BoxCollider>().size = new Vector3(.400f, height, .012f);
            control.GetComponentsInChildren<MeshRenderer>(true).Single(renderer => renderer.name == "Action surface").transform.localScale = new Vector3(.400f, height, 1f);
            return height;
        }

        private string handoffState = "not-prepared";
        private string? handoffRequestId;
        public string HandoffStatusWords => handoffState == "prepared-local"
            ? "Prepared on your Mac. Not sent yet."
            : handoffState == "preparing-local" ? "Preparing on your Mac. Not sent yet."
            : handoffState == "checking" ? "Checking preparation. Not sent yet."
            : handoffState == "missing" ? "No preparation receipt found. Context kept. Not sent yet."
            : handoffState == "changed" ? "Sources changed. Prepare again. Not sent yet."
            : handoffState == "interrupted" ? "Context kept. Preparation status unknown. Not sent yet."
            : handoffState == "failed" ? "Context kept. Preparation unavailable. Not sent yet."
            : "Context kept on your Mac. Handoff not prepared. Not sent yet.";
        public void SetHandoffState(string state, string? requestId = null)
        {
            handoffState = state;
            if (state == "not-prepared") handoffRequestId = null;
            if (requestId != null && requestId.Length <= 128 && requestId.All(character =>
                character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
                character >= '0' && character <= '9' || character == '_' || character == '-')) handoffRequestId = requestId;
            if (view?.Committed == null) return;
            header!.Configure("", "", HandoffStatusWords, .145f);
            Compose(); Assemble();
        }
        private string ManualHandoffWords()
        {
            if (handoffStorageFailed) return "Could not read or keep the preparation recovery record.\nDismiss removes only this headset recovery record. Context stays on your Mac.\nNothing has been sent.";
            var id = handoffRecoveryOffered ? recoveryPackageId : view?.Committed?.PackageId;
            if (handoffRecoveryOffered && string.IsNullOrEmpty(id)) return $"Earlier context needs checking.\nPreparation ID: {recoveryPreparationId}\nDismiss removes only this headset recovery record. Context stays on your Mac.\nNothing has been sent.";
            // Service IDs are short ASCII identifiers. Never shrink arbitrary response text
            // into an unreadable receipt or silently truncate an identifier used for export.
            var valid = !string.IsNullOrEmpty(id) && id.Length <= 80 && id.All(character =>
                character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
                character >= '0' && character <= '9' || character == '_' || character == '-');
            var requestId = handoffRecoveryOffered ? recoveryPreparationId : handoffRequestId;
            var preparationId = string.IsNullOrEmpty(requestId) ? "" : $"Preparation ID: {requestId}\n";
            var recoveryWords = handoffRecoveryOffered ? "Earlier preparation needs checking. Nothing has been sent."
                : HandoffStatusWords;
            var dismissWords = handoffRecordAvailable ? "\nDismiss removes only this headset recovery record. Context stays on your Mac." : "";
            return valid ? $"Context ID: {id}\n{preparationId}{recoveryWords}{dismissWords}"
                : "Context ID unavailable.\nCheck the context receipt on your Mac.\nNothing has been sent.";
        }

        private void SetCardCapacity(float capacity)
        {
            // Capacity is reserved across selected items; measured text retains its own hierarchy.
            card!.ReserveHeight(capacity);
        }
        private static string ShortId(string? id) => id == null ? "Context saved" : id.Length > 18 ? id.Substring(0, 18) + "..." : id;
        private static string GeometryCue(Item item) => item.Grounding.Spatial?.Outcome == "contour" && item.Grounding.Contour?.Count >= 3
            ? "Proposed contour" : item.Grounding.Kind == "box" && item.Grounding.Box != null
            ? "Approximate box" : item.Grounding.Kind == "point" && item.Grounding.Point != null
            ? "Image point" : item.Grounding.Kind == "scene" ? "Scene / no object position" : "Position unknown";
        // The Settings tile's row at the bottom of the Context and Settings sheet: one tile on the text column.
        private const float SettingsRow = SpatialTheme.Target + SpatialTheme.Gap;
        private void SettingsTile(float bottom)
        {
            actions[ConsoleAction.Settings].transform.SetParent(options!.transform, false);
            Put(ConsoleAction.Settings, SpatialTheme.ShelfLeft + SpatialTheme.ShelfSlot / 2f, bottom + SpatialTheme.Gap / 2f + SpatialTheme.Target / 2f, true);
        }
        private void Put(ConsoleAction action, float x, float y, bool show)
        {
            var control = actions[action]; control.gameObject.SetActive(show);
            control.transform.localPosition = new Vector3(x, y, -.001f);
        }
        private void Assemble()
        {
            foreach (var module in new[] { header, card, dock, options, bar })
                if (module != null && module != bar && module.gameObject.activeSelf) module.Assemble(0f, reduced);
            RefreshVisuals(0f);
        }

        public void Inspect(Item? item)
        { if (item == null || mode != "review" || readerOpen || savePreview || navigator.DetailsOpen || !navigator.Select(item.Id)) return; Compose(); }
        public void SetOverflow(int count) { overflow = Mathf.Max(0, count); }
        public void SetBusy(bool on, bool retainChoice = false) { busy = on; keepChoiceVisible = on && retainChoice; Compose(); }
        private bool ChoiceDismissed() => view?.State == "review" && view.Committed == null && view.Attention != null && !string.IsNullOrWhiteSpace(view.Attention.UtteranceId) && view.Utterances.LastOrDefault()?.Id == view.Attention.UtteranceId && dismissedChoiceSession == view.Id && dismissedChoiceId == view.Attention.UtteranceId && nextTurnInstruction != null;
        private bool ChoiceAvailable() => view?.State == "review" && view.Committed == null && view.Attention != null && !string.IsNullOrWhiteSpace(view.Attention.UtteranceId)
            && view.Utterances.LastOrDefault()?.Id == view.Attention.UtteranceId
            && (view.Attention.Action == "fresh-view" || view.Attention.Action == "clarify")
            && (view.Attention.Source == "current-surroundings" || view.Attention.Source == "unknown")
            && !ChoiceDismissed();
        private void SelectEvidenceChoice(bool spoken)
        {
            if ((mode != "review" && mode != "error") || !ChoiceAvailable() || !(spoken ? InputPolicy.SelectSpokenOnly() : InputPolicy.SelectCurrentView())) return;
            dismissedChoiceId = view!.Attention!.UtteranceId; dismissedChoiceSession = view.Id;
            nextTurnInstruction = spoken ? "Talk with photo sharing off." : "Look toward the subject, then Talk.";
            header!.Configure("Next turn", "", nextTurnInstruction, .145f);
            Compose(); Assemble();
        }
        public Item? NextEvidence() => Activate(ConsoleAction.NextItem);

        public Item? Activate(ConsoleAction action)
        {
            if (busy || captureRecovery) return navigator.Selected;
            if (action == ConsoleAction.UseCurrentView || action == ConsoleAction.UseSpokenOnly)
            { SelectEvidenceChoice(action == ConsoleAction.UseSpokenOnly); return navigator.Selected; }
            switch (action)
            {
                case ConsoleAction.Actions: actionsOpen = !actionsOpen; optionsOpen = false; break;
                case ConsoleAction.Review: handoffOpen = false; readerOpen = !readerOpen; actionsOpen = false; optionsOpen = false; break;
                case ConsoleAction.PrepareSave: actionsOpen = false; savePreview = ContextReview.CanSave(view); readerOpen = false; optionsOpen = false; break;
                case ConsoleAction.Handoff: handoffOpen = true; optionsOpen = false; break;
                case ConsoleAction.Back: actionsOpen = false; optionsOpen = false; savePreview = false; handoffOpen = false; break;
                case ConsoleAction.PreviousItem: navigator.MoveItem(-1); break;
                case ConsoleAction.NextItem: navigator.MoveItem(1); break;
                case ConsoleAction.ToggleDetails: navigator.SetDetailsOpen(!navigator.DetailsOpen); if (navigator.DetailsOpen) Pages(); break;
                case ConsoleAction.PreviousText: navigator.MovePage(-1); break;
                case ConsoleAction.NextText: navigator.MovePage(1); break;
                case ConsoleAction.Settings: optionsOpen = !optionsOpen || !settingsOpen; settingsOpen = true; actionsOpen = false; readerOpen = false; savePreview = false; handoffOpen = false; break;
                case ConsoleAction.Options: optionsOpen = !optionsOpen || settingsOpen; settingsOpen = false; readerOpen = false; savePreview = false; handoffOpen = false; break;
                case ConsoleAction.More: moreOpen = true; break;
                case ConsoleAction.ShelfBack: moreOpen = false; optionsOpen = false; settingsOpen = false; break;
                case ConsoleAction.Size: ComfortScale = ComfortScale > 1f ? 1f : 1.2f; if (Application.isPlaying) PlayerPrefs.SetInt("Boopy.LargeText", ComfortScale > 1f ? 1 : 0); break;
                case ConsoleAction.Sound: SoundEnabled = !SoundEnabled; if (Application.isPlaying) PlayerPrefs.SetInt("Boopy.Sound", SoundEnabled ? 1 : 0); break;
                case ConsoleAction.EvidenceSource: InputPolicy.Toggle(); if (mode == "capture") ConfigureOpening(); Assemble(); break;
                case ConsoleAction.Speech:
                    if (!speechAvailable) break;
                    voicePreferred = !voicePreferred; VoiceEnabled = voicePreferred;
                    if (Application.isPlaying) SaveVoicePreference();
                    break;
                case ConsoleAction.Motion: reduced = !reduced; if (Application.isPlaying) PlayerPrefs.SetInt("Boopy.Motion", reduced ? 0 : 1); Assemble(); break;
            }
            Compose();
            if (action == ConsoleAction.Actions || action == ConsoleAction.Settings || action == ConsoleAction.PrepareSave || action == ConsoleAction.Back || action == ConsoleAction.Handoff || action == ConsoleAction.Review || action == ConsoleAction.ToggleDetails || action == ConsoleAction.Options
                || action == ConsoleAction.More || action == ConsoleAction.ShelfBack) Assemble();
            return navigator.Selected;
        }

        private void Pages()
        {
            if (navigator.Selected == null || card == null) return;
            var selected = navigator.Selected;
            var words = "Detail: " + selected.Label + "\n" + ChipStyles.For(selected, false).Tag + " / " + GeometryCue(selected) + "\n" + ContextReview.Evidence(selected);
            var initial = view?.Utterances.FirstOrDefault(item => item.Kind == "ask");
            if (initial != null) words += "\nInitial session request: " + initial.Text;
            var refinement = view?.Utterances.FirstOrDefault(item => item.Id == selected.Grounding.Spatial?.UtteranceId);
            if (refinement != null) words += "\nShape refinement request: " + refinement.Text;
            var intent = view?.Items.FirstOrDefault(item => item.Id == view.IntentId);
            if (intent != null) words += "\nGoal interpretation: " + intent.Label + "\n" + intent.Statement;
            if (view?.Model != null) words += $"\nSession model: {view.Model.Provider} / {view.Model.Id}, {view.Model.LatencyMs / 1000f:0.0} s";
            var probe = SpatialTheme.Text(transform, "Page measuring probe", SpatialTheme.Body, SpatialTheme.Ivory);
            probe.gameObject.SetActive(false); var pages = new List<string>(); var start = 0;
            while (start < words.Length)
            {
                var low = 1; var high = words.Length - start;
                while (low < high) { var mid = (low + high + 1) / 2; if (SpatialTheme.Height(probe, words.Substring(start, mid), SpatialTheme.ShelfWidth) <= .110f) low = mid; else high = mid - 1; }
                var length = low; if (start + length < words.Length && length > 1 && char.IsHighSurrogate(words[start + length - 1])) length--;
                if (start + length < words.Length)
                {
                    for (var boundary = length - 1; boundary >= length * .65f; boundary--)
                    {
                        if (!char.IsWhiteSpace(words[start + boundary])) continue;
                        length = boundary + 1;
                        break;
                    }
                }
                pages.Add(words.Substring(start, length)); start += length;
            }
            if (pages.Count == 0) pages.Add("No additional source text.");
            navigator.SetPages(pages); if (Application.isPlaying) Destroy(probe.gameObject); else DestroyImmediate(probe.gameObject);
        }

        public ConsoleAction HitAction(Ray ray, out Vector3 point)
        {
            foreach (var pair in actions) if ((!busy || pair.Key == ConsoleAction.Cancel || pair.Key == ConsoleAction.PauseScene) && pair.Value.Hit(ray, out point)) return pair.Key;
            point = default; return ConsoleAction.None;
        }
        public bool CanRelease(ConsoleAction action, Ray ray) => action != ConsoleAction.None && HitAction(ray, out _) == action;
        public bool HitSave(Ray ray, out Vector3 point) => Hit(ConsoleAction.Save, ray, out point);
        public bool HitNext(Ray ray, out Vector3 point) => Hit(ConsoleAction.NextItem, ray, out point);
        public bool HitConfirm(Ray ray, out Vector3 point) => Hit(ConsoleAction.Confirm, ray, out point);
        private bool Hit(ConsoleAction action, Ray ray, out Vector3 point) { point = default; return !busy && actions[action].Hit(ray, out point); }
        /// <summary>The docked line shows another page: the row follows the item it shows.</summary>
        public void LinePaged() => Compose();
        public bool HitEvidence(Ray ray, out Vector3 point) => BodyHit(evidenceHit, ray, out point);
        public string? HitTarget(Ray ray, out Vector3 point)
        { if (BodyHit(headerHit, ray, out point)) return view?.IntentId; return BodyHit(evidenceHit, ray, out point) ? SelectedItemId : null; }
        private bool BodyHit(BoxCollider? box, Ray ray, out Vector3 point)
        { point = default; if (busy || !gameObject.activeInHierarchy || box == null || !box.enabled || !box.gameObject.activeInHierarchy || !box.Raycast(ray, out var hit, 5f)) return false; point = hit.point; return true; }
        public bool ContainsRay(Ray ray)
        {
            foreach (var surface in new[] { header, card, dock, options, bar })
            {
                if (surface == null || !surface.gameObject.activeInHierarchy) continue;
                var plane = new Plane(transform.forward, surface.transform.position);
                if (!plane.Raycast(ray, out var distance) || distance > 5f) continue;
                var local = surface.transform.InverseTransformPoint(ray.GetPoint(distance));
                if (Mathf.Abs(local.x) <= surface.Size.x / 2f + .02f && Mathf.Abs(local.y) <= surface.Size.y / 2f + .02f) return true;
            }
            return false;
        }
        public void FocusAt(Ray ray) { focused = HitAction(ray, out _); foreach (var pair in actions) pair.Value.Focus(pair.Key == focused); }
        public void SetFocus(bool on) { if (!on) ClearFocus(); }
        public void ClearFocus() { focused = ConsoleAction.None; foreach (var control in actions.Values) { control.Focus(false); control.Press(false); } }
        public void SetPressed(bool on) { if (actions.TryGetValue(focused, out var control)) control.Press(on); }
        public void RefreshVisuals(float delta)
        {
            if (!reduced) animationTime += Mathf.Max(0f, delta);
            Face();
            foreach (var module in new[] { header, card, dock, options, bar }) if (module != null && module.gameObject.activeSelf) module.Refresh(delta);
            foreach (var control in actions.Values) if (control.gameObject.activeSelf)
                control.Refresh(delta, control.GetComponentInParent<SpatialSurface>(true)?.Opacity ?? 0f, reduced);
            if (companion != null)
            {
                companion.SetVisible(gameObject.activeInHierarchy && !controlsOnly);
                // Boopy stays whole while it works: the re-reveal when work starts fades the panel, never the companion.
                companion.SetOpacity(mode == "processing" || visitPoint != null || returning ? 1f : header?.Opacity ?? 1f);
                Travel(delta);
                companion.Refresh(delta, reduced);
            }
            header?.Shimmer(animationTime, mode == "processing" || busy);
        }
        private const float FlightSpeed = 3f;
        private Vector3 companionHome;
        private Vector3? visitPoint, visitAnchor;
        private IReadOnlyList<Vector3> visitEdge = System.Array.Empty<Vector3>();
        private System.Action? onArrive;
        private System.Func<float?>? sweepProgress;
        private bool arrived, returning;

        /// <summary>Boopy is away from the console, beside the subject it works on.</summary>
        public bool CompanionVisiting => visitPoint != null && !reduced;

        /// <summary>
        /// While this turn works, Boopy goes to <paramref name="point"/> beside the subject, faces
        /// <paramref name="anchor"/>, and on arrival starts the subject's sweep and lights it with a cone to
        /// <paramref name="edge"/> for as long as the sweep runs. Reduced motion stays home and only turns.
        /// The visit ends when the work does.
        /// </summary>
        public void VisitSubject(Vector3 point, Vector3 anchor, IReadOnlyList<Vector3> edge, System.Action arrive, System.Func<float?> sweep)
        {
            visitPoint = point; visitAnchor = anchor; visitEdge = edge;
            onArrive = arrive; sweepProgress = sweep; arrived = false; returning = false;
        }

        private void EndVisit()
        {
            if (visitPoint == null) return;
            visitPoint = null; visitAnchor = null; visitEdge = System.Array.Empty<Vector3>();
            onArrive = null; sweepProgress = null; arrived = false; returning = true;
            companion?.SetCone(null, 0f);
        }

        private void Travel(float delta)
        {
            if (companion == null) return;
            if (visitPoint != null && mode != "processing") EndVisit();
            var step = FlightSpeed * Mathf.Max(0f, delta);
            if (visitPoint != null && !reduced)
            {
                var target = visitPoint.Value;
                companion.transform.position = Vector3.MoveTowards(companion.transform.position, target, step);
                if (!arrived && (companion.transform.position - target).sqrMagnitude < 1e-8f) { arrived = true; onArrive?.Invoke(); }
            }
            else if (returning || reduced)
            {
                var home = companion.transform.parent != null ? companion.transform.parent.TransformPoint(companionHome) : companionHome;
                companion.transform.position = reduced ? home : Vector3.MoveTowards(companion.transform.position, home, step);
                if ((companion.transform.position - home).sqrMagnitude < 1e-8f) { companion.transform.localPosition = companionHome; returning = false; }
            }
            // Facing the subject while it works on it; otherwise the console's own facing.
            if (visitAnchor != null && (companion.transform.position - visitAnchor.Value).sqrMagnitude > 1e-6f)
                companion.transform.rotation = Quaternion.LookRotation(companion.transform.position - visitAnchor.Value, Vector3.up);
            else companion.transform.localRotation = Quaternion.identity;
            var progress = arrived && !reduced ? sweepProgress?.Invoke() : null;
            companion.SetCone(progress != null ? visitEdge : null, progress != null ? Mathf.Sin(progress.Value * Mathf.PI) : 0f);
        }

        private void Face() { if (head == null || interactionLocked) return; var direction = transform.position - head.position; if (direction.sqrMagnitude > 1e-6f) transform.rotation = Quaternion.LookRotation(direction, Vector3.up); }
        private void LateUpdate() => RefreshVisuals(Time.unscaledDeltaTime);

        private void OnDestroy()
        {
            if (dialogMesh == null) return;
            if (Application.isPlaying) Destroy(dialogMesh); else DestroyImmediate(dialogMesh);
        }
    }
}
