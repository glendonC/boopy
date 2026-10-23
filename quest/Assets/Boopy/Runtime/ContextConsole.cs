#nullable enable
using System.Collections.Generic;
using System.Linq;
using Boopy.Client;
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>Independent status, selected evidence and save modules. Full sources open only on request.</summary>
    public sealed class ContextConsole : MonoBehaviour
    {
        private readonly EvidenceNavigator navigator = new EvidenceNavigator();
        // The selected item's measured source pages, as the navigator holds them, so the card can take its tallest page's height.
        private readonly List<string> sourcePages = new List<string>();
        private readonly Dictionary<ConsoleAction, SpatialAction> actions = new Dictionary<ConsoleAction, SpatialAction>();
        private SpatialSurface? header, card, options, bar;
        private Transform? head;
        private DialogueStrip? dockedDialogue;
        private bool voicePreparing, openingGreeted;
        private string connectionState = "checking";
        private bool? liveSceneAvailable;
        private bool speechAvailable, buttonRecording;
        private BoxCollider? headerHit, evidenceHit, sheetHit;
        private CompanionOrb? companion;
        private SessionView? view;
        private bool captureRecovery, dialogueVisible, controlsOnly;
        // More swaps the row in place: page 1 is Context and More, page 2 Settings and Back; 0 is the conversation's row.
        private int morePage;
        // The page each sheet's row shows: the Context sheet's actions paged with More, the reader's two rows, one setting.
        private int contextPage, readerPage, settingsPage;
        private const int SettingsPages = 5;
        // The dark panel of the line, drawn on the header while Boopy's words show on it with no line docked over them.
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
        private string? suppressedCardSession, suppressedCardId;
        private bool busy, reduced, optionsOpen, interactionLocked, readerOpen, savePreview, handoffOpen;
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
            console.options = SpatialSurface.Create(go.transform, "Comfort options");
            // Sheets and cards take the line's column, as Boopy's line and its words do.
            console.card.SetColumn(true); console.options.SetColumn(true);
            console.bar = SpatialSurface.Create(go.transform, "Control bar");
            // The row's surface is exactly one control tall, so the panel above it sits one gap above the controls.
            console.bar.Configure("", "", "", bottomSpace: SpatialTheme.Target - 2f * SpatialTheme.Padding);
            console.bar.SetChrome(false);
            // Every control is a tile of the one row; each state names its first and third tile.
            foreach (var (action, label) in new[]
            {
                (ConsoleAction.Talk, "Talk"), (ConsoleAction.FinishTalk, "Finish"), (ConsoleAction.AnswerTask, ""), (ConsoleAction.PauseScene, "Pause"),
                (ConsoleAction.Cancel, "Stop"), (ConsoleAction.More, "More"), (ConsoleAction.ShelfBack, "Back"), (ConsoleAction.Back, "Back"),
                (ConsoleAction.Options, "Context"), (ConsoleAction.Settings, "Settings"), (ConsoleAction.CheckCapture, "Check"), (ConsoleAction.DismissCapture, "New"),
                (ConsoleAction.UseSpokenOnly, "No view"), (ConsoleAction.UseCurrentView, "View"), (ConsoleAction.SendChoice, "Choose"),
                (ConsoleAction.FollowUpOne, "Ask"), (ConsoleAction.FollowUpTwo, "Ask"), (ConsoleAction.PrepareSave, "Prepare"), (ConsoleAction.Review, "Review"),
                (ConsoleAction.Handoff, "Prepare"), (ConsoleAction.Save, "Use"), (ConsoleAction.ToggleIncluded, "Exclude"), (ConsoleAction.ToggleDetails, "Source"),
                (ConsoleAction.Confirm, "Confirm"), (ConsoleAction.Size, "Turn on"), (ConsoleAction.Sound, "Turn off"), (ConsoleAction.Motion, "Turn on"),
                (ConsoleAction.Speech, "Turn off"), (ConsoleAction.EvidenceSource, "Turn off"),
            })
                console.Add(action, label);
            var dialogPlate = new GameObject("Dialog backing"); dialogPlate.transform.SetParent(console.header.transform, false);
            console.dialogMesh = RoundedPlate.Create(1f, 1f, .06f);
            dialogPlate.AddComponent<MeshFilter>().sharedMesh = console.dialogMesh;
            console.dialogBacking = dialogPlate.AddComponent<MeshRenderer>(); console.dialogBacking.sharedMaterial = Visuals.Solid;
            console.dialogBacking.sortingOrder = 0; console.dialogBacking.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            console.dialogBacking.enabled = false;
            var panel = new MaterialPropertyBlock(); panel.SetColor("_Color", SpatialTheme.Panel); console.dialogBacking.SetPropertyBlock(panel);
            console.headerHit = console.header.gameObject.AddComponent<BoxCollider>();
            console.evidenceHit = console.card.gameObject.AddComponent<BoxCollider>();
            console.sheetHit = console.options.gameObject.AddComponent<BoxCollider>(); console.sheetHit.enabled = false;
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

        private void Add(ConsoleAction action, string label) => actions.Add(action, SpatialAction.Create(bar!.transform, action, label, SpatialTheme.ShelfSlot));
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
            if (available) { optionsOpen = false; readerOpen = false; savePreview = false; handoffOpen = false; ClearFocus(); header?.Configure("", "Earlier capture", string.IsNullOrEmpty(recoveryErrorWords) ? header.BodyText : recoveryErrorWords, .145f); }
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
            var changed = mode != next; mode = next; busy = next == "processing"; optionsOpen = false; savePreview = false; handoffOpen = false; morePage = 0;
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
            if (newSession) { optionsOpen = false; settingsOpen = false; morePage = 0; readerOpen = false; savePreview = false; handoffOpen = false; taskShown = false; taskActionLabel = null; }
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
            if (header == null || card == null || options == null || bar == null || evidenceHit == null || headerHit == null || sheetHit == null) return;
            header.gameObject.SetActive(true);
            // With a line docked, shown or hidden, the panel starts from its own words' height each time, so it ends one gap above
            // the row; a height reserved earlier never lingers.
            if (dockedDialogue != null) header.Configure(header.StateText, header.TitleText, header.BodyText, .145f);
            var recoveryOffered = captureRecovery && !busy && mode != "listening" && mode != "processing";
            // The recovery dialog speaks on the panel itself: no line and no speaker over it. Hiding the line composes again.
            if (recoveryOffered && dockedDialogue != null && dockedDialogue.gameObject.activeSelf) { dockedDialogue.Hide(); return; }
            var evidenceOffered = !captureRecovery && !busy && (mode == "review" || mode == "error") && EvidenceAsked() && !taskShown;
            var reviewing = mode == "review";
            RefreshSuggestions();
            shownSuggestionIds.Clear();
            // Protected-source fallback shows no conversation content and permits explicitly opened global settings only.
            card.gameObject.SetActive(!controlsOnly && !recoveryOffered && !evidenceOffered && (savePreview || handoffOpen || (reviewing && readerOpen && navigator.Selected != null)));
            options.gameObject.SetActive(optionsOpen && !recoveryOffered && !evidenceOffered && !(controlsOnly && !settingsOpen)
                && (mode == "capture" || mode == "processing" || mode != "listening" && !busy));
            foreach (var action in actions.Values) action.gameObject.SetActive(false);
            if (dialogBacking != null) dialogBacking.enabled = false;
            if (card.gameObject.activeSelf && !savePreview && !handoffOpen)
            {
                var selected = navigator.Selected!;
                var source = navigator.DetailsOpen;
                // One item, or one page of its source, at a time, with "n of N" where the speaker line sits; a pinch on the
                // card shows the next.
                var count = source ? Count(navigator.PageIndex, navigator.PageCount) : Count(navigator.ItemIndex, navigator.ItemCount);
                // One height across its pages, its tallest page's, keeps the card under the pinch that pages it and hugs its words.
                var tallest = 0f;
                if (source && sourcePages.Count == navigator.PageCount)
                    foreach (var sourcePage in sourcePages) { card.Configure("Source" + count, selected.Label, sourcePage, .116f, maxTitleHeight: .044f); tallest = Mathf.Max(tallest, card.Size.y); }
                // The reader's items are the navigator's: every item but the goal.
                else if (!source && view != null)
                    foreach (var other in view.Items.Where(candidate => candidate.Kind != "goal"))
                    { card.Configure(ChipStyles.For(other, false).Tag + count, other.Label, other.Statement, .066f, maxTitleHeight: .044f); tallest = Mathf.Max(tallest, card.Size.y); }
                card.Configure((source ? "Source" : ChipStyles.For(selected, false).Tag) + count, selected.Label,
                    source ? navigator.CurrentPage ?? "No additional evidence." : selected.Statement, source ? .116f : .066f, maxTitleHeight: .044f);
                card.ReserveHeight(tallest);
                evidenceHit.center = Vector3.back * .004f;
                evidenceHit.size = new Vector3(card.Size.x, card.Size.y, .012f);
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
            // A dialog on the panel: its title and one sentence. Its actions, Check and New, lead the row under it.
            if (recoveryOffered) header.Configure("", "Earlier capture", string.IsNullOrEmpty(recoveryErrorWords) ? header.BodyText : recoveryErrorWords, .145f);
            // Boopy's words on the console's own panel, with no line docked over them: the recovery dialog, an opening or a
            // next-turn line.
            var ownWords = recoveryOffered || !dialogueVisible && (header.StateText.Length > 0 || header.TitleText.Length > 0 || header.BodyText.Length > 0);
            if (options.gameObject.activeSelf)
            {
                if (!settingsOpen)
                {
                    // The Context sheet, named on its top line as Settings is, and its words, hugged by its panel; its actions page in
                    // the row, and its words say what each one-word action does.
                    var earlier = handoffRecoveryOffered || handoffStorageFailed;
                    options.Configure("Context", "", earlier
                        ? handoffStorageFailed ? "Preparation recovery is unavailable. Dismiss only the headset record; context stays on your Mac."
                            : "An earlier preparation needs checking. Checking restores only that selected context; nothing is sent."
                        : view == null ? "Tell me what you see.\nKeep it on your Mac. Continue online when ready."
                        : view.Committed != null ? ContextReview.ConversationSummary(view) + "\n" + HandoffStatusWords
                        : ContextReview.ConversationSummary(view) + "\nKeep it on your Mac. Continue online when ready.", maxBodyHeight: .220f);
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
                    // One setting per page, its state as a sentence; the first page keeps the connection, scene and voice lines.
                    var (name, on) = settingsPage switch
                    {
                        0 => ("Large text", ComfortScale > 1f), 1 => ("Sound", SoundEnabled), 2 => ("Reduced motion", reduced),
                        3 => ("Voice", VoiceEnabled), _ => ("Photo", !InputPolicy.SpokenOnly),
                    };
                    var sentence = settingsPage == 3 && !speechAvailable ? "Voice is unavailable." : name + " is " + (on ? "on." : "off.");
                    var status = connectionWords + "\n" + sceneWords + "\n" + voiceWords + "\n";
                    // Every page keeps the first page's height, so the sheet stays under the pinch that pages it.
                    options.Configure("Settings", "", status + sentence, maxBodyHeight: .180f, bottomSpace: .015f);
                    var tallest = options.Size.y;
                    options.Configure("Settings" + Count(settingsPage, SettingsPages), "", (settingsPage == 0 ? status : "") + sentence, maxBodyHeight: .180f, bottomSpace: .015f);
                    options.ReserveHeight(tallest);
                }
            }
            // A pinch on Settings shows its next setting.
            sheetHit.center = Vector3.back * .004f; sheetHit.size = new Vector3(options.Size.x, options.Size.y, .012f);
            sheetHit.enabled = options.gameObject.activeSelf && settingsOpen && !busy;
            var choice = reviewing && !readerOpen && !savePreview && !handoffOpen && !optionsOpen && !recoveryOffered && !evidenceOffered ? ActiveChoice() : null;
            // A notice over a line that offers a choice leaves the choice standing: nothing takes its slot until the line returns.
            var choiceUnderNotice = choice == null && reviewing && !readerOpen && !savePreview && !handoffOpen && !optionsOpen && !recoveryOffered && !evidenceOffered
                && dockedDialogue?.NoticeShown == true && view?.Dialogue?.Choice?.Supported == true && dockedDialogue.LineText == view.Dialogue.Text;
            var questions = choice == null && reviewing && !readerOpen && !savePreview && !handoffOpen && !optionsOpen && !recoveryOffered && !evidenceOffered && !choiceUnderNotice;
            // More is not offered while Boopy asks for a choice or a view, and closes while Boopy listens or works. Protected-source
            // fallback offers no conversation tile, only Talk, Pause and More.
            if ((choice != null || choiceUnderNotice || evidenceOffered) && !controlsOnly || busy || captureRecovery || mode == "listening") morePage = 0;
            // A choice's options page under its prompt and the follow-ups behind Boopy's line, one per page, while the row can
            // act on them; the row acts on the one shown.
            if (dockedDialogue != null)
            {
                if (choice != null && !controlsOnly) dockedDialogue.SetItems(choice.Options.Select(option => option.Label).ToArray(), true);
                else if (questions && morePage == 0) dockedDialogue.SetItems(suggestions.Select(suggestion => suggestion.Question).ToArray(), false, "You could ask");
                else dockedDialogue.SetItems(System.Array.Empty<string>(), false);
            }
            var shown = dockedDialogue?.ShownItem ?? -1;
            if (questions && shown >= 0 && shown < suggestions.Count) shownSuggestionIds[shown == 0 ? ConsoleAction.FollowUpOne : ConsoleAction.FollowUpTwo] = suggestions[shown].Id;
            var context = ContextActions();
            contextPage = Mathf.Clamp(contextPage, 0, Mathf.Max(0, context.Count - 1));
            // One row of identical tiles under the panel: three equal slots on the panel's text column, so the orb stays left
            // of it. Pause, the privacy stop, keeps slot 2 in every state; each state names its first and third tiles. A speak
            // tile is always first, and on a sheet or card Back is always last. More swaps the same row in place.
            var asks = reviewing && taskActionLabel != null && !captureRecovery;
            var stop = mode == "processing" || busy && (handoffState == "preparing-local" || handoffState == "checking");
            var (first, third) = buttonRecording ? (ConsoleAction.FinishTalk, ConsoleAction.Cancel)
                : stop ? (ConsoleAction.Cancel, ConsoleAction.None)
                : recoveryOffered ? (ConsoleAction.CheckCapture, ConsoleAction.DismissCapture)
                : busy || captureRecovery || mode == "listening" ? (ConsoleAction.None, ConsoleAction.None)
                : card.gameObject.activeSelf && savePreview ? (ContextReview.CanSave(view) && !handoffStorageFailed ? ConsoleAction.Save : ConsoleAction.None, ConsoleAction.Back)
                : card.gameObject.activeSelf && handoffOpen ? (handoffRecordAvailable ? ConsoleAction.DismissCapture : ConsoleAction.None, ConsoleAction.Back)
                : card.gameObject.activeSelf ? navigator.DetailsOpen ? (navigator.CanConfirmSelected ? ConsoleAction.Confirm : ConsoleAction.None, ConsoleAction.ShelfBack)
                    : readerPage == 0 ? (ConsoleAction.ToggleIncluded, ConsoleAction.More) : (ConsoleAction.ToggleDetails, ConsoleAction.ShelfBack)
                : options.gameObject.activeSelf && settingsOpen ? (Setting(), ConsoleAction.ShelfBack)
                : options.gameObject.activeSelf ? (context.Count > 0 ? context[contextPage] : ConsoleAction.None, contextPage < context.Count - 1 ? ConsoleAction.More : ConsoleAction.ShelfBack)
                : morePage == 1 ? (ConsoleAction.Options, ConsoleAction.More)
                : morePage == 2 ? (ConsoleAction.Settings, ConsoleAction.ShelfBack)
                : (asks ? ConsoleAction.AnswerTask : ConsoleAction.Talk,
                    controlsOnly ? ConsoleAction.More
                    : evidenceOffered ? InputPolicy.SpokenOnly ? ConsoleAction.UseCurrentView : ConsoleAction.UseSpokenOnly
                    // Nothing to choose on a page without an option.
                    : choice != null ? shown >= 0 ? ConsoleAction.SendChoice : ConsoleAction.None
                    : choiceUnderNotice ? ConsoleAction.None
                    : questions && shown >= 0 ? shown == 0 ? ConsoleAction.FollowUpOne : ConsoleAction.FollowUpTwo
                    : ConsoleAction.More);
            var shelf = new[] { first, ConsoleAction.PauseScene, third };
            foreach (var action in shelf)
                if (Words(action, recoveryOffered) is string words && actions[action].AccessibleLabel != words) actions[action].Label(words);
            for (var slot = 0; slot < shelf.Length; slot++)
                if (shelf[slot] != ConsoleAction.None)
                    Put(shelf[slot], SpatialTheme.ShelfLeft + SpatialTheme.ShelfSlot / 2f + slot * (SpatialTheme.ShelfSlot + SpatialTheme.Gap), 0f, true);
            headerHit.center = Vector3.back * .004f; headerHit.size = new Vector3(header.Size.x, header.Size.y, .012f);
            headerHit.enabled = !dialogueVisible && !recoveryOffered && !evidenceOffered && reviewing && !savePreview && !busy && view?.IntentId != null;
            // The panel keeps its line's full paging target, a choice page's extra room included. Words of its own keep their
            // own height, so their panel ends one gap above the row.
            if (dialogueVisible && dockedDialogue != null) header.ReserveHeight(dockedDialogue.PanelHeight);
            else if (!ownWords) header.ReserveHeight(.160f);
            // Those words sit on the line's dark panel: across the text column with the line's 12 mm side margin, from the
            // panel's top to its bottom edge.
            if (ownWords && dialogBacking != null)
            {
                dialogBacking.transform.localPosition = new Vector3(SpatialTheme.ShelfLeft + SpatialTheme.ShelfWidth / 2f, 0f, .006f);
                dialogBacking.transform.localScale = new Vector3(SpatialTheme.ShelfWidth + .024f, header.Size.y, 1f);
                dialogBacking.enabled = true;
            }
            if (companion != null)
            {
                // Beside the line: level with the middle of the line that sits on the panel's bottom edge.
                var beside = dialogueVisible && dockedDialogue != null ? -header.Size.y / 2f + dockedDialogue.VisibleHeight / 2f : 0f;
                companionHome = new Vector3(-.215f, beside, -.018f);
                // Away beside a subject, or flying back, Boopy keeps its own path home.
                if (visitPoint == null && !returning) companion.transform.localPosition = companionHome;
                companion.SetState(voicePreparing || (busy && mode != "processing") ? "processing" : mode == "capture" ? "idle" : mode);
            }
            // An explicit sheet takes the conversation's place; closing it restores the exact caption.
            if (options.gameObject.activeSelf || card.gameObject.activeSelf) header.gameObject.SetActive(false);
            var modules = new[] { bar, options, card, header }.Where(surface => surface.gameObject.activeSelf).ToArray();
            height = modules.Sum(surface => surface.Size.y) + SpatialTheme.Gap * Mathf.Max(0, modules.Length - 1);
            // The bar stays put. Requested content unfolds upward from it.
            var y = -bar.Size.y / 2f;
            foreach (var surface in modules) { surface.transform.localPosition = new Vector3(surface.CenterX, y + surface.Size.y / 2f, 0); y += surface.Size.y + SpatialTheme.Gap; }
            if(controlsOnly) { header.gameObject.SetActive(false); card.gameObject.SetActive(false); headerHit.enabled=false; }
            transform.localScale = Vector3.one * ComfortScale;
            RefreshVisuals(0f);
        }

        // The Context sheet's actions, the recommended first: an earlier preparation to check, then preparing this context,
        // then reviewing the conversation's items.
        private List<ConsoleAction> ContextActions()
        {
            var list = new List<ConsoleAction>();
            var earlier = handoffRecoveryOffered || handoffStorageFailed;
            if (earlier) list.Add(ConsoleAction.Handoff);
            if (ContextReview.CanSave(view) && view?.Committed == null && !handoffStorageFailed) list.Add(ConsoleAction.PrepareSave);
            else if (!earlier && view?.Committed != null) list.Add(ConsoleAction.Handoff);
            if (navigator.Selected != null) list.Add(ConsoleAction.Review);
            return list;
        }
        // The setting the Settings page shows, or none while Voice is unavailable.
        private ConsoleAction Setting() => settingsPage switch
        {
            0 => ConsoleAction.Size, 1 => ConsoleAction.Sound, 2 => ConsoleAction.Motion,
            3 => speechAvailable ? ConsoleAction.Speech : ConsoleAction.None, _ => ConsoleAction.EvidenceSource,
        };
        // The words a tile reads in this state; a tile whose words never change keeps its own.
        private string? Words(ConsoleAction action, bool recovery) => action switch
        {
            ConsoleAction.Cancel => buttonRecording ? "Cancel" : "Stop",
            ConsoleAction.DismissCapture => recovery ? "New" : "Dismiss",
            ConsoleAction.AnswerTask => taskActionLabel,
            ConsoleAction.Handoff => handoffRecoveryOffered ? "Check" : handoffState == "prepared-local" ? "Status"
                : handoffState == "changed" || handoffState == "not-prepared" || handoffState == "missing" ? "Prepare"
                : handoffState == "failed" ? "Retry" : "Check",
            ConsoleAction.ToggleIncluded => navigator.Selected != null && ContextReview.IsExcluded(navigator.Selected) ? "Include" : "Exclude",
            ConsoleAction.Size => Turn(ComfortScale > 1f), ConsoleAction.Sound => Turn(SoundEnabled), ConsoleAction.Motion => Turn(reduced),
            ConsoleAction.Speech => Turn(VoiceEnabled), ConsoleAction.EvidenceSource => Turn(!InputPolicy.SpokenOnly),
            _ => null,
        };
        private static string Turn(bool on) => on ? "Turn off" : "Turn on";
        private static string Count(int index, int count) => count > 1 ? $" · {index + 1} of {count}" : "";

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
                || dockedDialogue == null || !dialogueVisible || dockedDialogue.FullText != view.Dialogue.Text
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
            // Ask sends the question the line shows.
            return index >= 0 && index < suggestions.Count && actions[action].gameObject.activeInHierarchy
                && shownSuggestionIds.TryGetValue(action, out var id) && suggestions[index].Id == id && dockedDialogue != null
                && dockedDialogue.ShownItem == index && index < dockedDialogue.Items.Count && dockedDialogue.Items[index] == suggestions[index].Question ? suggestions[index] : null;
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
            if (choice == null || busy || controlsOnly || control != ConsoleAction.SendChoice || !actions[control].gameObject.activeInHierarchy) return null;
            var index = dockedDialogue!.ShownItem;
            if (index < 0 || index >= choice.Options.Count || index >= dockedDialogue.Items.Count || dockedDialogue.Items[index] != choice.Options[index].Label) return null;
            return new ChoiceSelection { UtteranceId = view!.Dialogue!.UtteranceId, ResponseAt = view.Dialogue.At, CardId = choice.Id, OptionId = choice.Options[index].Id };
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

        private static string ShortId(string? id) => id == null ? "Context saved" : id.Length > 18 ? id.Substring(0, 18) + "..." : id;
        private static string GeometryCue(Item item) => item.Grounding.Spatial?.Outcome == "contour" && item.Grounding.Contour?.Count >= 3
            ? "Proposed contour" : item.Grounding.Kind == "box" && item.Grounding.Box != null
            ? "Approximate box" : item.Grounding.Kind == "point" && item.Grounding.Point != null
            ? "Image point" : item.Grounding.Kind == "scene" ? "Scene / no object position" : "Position unknown";
        private void Put(ConsoleAction action, float x, float y, bool show)
        {
            var control = actions[action]; control.gameObject.SetActive(show);
            control.transform.localPosition = new Vector3(x, y, -.001f);
        }
        private void Assemble()
        {
            foreach (var module in new[] { header, card, options, bar })
                if (module != null && module != bar && module.gameObject.activeSelf) module.Assemble(0f, reduced);
            RefreshVisuals(0f);
        }

        public void Inspect(Item? item)
        { if (item == null || mode != "review" || readerOpen || savePreview || navigator.DetailsOpen || !navigator.Select(item.Id)) return; Compose(); }
        public void SetOverflow(int count) { overflow = Mathf.Max(0, count); }
        public void SetBusy(bool on) { busy = on; Compose(); }
        private bool ChoiceDismissed() => view?.State == "review" && view.Committed == null && view.Attention != null && !string.IsNullOrWhiteSpace(view.Attention.UtteranceId) && view.Utterances.LastOrDefault()?.Id == view.Attention.UtteranceId && dismissedChoiceSession == view.Id && dismissedChoiceId == view.Attention.UtteranceId && nextTurnInstruction != null;
        // Boopy's latest line asks for a fresh view, or a detail about the current surroundings; the ask stands until the next turn.
        private bool EvidenceAsked() => view?.State == "review" && view.Committed == null && view.Attention != null && !string.IsNullOrWhiteSpace(view.Attention.UtteranceId)
            && view.Utterances.LastOrDefault()?.Id == view.Attention.UtteranceId
            && (view.Attention.Action == "fresh-view" || view.Attention.Action == "clarify")
            && (view.Attention.Source == "current-surroundings" || view.Attention.Source == "unknown");
        // While the ask stands, one tile switches the next turn's photo; the next turn's words show on the line.
        private void SelectEvidenceChoice(bool spoken)
        {
            if ((mode != "review" && mode != "error") || !EvidenceAsked() || !(spoken ? InputPolicy.SelectSpokenOnly() : InputPolicy.SelectCurrentView())) return;
            dismissedChoiceId = view!.Attention!.UtteranceId; dismissedChoiceSession = view.Id;
            nextTurnInstruction = spoken ? "Talk with photo sharing off." : "Look toward the subject, then Talk.";
            header!.Configure("Next turn", "", nextTurnInstruction, .145f);
            if (dockedDialogue != null && dialogueVisible) dockedDialogue.Show(DialogueStage.Response, nextTurnInstruction);
            Compose(); Assemble();
        }

        public Item? Activate(ConsoleAction action)
        {
            if (busy || captureRecovery) return navigator.Selected;
            if (action == ConsoleAction.UseCurrentView || action == ConsoleAction.UseSpokenOnly)
            { SelectEvidenceChoice(action == ConsoleAction.UseSpokenOnly); return navigator.Selected; }
            switch (action)
            {
                case ConsoleAction.Review: handoffOpen = false; readerOpen = !readerOpen; readerPage = 0; optionsOpen = false; break;
                case ConsoleAction.PrepareSave: savePreview = ContextReview.CanSave(view); readerOpen = false; optionsOpen = false; break;
                case ConsoleAction.Handoff: handoffOpen = true; optionsOpen = false; break;
                case ConsoleAction.Back: optionsOpen = false; savePreview = false; handoffOpen = false; morePage = 0; break;
                case ConsoleAction.ToggleDetails: navigator.SetDetailsOpen(!navigator.DetailsOpen); if (navigator.DetailsOpen) Pages(); break;
                case ConsoleAction.Settings: optionsOpen = !optionsOpen || !settingsOpen; settingsOpen = true; settingsPage = 0; morePage = 0; readerOpen = false; savePreview = false; handoffOpen = false; break;
                case ConsoleAction.Options: optionsOpen = !optionsOpen || settingsOpen; settingsOpen = false; contextPage = 0; morePage = 0; readerOpen = false; savePreview = false; handoffOpen = false; break;
                // More pages the row in place: the Context sheet's next actions, the reader's second row, or the conversation's
                // More pages.
                case ConsoleAction.More:
                    if (optionsOpen && !settingsOpen) contextPage++;
                    else if (readerOpen) readerPage = 1;
                    else morePage = Mathf.Min(morePage + 1, 2);
                    break;
                // Back goes up one level: from Source to its item, from the reader to the Context sheet, from More or a sheet to
                // the conversation.
                case ConsoleAction.ShelfBack:
                    if (readerOpen && navigator.DetailsOpen) { navigator.SetDetailsOpen(false); readerPage = 0; }
                    else if (readerOpen) { readerOpen = false; optionsOpen = true; settingsOpen = false; contextPage = 0; }
                    else { morePage = 0; optionsOpen = false; settingsOpen = false; }
                    break;
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
            if (action == ConsoleAction.Settings || action == ConsoleAction.PrepareSave || action == ConsoleAction.Back || action == ConsoleAction.Handoff || action == ConsoleAction.Review || action == ConsoleAction.ToggleDetails || action == ConsoleAction.Options
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
            navigator.SetPages(pages); sourcePages.Clear(); sourcePages.AddRange(pages); if (Application.isPlaying) Destroy(probe.gameObject); else DestroyImmediate(probe.gameObject);
        }

        public ConsoleAction HitAction(Ray ray, out Vector3 point)
        {
            foreach (var pair in actions) if ((!busy || pair.Key == ConsoleAction.Cancel || pair.Key == ConsoleAction.PauseScene) && pair.Value.Hit(ray, out point)) return pair.Key;
            point = default; return ConsoleAction.None;
        }
        public bool CanRelease(ConsoleAction action, Ray ray) => action != ConsoleAction.None && HitAction(ray, out _) == action;
        public bool HitSave(Ray ray, out Vector3 point) => Hit(ConsoleAction.Save, ray, out point);
        public bool HitConfirm(Ray ray, out Vector3 point) => Hit(ConsoleAction.Confirm, ray, out point);
        private bool Hit(ConsoleAction action, Ray ray, out Vector3 point) { point = default; return !busy && actions[action].Hit(ray, out point); }
        /// <summary>A pinch on the reader's card or on Settings pages it when it has more than one page; never one on a tile.</summary>
        public bool HitPage(Ray ray) => !busy && HitAction(ray, out _) == ConsoleAction.None && Pages(out _) > 1
            && (BodyHit(sheetHit, ray, out _) || readerOpen && !savePreview && !handoffOpen && BodyHit(evidenceHit, ray, out _));
        /// <summary>The next setting, item or page of its source, the first after the last.</summary>
        public void NextPage()
        {
            if (Pages(out var settings) <= 1) return;
            if (settings) settingsPage = (settingsPage + 1) % SettingsPages;
            else if (navigator.DetailsOpen) { if (!navigator.MovePage(1)) navigator.MovePage(-navigator.PageCount); }
            else if (!navigator.MoveItem(1)) navigator.MoveItem(-navigator.ItemCount);
            Compose();
        }
        private int Pages(out bool settings)
        {
            settings = options != null && options.gameObject.activeInHierarchy && settingsOpen;
            return settings ? SettingsPages : !readerOpen || card == null || !card.gameObject.activeInHierarchy ? 0
                : navigator.DetailsOpen ? navigator.PageCount : navigator.ItemCount;
        }
        /// <summary>The docked line shows another page: the row follows the item it shows.</summary>
        public void LinePaged() => Compose();
        public bool HitEvidence(Ray ray, out Vector3 point) => BodyHit(evidenceHit, ray, out point);
        public string? HitTarget(Ray ray, out Vector3 point)
        { if (BodyHit(headerHit, ray, out point)) return view?.IntentId; return BodyHit(evidenceHit, ray, out point) ? SelectedItemId : null; }
        private bool BodyHit(BoxCollider? box, Ray ray, out Vector3 point)
        { point = default; if (busy || !gameObject.activeInHierarchy || box == null || !box.enabled || !box.gameObject.activeInHierarchy || !box.Raycast(ray, out var hit, 5f)) return false; point = hit.point; return true; }
        public bool ContainsRay(Ray ray)
        {
            foreach (var surface in new[] { header, card, options, bar })
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
            foreach (var module in new[] { header, card, options, bar }) if (module != null && module.gameObject.activeSelf) module.Refresh(delta);
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
