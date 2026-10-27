#nullable enable
using TMPro;
using System.Collections.Generic;
using System.Linq;
using Boopy.Client;
using UnityEngine;

namespace Boopy.Quest
{
    public enum DialogueStage { Listening, Working, Response, Clarification, FreshView, Error, LocalSave }

    /// <summary>Actual interaction captions. No speech generation, simulated streaming or capture policy.</summary>
    public sealed class DialogueStrip : MonoBehaviour
    {
        private const float Width = .40f, Height = .16f;
        private float CaptionWidth => narrowed ?? (dock != null && host?.CaptionHasTrailingAction == true ? .34f : Width);
        /// <summary>The caption's wrap width, in meters.</summary>
        public float WrapWidth => CaptionWidth;
        // Over a recording the wrap narrows a step at a time when no home on the frame fits the caption (DESIGN), then its pages
        // shorten to two lines; never narrower than about 28 characters a line (WrapFloor), and never to a one-word last row.
        private static readonly (float Width, bool Short)[] NarrowSteps = { (.36f, false), (.32f, false), (Width, true), (.36f, true), (.32f, true) };
        private const int WrapFloor = 28;
        private float? narrowed;
        private bool shortPages;
        private int narrowStep;
        private const float FullCaptionHeight = .102f;
        // A page's height: the full one, or two lines once a recording has no home for the full page (DESIGN, ROOT).
        private float CaptionHeight => shortPages && lineHeight > 0f ? 2.1f * lineHeight : FullCaptionHeight;
        // A question alone on its page may take two more lines, so one question fits one page; its panel grows upward to fit.
        private const float ItemRoom = .060f;
        private SpatialSurface? dock;
        private ContextConsole? host;
        private Transform? fallbackParent;
        private bool fallback, cancelableWait;
        private SpatialAction? fallbackStop;
        private bool noticeActive, restoreVisible, voicePreparing;
        // A task line's speaker and delivery state, in place of the stage words. Null for every other line.
        private string? taskSpeaker, previousTaskSpeaker;
        // Boopy's thinking phrases while this working line is a turn with the Mac. Null for every other line.
        private ThinkingPhrases? thinking, previousThinking;
        private string previousText = "";
        private DialogueStage previousStage;
        private float noticeExpires, stageStartedAt, previousStartedAt;
        private Transform? head;
        private TextMeshPro? speaker, caption, shownItem, hint;
        // On a recording the line is a caption with no panel: a soft Graphite shadow behind each of its lines, this strong at
        // its middle and reaching this share of a line's height past the strokes; and where its hint was set.
        private bool boxless;
        private readonly Dictionary<TextMeshPro, (MeshRenderer Renderer, Mesh Mesh)> shadows = new Dictionary<TextMeshPro, (MeshRenderer, Mesh)>();
        public const float ShadowStrength = .55f, ShadowReach = .3f;
        // Over a recording, how to read the footage under a line from its world corners: its darkest and brightest luminance.
        private System.Func<Vector3[], (float Darkest, float Brightest)>? ground;
        private readonly Dictionary<int, (float Darkest, float Brightest)> grounds = new Dictionary<int, (float Darkest, float Brightest)>();
        private int groundShown;

        /// <summary>
        /// Over a recording, how to read the footage under each caption line, and what it shows now (<paramref name="shown"/>
        /// changes with the still or the playing clip, so what was read is read again); null in the room.
        /// </summary>
        public void SetGround(System.Func<Vector3[], (float Darkest, float Brightest)>? under, int shown = 0)
        {
            if (under == null || shown != groundShown) grounds.Clear();
            ground = under; groundShown = shown;
        }

        /// <summary>
        /// The ink, the shadow behind it and each line's strength for one boxless text over the footage under its lines: one
        /// style for every line (DESIGN), Frost on the dark Graphite shadow, the shadow raised line by line until that line
        /// clears 4.5:1 against the brightest footage under it (AUDIT). Colors blend in linear space.
        /// </summary>
        public static (Color Ink, Color Glow, float[] Strengths) Contrast(IReadOnlyList<(float Darkest, float Brightest)> lines)
        {
            var frost = WordBlock.Luminance(WordBlock.Frost); var graphite = WordBlock.Luminance(WordBlock.Graphite);
            // The most light the footage may let through behind Frost for 4.5:1.
            var most = (frost + .05f) / 4.5f - .05f;
            return (WordBlock.Frost, WordBlock.Graphite, lines.Select(line =>
                Mathf.Clamp(line.Brightest <= most ? 0f : (line.Brightest - most) / (line.Brightest - graphite) + .01f, ShadowStrength, 1f)).ToArray());
        }
        private string? hintFor;
        private Vector3 velocity;
        private bool reduced;
        private float animationTime;
        private bool interactionLocked;
        private readonly List<string> pages = new List<string>();
        // The item each page shows: -1 for the line's own words.
        private readonly List<int> pageItems = new List<int>();
        private readonly List<float> pageHeights = new List<float>();
        private readonly List<string> items = new List<string>();
        private bool itemsUnderLine, itemsUnder;
        private string? itemSpeaker;
        private int page, previousPage;
        private BoxCollider? pageHit;
        private Transform? reveal;
        private float revealAge;
        // A thinking line's one change into its answer, from when the answer came: its words fade out from ChangeStarts,
        // the panel grows upward from ChangeStarts to GrowthEnds with its bottom edge fixed, and the answer's words fade in
        // from AnswerShows. With reduced motion the same order holds with one cut at ChangeStarts. -1 when no change runs.
        private const float ChangeStarts = .15f, AnswerShows = .25f, GrowthEnds = .35f, ChangeEnds = .40f;
        private float changeAge = -1f;
        private string leavingWords = "";
        // The panel's left and right edges and its height, for the thinking line and for its answer.
        private Vector3 leavingPanel, arrivingPanel;
        private Transform? captionBacking;
        private MeshRenderer? backingRenderer;
        private Mesh? backingMesh;
        private MaterialPropertyBlock? backingTint;
        public DialogueStage Stage { get; private set; }
        public string FullText { get; private set; } = "";
        public string VisibleText => (caption?.text ?? "") + (shownItem != null && shownItem.gameObject.activeSelf ? "\n" + shownItem.text : "");
        public string SpeakerText => speaker?.text ?? "";
        public int PageCount => pages.Count;
        /// <summary>The item the page shown holds, or -1 while the line's own words show.</summary>
        public int ShownItem => page < pageItems.Count ? pageItems[page] : -1;
        public IReadOnlyList<string> Items => items;
        private bool Changing => changeAge >= 0f;
        private bool Still => host?.ReducedMotion ?? reduced;
        private float SwapAt => Still ? ChangeStarts : AnswerShows;
        // The thinking line's words still show in place of the answer's.
        private bool Holding => changeAge >= 0f && changeAge < SwapAt;

        public static DialogueStrip Create(Transform parent, Transform head)
        {
            var go = new GameObject("Boopy dialogue"); go.transform.SetParent(parent, false);
            var strip = go.AddComponent<DialogueStrip>(); strip.head = head;
            strip.fallbackParent = parent;
            strip.reveal = new GameObject("Caption entrance").transform;
            strip.reveal.SetParent(go.transform, false);
            var backing=new GameObject("Speech contrast backing");backing.transform.SetParent(strip.reveal,false);
            strip.captionBacking=backing.transform;strip.backingMesh=RoundedPlate.Create(1f,1f,.06f);
            backing.AddComponent<MeshFilter>().sharedMesh=strip.backingMesh;
            strip.backingRenderer=backing.AddComponent<MeshRenderer>();strip.backingRenderer.sharedMaterial=Visuals.Solid;
            strip.backingRenderer.sortingOrder=2;strip.backingTint=new MaterialPropertyBlock();
            strip.speaker = SpatialTheme.Text(strip.reveal, "Actual speaker and state", SpatialTheme.Utility, SpatialTheme.Smoke);
            strip.speaker.rectTransform.sizeDelta = new Vector2(Width, .036f);
            strip.speaker.transform.localPosition = new Vector3(0, .064f, -.004f);
            // The speaker label rests on its line: bottom-aligned in its band, the line's first words top-aligned right under it.
            strip.speaker.alignment = TextAlignmentOptions.BottomLeft;
            strip.caption = SpatialTheme.Text(strip.reveal, "Actual response", SpatialTheme.Body, SpatialTheme.Ivory);
            strip.caption.rectTransform.sizeDelta = new Vector2(Width, FullCaptionHeight);
            strip.caption.transform.localPosition = new Vector3(0, .042f - FullCaptionHeight / 2f, -.004f);
            strip.caption.alignment = TextAlignmentOptions.TopLeft;
            strip.caption.overflowMode = TextOverflowModes.Truncate;
            // A choice's option shown under its prompt: its own paragraph, one gap below, in the line's type.
            strip.shownItem = SpatialTheme.Text(strip.reveal, "Shown item", SpatialTheme.Body, SpatialTheme.Ivory);
            strip.shownItem.alignment = TextAlignmentOptions.TopLeft;
            strip.shownItem.gameObject.SetActive(false);
            // A small hint under the line on a recording, such as "Hold to answer".
            strip.hint = SpatialTheme.Text(strip.reveal, "Hint", SpatialTheme.Utility, SpatialTheme.Smoke);
            strip.hint.alignment = TextAlignmentOptions.TopLeft;
            strip.hint.rectTransform.sizeDelta = new Vector2(Width, .03f);
            strip.hint.gameObject.SetActive(false);
            strip.pageHit = go.AddComponent<BoxCollider>(); strip.pageHit.size = new Vector3(Width, Height, .012f);
            strip.fallbackStop = SpatialAction.Create(go.transform, ConsoleAction.Cancel, "Stop waiting", .18f);
            strip.fallbackStop.transform.localPosition = new Vector3(0f, -.105f, -.004f);
            strip.fallbackStop.gameObject.SetActive(false);
            go.SetActive(false); return strip;
        }

        /// <summary>Production captions share the companion anchor and replace its status copy.</summary>
        public void DockTo(SpatialSurface surface, ContextConsole owner)
        {
            dock = surface; host = owner;
            transform.SetParent(surface.transform, false);
            transform.localPosition = Docked(CaptionWidth);
            transform.localRotation = Quaternion.identity;
            transform.localScale = Vector3.one;
            host.SetDialogueVisible(gameObject.activeSelf);
        }

        // Docked, the caption's left edge keeps beside Boopy on his right; mirrored, its right edge keeps beside him on his left.
        private Vector3 Docked(float width) => new Vector3(host != null && host.Mirrored ? .185f - width / 2f : -.135f + width / 2f, 0f, -.004f);

        /// <summary>Takes the docked place again, on Boopy's side as he now sits.</summary>
        public void Redock() { if (dock != null && !fallback) transform.localPosition = Docked(CaptionWidth); }

        /// <summary>Wraps the caption one step narrower, or its pages shorter, its words kept from its first page; false at the last step.</summary>
        public bool Narrow()
        {
            if (caption == null || speaker == null) return false;
            if (lineHeight <= 0f) _ = LineHeight;
            var (wasNarrowed, wasShort) = (narrowed, shortPages);
            // The narrowest wrap still holds about 28 characters of these words on a line.
            var words = ScriptCoverage.Prepare(FullText);
            var floor = words.Length <= WrapFloor ? Width : caption.GetPreferredValues(words.Substring(0, WrapFloor), Mathf.Infinity, Mathf.Infinity).x;
            while (narrowStep < NarrowSteps.Length)
            {
                var (next, brief) = NarrowSteps[narrowStep++];
                if (next < floor - 1e-4f || (next >= CaptionWidth - 1e-4f && brief == shortPages)) continue;
                Wrap(next, brief);
                if (!OneWordLastRow()) return true;
            }
            Wrap(wasNarrowed, wasShort);
            return false;
        }

        private void Wrap(float? width, bool brief)
        {
            narrowed = width; shortPages = brief;
            var wrap = CaptionWidth;
            speaker!.rectTransform.sizeDelta = new Vector2(wrap, .036f);
            caption!.rectTransform.sizeDelta = new Vector2(wrap, CaptionHeight);
            if (pageHit != null) pageHit.size = new Vector3(wrap, Height, .012f);
            Redock();
            Paginate();
        }

        // The page shown ends on a row of one word under others: what a narrower wrap must not leave.
        private bool OneWordLastRow()
        {
            if (caption == null) return false;
            caption.ForceMeshUpdate(true, true);
            var info = caption.textInfo;
            if (info.lineCount < 2) return false;
            var last = info.lineInfo[info.lineCount - 1];
            // The row's drawn characters, not the source's: a prepared line may carry font tags.
            var row = new string(Enumerable.Range(last.firstCharacterIndex, Mathf.Max(0, last.lastCharacterIndex - last.firstCharacterIndex + 1))
                .Where(at => at < info.characterCount).Select(at => info.characterInfo[at].character).ToArray()).Trim();
            return row.Length > 0 && !row.Contains(' ');
        }

        /// <summary>Keep the exact caption readable when object keepouts hide the companion.
        /// This is an ungrounded subtitle, never a substitute spatial annotation.</summary>
        public void SetFallback(bool value)
        {
            if (dock == null || fallback == value) return;
            fallback = value;
            transform.SetParent(value ? fallbackParent : dock.transform, false);
            transform.localScale = Vector3.one * (value ? host?.ComfortScale ?? 1f : 1f);
            if (value) { if (!PlaceFallback()) { transform.position = Target(); Face(); } velocity = Vector3.zero; }
            else
            {
                transform.localPosition = Docked(CaptionWidth);
                transform.localRotation = Quaternion.identity;
            }
            if (speaker != null) speaker.alpha = 1f;
            if (caption != null) caption.alpha = 1f;
            if (shownItem != null) shownItem.alpha = 1f;
            // The line fades in where it now stands, its answer whole.
            EndChange();
            revealAge = 0f;
            RefreshFallbackAction();
        }

        /// <summary>
        /// A task's line on this same strip: the speaker line reads the task's speaker and "Not sent"
        /// where state words go, and the caption is the task's text exactly. Empty text leaves the
        /// speaker line alone.
        /// </summary>
        public void ShowTask(string speakerLine, string words)
        {
            Show(DialogueStage.Response, words);
            taskSpeaker = speakerLine;
            RefreshSpeaker();
        }

        /// <summary>
        /// The thinking line while a turn is with the Mac: one of Boopy's phrases, then the next about every
        /// <see cref="ThinkingPhrases.Seconds"/> seconds. Any other line takes its place.
        /// </summary>
        public void ShowThinking(ThinkingPhrases phrases)
        {
            Show(DialogueStage.Working, phrases.Next());
            thinking = phrases;
        }

        public void Show(DialogueStage stage, string words) => Present(stage, words, true);

        private void Present(DialogueStage stage, string words, bool mayChange)
        {
            // A docked thinking line changes into the line that answers it; any other line, an error too, cuts in.
            float left = 0f, right = 0f, bottom = 0f, top = 0f;
            var changes = mayChange && Stage == DialogueStage.Working && Answers(stage)
                && dock != null && !fallback && !noticeActive && gameObject.activeSelf && caption != null && PanelEdges(out left, out right, out bottom, out top);
            if (changes) { changeAge = 0f; leavingWords = caption!.text; leavingPanel = arrivingPanel = new Vector3(left, right, top - bottom); }
            else changeAge = -1f;
            noticeActive = false; voicePreparing = false; taskSpeaker = null; thinking = null;
            Stage = stage; FullText = words; stageStartedAt = Time.unscaledTime;
            revealAge = 0f;
            // Each working line starts its shimmer on its first glyph.
            if (stage == DialogueStage.Working) animationTime = 0f;
            if (caption == null || speaker == null) return;
            // A new line starts at the full wrap and page; a recording may narrow it again.
            narrowed = null; shortPages = false; narrowStep = 0;
            var width = CaptionWidth;
            speaker.rectTransform.sizeDelta = new Vector2(width, .036f);
            caption.rectTransform.sizeDelta = new Vector2(width, CaptionHeight);
            if (pageHit != null) pageHit.size = new Vector3(width, Height, .012f);
            if (dock != null && !fallback) transform.localPosition = Docked(width);
            // A new line's items are its own: the console names them again for this line.
            items.Clear(); itemsUnderLine = false; itemSpeaker = null;
            Paginate();
            if (dock == null && !gameObject.activeSelf) { transform.position = Target(); velocity = Vector3.zero; }
            host?.SetDialogueVisible(true);
            gameObject.SetActive(true); RefreshFallbackAction(); Face(); RefreshVisuals(0f);
        }
        public void Hide() { noticeActive = false; changeAge = -1f; gameObject.SetActive(false); host?.SetDialogueVisible(false); }
        public void ShowNotice(string words, float seconds)
        {
            var visible = noticeActive ? restoreVisible : gameObject.activeSelf;
            var savedText = noticeActive ? previousText : FullText;
            var savedStage = noticeActive ? previousStage : Stage;
            var savedPage = noticeActive ? previousPage : page;
            var savedStartedAt = noticeActive ? previousStartedAt : stageStartedAt;
            var savedSpeaker = noticeActive ? previousTaskSpeaker : taskSpeaker;
            var savedThinking = noticeActive ? previousThinking : thinking;
            Present(DialogueStage.Clarification, words, false);
            restoreVisible = visible; previousText = savedText; previousStage = savedStage; previousPage = savedPage; previousStartedAt = savedStartedAt;
            previousTaskSpeaker = savedSpeaker; previousThinking = savedThinking;
            noticeExpires = seconds > 0 ? Time.unscaledTime + seconds : float.PositiveInfinity;
            noticeActive = true;
            // The row knows a line still stands under the notice.
            host?.LinePaged();
        }
        /// <summary>Whether a notice covers the line for now.</summary>
        public bool NoticeShown => noticeActive;
        /// <summary>The line itself: under a notice, the one that comes back when it ends.</summary>
        public string LineText => noticeActive ? previousText : FullText;
        public void ClearNotice()
        {
            if (!noticeActive) return;
            noticeActive = false;
            if (restoreVisible) { Show(previousStage, previousText); taskSpeaker = previousTaskSpeaker; thinking = previousThinking; page = Mathf.Clamp(previousPage, 0, pages.Count - 1); stageStartedAt = previousStartedAt; DrawPage(); host?.LinePaged(); } else Hide();
        }
        /// <summary>Only an actual cancellable local wait may offer this fallback action.</summary>
        public void SetCancelableWait(bool value) { cancelableWait = value; RefreshFallbackAction(); }
        public ConsoleAction HitFallbackAction(Ray ray, out Vector3 point)
        {
            point = default;
            return fallback && host?.HasVisibleBar != true && cancelableWait && Stage == DialogueStage.Working && fallbackStop != null
                && fallbackStop.Hit(ray, out point) ? ConsoleAction.Cancel : ConsoleAction.None;
        }
        public void FocusFallbackAction(bool focused) => fallbackStop?.Focus(focused);
        public void PressFallbackAction(bool pressed) => fallbackStop?.Press(pressed);
        private void RefreshFallbackAction()
        {
            if (fallbackStop == null) return;
            var enabled = fallback && host?.HasVisibleBar != true && cancelableWait && Stage == DialogueStage.Working;
            fallbackStop.gameObject.SetActive(enabled);
            if (!enabled) { fallbackStop.Focus(false); fallbackStop.Press(false); }
        }
        public void SetInteractionLocked(bool locked) => interactionLocked = locked;

        /// <summary>
        /// Items this line offers, one per page after the line's own words, or each under the line (a choice's options under
        /// its prompt), with <paramref name="speaker"/> on an item's page in place of the line's speaker. The same items again
        /// keep the page shown.
        /// </summary>
        public void SetItems(IReadOnlyList<string> offered, bool underLine, string? speaker = null)
        {
            if (offered.Count == 0 && items.Count == 0) return;
            if (underLine == itemsUnderLine && speaker == itemSpeaker && offered.SequenceEqual(items)) return;
            items.Clear(); items.AddRange(offered); itemsUnderLine = underLine && offered.Count > 0; itemSpeaker = speaker;
            Paginate();
        }

        // The line's pages: its words in pieces that fit the caption, then each item's alone, every character kept of the words
        // as drawn (a run no face can show is DESIGN's line in its place; FullText keeps the words themselves).
        // Items under the line, a choice's options, each share a page with the whole line, which the contract bounds (a
        // 160-character prompt, 60-character options); every such page takes the tallest one's height, so paging never moves
        // the panel's top, and the panel grows upward to hold it.
        private void Paginate()
        {
            pages.Clear(); pageItems.Clear(); pageHeights.Clear(); page = 0;
            if (caption == null) return;
            itemsUnder = itemsUnderLine;
            var line = ScriptCoverage.Prepare(FullText);
            var tallest = itemsUnder ? Mathf.Max(CaptionHeight, items.Max(item => Under(line, item))) : CaptionHeight;
            if (!itemsUnder) Pieces(line, -1, CaptionHeight);
            for (var item = 0; item < items.Count; item++)
                if (!itemsUnder) Pieces(ScriptCoverage.Prepare(items[item]), item, CaptionHeight + ItemRoom);
                else { pages.Add(line); pageItems.Add(item); pageHeights.Add(tallest); }
            if (pages.Count == 0) { pages.Add(""); pageItems.Add(-1); pageHeights.Add(CaptionHeight); }
            DrawPage();
        }

        // The height of the line with an item one gap under it.
        private float Under(string line, string item) => SpatialTheme.Height(caption!, line, CaptionWidth) + SpatialTheme.Gap
            + SpatialTheme.Height(caption!, ScriptCoverage.Prepare(item), CaptionWidth);

        private void Pieces(string words, int item, float budget)
        {
            var width = CaptionWidth; var start = 0;
            while (start < words.Length)
            {
                var low = 1; var high = words.Length - start;
                while (low < high)
                {
                    var mid = (low + high + 1) / 2;
                    if (SpatialTheme.Height(caption!, words.Substring(start, mid), width) <= budget) low = mid;
                    else high = mid - 1;
                }
                if (start + low < words.Length && low > 1 && char.IsHighSurrogate(words[start + low - 1])) low--;
                // Prefer a natural boundary while preserving every source character, including whitespace.
                if (start + low < words.Length)
                {
                    var boundary = words.LastIndexOf(' ', start + low - 1, low);
                    if (boundary >= start + low / 2) low = boundary - start + 1;
                }
                var piece = words.Substring(start, low);
                pages.Add(piece); pageItems.Add(item); start += low;
                pageHeights.Add(budget > CaptionHeight && SpatialTheme.Height(caption!, piece, width) > CaptionHeight ? budget : CaptionHeight);
            }
        }

        public bool HitPage(Ray ray) => HitFallbackAction(ray, out _) == ConsoleAction.None && (host == null || host.HitAction(ray, out _) == ConsoleAction.None) && gameObject.activeInHierarchy && pages.Count > 1 && pageHit != null && pageHit.Raycast(ray, out _, 3f);
        /// <summary>The next page, the first after the last; the console's row follows the item it shows.</summary>
        public void NextPage() { if (pages.Count > 1) { page = (page + 1) % pages.Count; DrawPage(); host?.LinePaged(); } }
        private void DrawPage()
        {
            revealAge = 0f;
            if (speaker == null || caption == null) return;
            RefreshSpeaker();
            caption.text = pages[page];
            var height = CaptionHeight + Extra;
            caption.rectTransform.sizeDelta = new Vector2(CaptionWidth, height);
            caption.transform.localPosition = new Vector3(caption.transform.localPosition.x, .042f - height / 2f, caption.transform.localPosition.z);
            // The hint keeps its row under the page as drawn now, in this frame.
            if (hintFor != null && hint != null && hint.gameObject.activeSelf) { caption.ForceMeshUpdate(true, true); SetHint(hintFor); }
            DrawItem();
            if (!Holding) return;
            // The answer is measured now, so the panel can grow to it; the thinking words stay until they have faded.
            if (PanelEdges(out var left, out var right, out var bottom, out var top)) arrivingPanel = new Vector3(left, right, top - bottom);
            speaker.text = ""; caption.text = leavingWords;
            if (shownItem != null) shownItem.gameObject.SetActive(false);
        }

        // Ends a change at once, the answer's words in place.
        private void EndChange()
        {
            if (changeAge < 0f) return;
            var held = Holding;
            changeAge = -1f;
            if (held) DrawPage();
        }
        // The item shown under the line: its ink starts one gap below the line's last words.
        private void DrawItem()
        {
            if (shownItem == null || caption == null) return;
            var show = itemsUnder && ShownItem >= 0;
            shownItem.gameObject.SetActive(show);
            if (!show) return;
            shownItem.text = ScriptCoverage.Prepare(items[ShownItem]);
            shownItem.rectTransform.sizeDelta = new Vector2(CaptionWidth, CaptionHeight + Mathf.Max(ItemRoom, Extra));
            caption.ForceMeshUpdate(true, true);
            var lineBottom = caption.transform.localPosition.y + caption.textBounds.min.y;
            shownItem.transform.localPosition = new Vector3(caption.transform.localPosition.x, lineBottom - SpatialTheme.Gap - shownItem.rectTransform.sizeDelta.y / 2f, caption.transform.localPosition.z);
            shownItem.ForceMeshUpdate(true, true);
            var itemTop = shownItem.transform.localPosition.y + shownItem.textBounds.max.y;
            shownItem.transform.localPosition += Vector3.up * (lineBottom - SpatialTheme.Gap - itemTop);
        }
        // The room the page shown takes beyond a line's own caption.
        private float Extra => page < pageHeights.Count ? pageHeights[page] - CaptionHeight : 0f;
        /// <summary>The panel's full height for the page shown: the line's, and a choice page's extra room.</summary>
        public float PanelHeight => Height + Extra;
        private bool VoicePreparationStage => Answers(Stage);
        // The stages that answer a turn, and may be spoken.
        private static bool Answers(DialogueStage stage) => stage == DialogueStage.Response || stage == DialogueStage.Clarification
            || stage == DialogueStage.FreshView || stage == DialogueStage.LocalSave;
        public void SetVoicePreparing(bool preparing)
        {
            voicePreparing = preparing && VoicePreparationStage;
            RefreshSpeaker();
        }
        private void RefreshSpeaker()
        {
            if (speaker == null) return;
            speaker.text = (Stage == DialogueStage.Listening || Stage == DialogueStage.Working ? ""
                : voicePreparing && VoicePreparationStage ? "Preparing voice…"
                : ShownItem >= 0 && itemSpeaker != null ? itemSpeaker
                : taskSpeaker ?? ((Stage == DialogueStage.Response || Stage == DialogueStage.LocalSave) ? "Boopy" : "Boopy · " + StateName(Stage)))
                + (pages.Count > 1 ? $" · {page + 1} of {pages.Count}" : "");
        }
        public void SetComfort(float scale, bool reducedMotion)
        {
            transform.localScale = Vector3.one * (dock != null && !fallback ? 1f : Mathf.Clamp(scale, 1f, 1.2f)); reduced = reducedMotion;
        }
        private static string StateName(DialogueStage stage) => stage switch
        {
            DialogueStage.Listening => "Listening", DialogueStage.Working => "Working",
            DialogueStage.Clarification => "Needs detail", DialogueStage.FreshView => "Needs a view",
            DialogueStage.Error => "Needs attention", DialogueStage.LocalSave => "Context ready",
            _ => "Response",
        };
        private bool PlaceFallback()
        {
            if (!fallback || host == null || !host.TryFallbackPose(Height / 2f, out var position, out var rotation)) return false;
            transform.SetPositionAndRotation(position, rotation);
            transform.localScale = Vector3.one * host.ComfortScale;
            return true;
        }
        private Vector3 Target()
        {
            if (head == null) return transform.position;
            return head.position + Quaternion.AngleAxis(16f, head.right) * head.forward * .9f;
        }
        private void Face()
        {
            if (PlaceFallback()) return;
            if ((dock == null || fallback) && head != null) transform.rotation = Quaternion.LookRotation(transform.position - head.position, Vector3.up);
        }
        private void LateUpdate() => RefreshVisuals(Time.unscaledDeltaTime);
        public void RefreshVisuals(float delta)
        {
            if (noticeActive && Time.unscaledTime >= noticeExpires) ClearNotice();
            // The next thinking phrase about every three seconds; the change is a cut.
            if (thinking != null && Stage == DialogueStage.Working && Time.unscaledTime - stageStartedAt >= ThinkingPhrases.Seconds) ShowThinking(thinking);
            var still=host?.ReducedMotion ?? reduced;
            if(!still)animationTime+=Mathf.Max(0f,delta);
            revealAge += Mathf.Max(0f, delta);
            if (changeAge >= 0f)
            {
                var before = changeAge;
                changeAge += Mathf.Max(0f, delta);
                if (before < SwapAt && changeAge >= SwapAt) DrawPage();
                if (changeAge >= ChangeEnds) { changeAge = -1f; revealAge = 1f; }
            }
            var changing = changeAge >= 0f;
            // The working line is whole on its first frame, shimmer included: no fade of its own and none from
            // the console's reveal. It is one line with no timer. A move by fade carries every line.
            var working = Stage == DialogueStage.Working;
            var entered = working ? 1f : Mathf.Clamp01(revealAge / (still ? .12f : .18f));
            var eased = entered * entered * (3f - 2f * entered);
            if (reveal != null) reveal.localPosition = still || changing ? Vector3.zero : Vector3.down * (.006f * (1f-eased));
            var carried = dock != null && !fallback && (!working || host?.Relocating == true) ? dock.Opacity : 1f;
            var opacity = (changing ? ChangeWords(changeAge, still) : entered) * carried;
            if (speaker != null) speaker.alpha = opacity;
            fallbackStop?.Refresh(delta, 1f, host?.ReducedMotion ?? reduced);
            // The panel itself stays through a change: only its words fade.
            RefreshBacking(changing ? carried : opacity);
            if (caption != null)
            {
                caption.alpha = opacity;
                TextShimmer.Apply(caption, animationTime, (Stage == DialogueStage.Working || Holding) && !still, opacity);
            }
            if (shownItem != null) shownItem.alpha = opacity;
            if (hint != null) hint.alpha = opacity;
            ShadeLines(opacity);
            if (dock != null && !fallback) return;
            // Resolve from the current expanded controls every frame; independent damping can
            // sweep the subtitle through Settings, and independent facing defeats the bar lock.
            if (PlaceFallback()) return;
            if (interactionLocked) return;
            transform.position = reduced ? Target() : Vector3.SmoothDamp(transform.position, Target(), ref velocity, .22f);
            Face();
        }
        // The words' opacity in a change: the thinking words out, then the answer's in; with reduced motion one cut.
        private static float ChangeWords(float age, bool still) => still || age < ChangeStarts ? 1f
            : age < AnswerShows ? 1f - (age - ChangeStarts) / (AnswerShows - ChangeStarts)
            : Mathf.Clamp01((age - AnswerShows) / (ChangeEnds - AnswerShows));

        // The speaker line's and caption's ink, in the line's own frame.
        private bool Ink(out Bounds bounds)
        {
            bounds=new Bounds();var found=false;
            foreach(var text in new[]{speaker,caption,shownItem != null && shownItem.gameObject.activeSelf ? shownItem : null})
            {
                if(text==null || string.IsNullOrWhiteSpace(text.text))continue;
                text.ForceMeshUpdate(true,true);var ink=text.textBounds;
                if(ink.size.x<=0 || ink.size.y<=0)continue;
                ink.center+=text.transform.localPosition;
                if(!found){bounds=ink;found=true;}else bounds.Encapsulate(ink);
            }
            return found;
        }

        /// <summary>The panel's height for this line alone: its ink with the backing's margins. In a change, the answer's.</summary>
        public float VisibleHeight => Changing ? arrivingPanel.z : PanelEdges(out _, out _, out var bottom, out var top) ? top - bottom : 0f;

        // The panel around the words shown: 12 mm beside them, 8 mm above and below, inside the line's own bounds.
        private bool PanelEdges(out float left, out float right, out float bottom, out float top)
        {
            left = right = bottom = top = 0f;
            if (!Ink(out var bounds)) return false;
            left=Mathf.Max(-CaptionWidth/2f-.012f,bounds.min.x-.012f);
            right=Mathf.Min(CaptionWidth/2f+.012f,bounds.max.x+.012f);
            bottom=Mathf.Max(-Height/2f-Extra,bounds.min.y-.008f);
            top=Mathf.Min(Height/2f,bounds.max.y+.008f);
            return true;
        }

        private void RefreshBacking(float opacity)
        {
            if(captionBacking==null || backingRenderer==null || backingTint==null)return;
            var found=PanelEdges(out var left, out var right, out var bottom, out var top);
            backingRenderer.sortingOrder=2;
            backingRenderer.enabled=found && !boxless;
            if(!found)return;
            if(changeAge>=0f && dock!=null && !fallback)
            {
                // From the thinking line's panel to the answer's, eased out, under the words' top margin; the bottom edge
                // stays on the console panel's.
                var grown=Still ? (changeAge<ChangeStarts ? 0f : 1f) : 1f-Mathf.Pow(1f-Mathf.Clamp01((changeAge-ChangeStarts)/(GrowthEnds-ChangeStarts)),3f);
                var edges=Vector3.Lerp(leavingPanel,arrivingPanel,grown);
                left=edges.x; right=edges.y; bottom=top-edges.z;
            }
            captionBacking.localPosition=new Vector3((left+right)/2f,(bottom+top)/2f,.002f);
            captionBacking.localScale=new Vector3(Mathf.Max(.01f,right-left),Mathf.Max(.01f,top-bottom),1f);
            // Docked, the line's panel sits on the console panel's bottom edge, one gap above the row, and grows upward with
            // the line; the row never moves.
            if(dock!=null && !fallback)
            {
                transform.localPosition=new Vector3(transform.localPosition.x,-dock.Size.y/2f-bottom,transform.localPosition.z);
                // Paging is a pinch on the panel itself, never on the row of tiles under it.
                if(pageHit!=null){pageHit.center=new Vector3(0,(top+bottom)/2f,0);pageHit.size=new Vector3(CaptionWidth,top-bottom,.012f);}
            }
            else if(pageHit!=null){pageHit.center=Vector3.zero;pageHit.size=new Vector3(CaptionWidth,Height,.012f);}
            var panel=SpatialTheme.Panel;panel.a*=opacity;backingTint.SetColor("_Color",panel);backingRenderer.SetPropertyBlock(backingTint);
        }
        /// <summary>
        /// On a recording the line is a caption with no box over the footage: Frost words at full strength, each line of them
        /// on a soft Graphite shadow that darkens the footage right behind and around its strokes (about half its light),
        /// fading out past them so it reads as a shadow and not a box. False gives the line its panel and its usual type back.
        /// </summary>
        public void SetBoxless(bool on)
        {
            if (boxless == on) return;
            boxless = on;
            foreach (var (text, usual) in Lines()) if (text != null) text.color = on ? WordBlock.Frost : usual;
            foreach (var shadow in shadows.Values) shadow.Renderer.enabled = false;
            if (backingRenderer != null) backingRenderer.enabled = backingRenderer.enabled && !on;
        }

        // Behind each shown line of a boxless caption, its shadow: full strength over the line's own extent, fading to clear
        // ShadowReach of the line's height beyond it on every side, at the words' own opacity.
        private void ShadeLines(float opacity)
        {
            foreach (var (text, _) in Lines())
            {
                if (text == null) continue;
                var shown = boxless && text.gameObject.activeInHierarchy && !string.IsNullOrEmpty(text.text);
                if (!shadows.TryGetValue(text, out var shadow))
                {
                    if (!shown) continue;
                    var host = new GameObject("Caption shadow"); host.transform.SetParent(text.transform, false);
                    host.transform.localPosition = new Vector3(0f, 0f, .001f);
                    var mesh = new Mesh { name = "Caption shadow" };
                    host.AddComponent<MeshFilter>().sharedMesh = mesh;
                    var renderer = host.AddComponent<MeshRenderer>(); renderer.sharedMaterial = Visuals.Solid;
                    renderer.sortingOrder = text.sortingOrder - 1; renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
                    shadow = (renderer, mesh); shadows[text] = shadow;
                }
                shadow.Renderer.enabled = shown;
                if (!shown) continue;
                text.ForceMeshUpdate();
                var info = text.textInfo;
                var vertices = new List<Vector3>(); var colors = new List<Color>(); var triangles = new List<int>();
                var extents = new List<(float X0, float X1, float Y0, float Y1)>();
                for (var l = 0; l < info.lineCount; l++)
                {
                    var line = info.lineInfo[l];
                    if (line.visibleCharacterCount > 0) extents.Add((line.lineExtents.min.x, line.lineExtents.max.x, line.descender, line.ascender));
                }
                // Each line's contrast over the footage under it (AUDIT); with nothing to read, Frost on the usual shadow.
                var (ink, glow, strengths) = ground == null ? (WordBlock.Frost, WordBlock.Graphite, extents.Select(_ => ShadowStrength).ToArray())
                    : Contrast(extents.Select(line => Ground(text, line)).ToList());
                text.color = new Color(ink.r, ink.g, ink.b, text.color.a);
                for (var l = 0; l < extents.Count; l++)
                {
                    var (x0, x1, y0, y1) = extents[l];
                    var reach = ShadowReach * (y1 - y0);
                    float[] xs = { x0 - reach, x0, x1, x1 + reach }, ys = { y0 - reach, y0, y1, y1 + reach };
                    var first = vertices.Count;
                    for (var row = 0; row < 4; row++)
                        for (var column = 0; column < 4; column++)
                        {
                            vertices.Add(new Vector3(xs[column], ys[row], 0f));
                            colors.Add(new Color(1f, 1f, 1f, row is 1 or 2 && column is 1 or 2 ? strengths[l] : 0f));
                        }
                    for (var row = 0; row < 3; row++)
                        for (var column = 0; column < 3; column++)
                        {
                            var i = first + row * 4 + column;
                            triangles.AddRange(new[] { i, i + 4, i + 5, i, i + 5, i + 1 });
                        }
                }
                shadow.Mesh.Clear();
                shadow.Mesh.SetVertices(vertices); shadow.Mesh.SetColors(colors); shadow.Mesh.SetTriangles(triangles, 0);
                shadow.Mesh.RecalculateBounds();
                var tint = new MaterialPropertyBlock();
                tint.SetColor("_Color", new Color(glow.r, glow.g, glow.b, opacity));
                shadow.Renderer.SetPropertyBlock(tint);
            }
        }

        // The footage under one line's own extent, read once for where the line lies.
        private (float Darkest, float Brightest) Ground(TextMeshPro text, (float X0, float X1, float Y0, float Y1) line)
        {
            var corners = new[] { new Vector3(line.X0, line.Y0), new Vector3(line.X1, line.Y0), new Vector3(line.X1, line.Y1), new Vector3(line.X0, line.Y1) }
                .Select(corner => text.transform.TransformPoint(corner)).ToArray();
            var hash = new System.HashCode();
            foreach (var corner in corners) { hash.Add(Mathf.RoundToInt(corner.x * 1000f)); hash.Add(Mathf.RoundToInt(corner.y * 1000f)); hash.Add(Mathf.RoundToInt(corner.z * 1000f)); }
            var key = hash.ToHashCode();
            if (grounds.TryGetValue(key, out var known)) return known;
            if (grounds.Count > 256) grounds.Clear();
            return grounds[key] = ground!(corners);
        }

        private (TextMeshPro?, Color)[] Lines() => new[] { (speaker, SpatialTheme.Smoke), (caption, SpatialTheme.Ivory), (shownItem, SpatialTheme.Ivory), (hint, SpatialTheme.Smoke) };

        /// <summary>A small hint one gap under the line, such as "Hold to answer"; null takes it away.</summary>
        private float lineHeight;
        /// <summary>One line of the caption, in metres as drawn.</summary>
        public float LineHeight
        {
            get
            {
                if (caption == null) return 0f;
                if (lineHeight <= 0f) lineHeight = SpatialTheme.Height(caption, "Ag", CaptionWidth);
                return lineHeight * caption.transform.lossyScale.y;
            }
        }

        public void SetHint(string? words)
        {
            if (hint == null || caption == null) return;
            hint.gameObject.SetActive(words != null);
            if (words == null) { hintFor = null; return; }
            if (words != hintFor) { hintFor = words; hint.text = ScriptCoverage.Prepare(words); }
            // Placed every frame from the caption as it is laid out now (a wrap, a page or a face found for a script moves its
            // rows): its own row, a gap under the caption's lowest row, from the caption's left edge and as wide as it, so it
            // never runs under Boopy or under a row.
            // Its box as tall as its own words, so they run down from its top and not above it.
            hint.rectTransform.sizeDelta = new Vector2(CaptionWidth, hint.GetPreferredValues(hint.text, CaptionWidth, Mathf.Infinity).y);
            // The caption's lowest row: the lowest of its drawn glyphs, its laid-out last row, and its words' full height from
            // the box's top, so a row still revealing or a wrap still settling never sets it too high.
            var box = caption.rectTransform.sizeDelta;
            var laid = caption.textInfo;
            var lowest = Mathf.Min(caption.textBounds.min.y, box.y / 2f - Mathf.Min(caption.GetPreferredValues(caption.text, box.x, Mathf.Infinity).y, box.y));
            if (laid.lineCount > 0) lowest = Mathf.Min(lowest, laid.lineInfo[laid.lineCount - 1].descender);
            var lineBottom = caption.transform.localPosition.y + lowest;
            // One caption line clear of the last row (DESIGN).
            if (lineHeight <= 0f) _ = LineHeight;
            hint.transform.localPosition = new Vector3(caption.transform.localPosition.x, lineBottom - Mathf.Max(lineHeight, SpatialTheme.Gap) - hint.rectTransform.sizeDelta.y / 2f, caption.transform.localPosition.z);
        }

        private void OnDestroy()
        {
            if(backingMesh==null)return;
            if(Application.isPlaying)Destroy(backingMesh);else DestroyImmediate(backingMesh);
        }
    }
}
