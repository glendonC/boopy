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
        private float CaptionWidth => dock != null && host?.CaptionHasTrailingAction == true ? .34f : Width;
        private const float CaptionHeight = .102f;
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
        private TextMeshPro? speaker, caption, shownItem;
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
            strip.caption.rectTransform.sizeDelta = new Vector2(Width, CaptionHeight);
            strip.caption.transform.localPosition = new Vector3(0, .042f - CaptionHeight / 2f, -.004f);
            strip.caption.alignment = TextAlignmentOptions.TopLeft;
            strip.caption.overflowMode = TextOverflowModes.Truncate;
            // A choice's option shown under its prompt: its own paragraph, one gap below, in the line's type.
            strip.shownItem = SpatialTheme.Text(strip.reveal, "Shown item", SpatialTheme.Body, SpatialTheme.Ivory);
            strip.shownItem.alignment = TextAlignmentOptions.TopLeft;
            strip.shownItem.gameObject.SetActive(false);
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
            transform.localPosition = new Vector3(.065f, 0, -.004f);
            transform.localRotation = Quaternion.identity;
            transform.localScale = Vector3.one;
            host.SetDialogueVisible(gameObject.activeSelf);
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
                transform.localPosition = new Vector3(.065f - (Width - CaptionWidth) / 2f, 0f, -.004f);
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
            var width = CaptionWidth;
            speaker.rectTransform.sizeDelta = new Vector2(width, .036f);
            caption.rectTransform.sizeDelta = new Vector2(width, CaptionHeight);
            if (pageHit != null) pageHit.size = new Vector3(width, Height, .012f);
            if (dock != null && !fallback) transform.localPosition = new Vector3(.065f - (Width - width) / 2f, 0, -.004f);
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
            backingRenderer.enabled=found;
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
        private void OnDestroy()
        {
            if(backingMesh==null)return;
            if(Application.isPlaying)Destroy(backingMesh);else DestroyImmediate(backingMesh);
        }
    }
}
