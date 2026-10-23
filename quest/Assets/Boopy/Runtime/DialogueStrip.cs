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
        private float conversationContentHeight;
        public float ConversationAnswerBottom { get; private set; } = -.064f;
        public float ConversationPanelHeight(float rowsHeight) => .080f - ConversationAnswerBottom + .016f + rowsHeight + .012f;
        public void SetConversationContentHeight(float height)
        {
            conversationContentHeight = Mathf.Max(0f, height);
            if(pageHit != null)
            {
                var lower=conversationContentHeight > 0f ? ConversationAnswerBottom-.004f : -Height/2f;
                pageHit.center=new Vector3(0,(Height/2f+lower)/2f,0);
                pageHit.size=new Vector3(CaptionWidth,Height/2f-lower,.012f);
            }
            if(dock != null && !fallback) transform.localPosition = new Vector3(.065f, conversationContentHeight > 0f ? dock.Size.y / 2f - .080f : 0f, -.004f);
        }
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
                transform.localPosition = new Vector3(.065f - (Width - CaptionWidth) / 2f, conversationContentHeight > 0f ? dock.Size.y / 2f - .080f : 0f, -.004f);
                transform.localRotation = Quaternion.identity;
            }
            if (speaker != null) speaker.alpha = 1f;
            if (caption != null) caption.alpha = 1f;
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

        public void Show(DialogueStage stage, string words)
        {
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
            MeasureAnswerPages();
            if (dock == null && !gameObject.activeSelf) { transform.position = Target(); velocity = Vector3.zero; }
            host?.SetDialogueVisible(true);
            gameObject.SetActive(true); RefreshFallbackAction(); Face(); RefreshVisuals(0f);
        }
        public void Hide() { noticeActive = false; gameObject.SetActive(false); host?.SetDialogueVisible(false); }
        public void ShowNotice(string words, float seconds)
        {
            var visible = noticeActive ? restoreVisible : gameObject.activeSelf;
            var savedText = noticeActive ? previousText : FullText;
            var savedStage = noticeActive ? previousStage : Stage;
            var savedPage = noticeActive ? previousPage : page;
            var savedStartedAt = noticeActive ? previousStartedAt : stageStartedAt;
            var savedSpeaker = noticeActive ? previousTaskSpeaker : taskSpeaker;
            var savedThinking = noticeActive ? previousThinking : thinking;
            Show(DialogueStage.Clarification, words);
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
            if (!restoreVisible) { Hide(); return; }
            var savedPage = previousPage;
            Show(previousStage, previousText);
            taskSpeaker = previousTaskSpeaker; thinking = previousThinking; stageStartedAt = previousStartedAt;
            // The console names the line's items again, which builds the pages, then the page that was showing returns.
            host?.LinePaged();
            page = Mathf.Clamp(savedPage, 0, Mathf.Max(0, pages.Count - 1));
            DrawPage();
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
            var kept = page;
            items.Clear(); items.AddRange(offered); itemsUnderLine = underLine && offered.Count > 0; itemSpeaker = speaker;
            Paginate();
            if (kept > 0 && kept < pages.Count) { page = kept; DrawPage(); }
        }

        // The line's pages: its words in pieces that fit the caption, then each item's alone, every source character kept.
        // Items under the line, a choice's options, each share a page with the whole line, which the contract bounds (a
        // 160-character prompt, 60-character options); every such page takes the tallest one's height, so paging never moves
        // the panel's top, and the panel grows upward to hold it.
        private void Paginate()
        {
            pages.Clear(); pageItems.Clear(); pageHeights.Clear(); page = 0;
            if (caption == null) return;
            itemsUnder = itemsUnderLine;
            var tallest = itemsUnder && items.Count > 0 ? Mathf.Max(CaptionHeight, items.Max(Under)) : CaptionHeight;
            if (!itemsUnder) Pieces(FullText, -1, CaptionHeight);
            for (var item = 0; item < items.Count; item++)
                if (!itemsUnder) Pieces(items[item], item, CaptionHeight + ItemRoom);
                else { pages.Add(FullText); pageItems.Add(item); pageHeights.Add(tallest); }
            if (pages.Count == 0) { pages.Add(""); pageItems.Add(-1); pageHeights.Add(CaptionHeight); }
            DrawPage();
        }

        // The height of the line with an item one gap under it.
        private float Under(string item) => SpatialTheme.Height(caption!, FullText, CaptionWidth) + SpatialTheme.Gap + SpatialTheme.Height(caption!, item, CaptionWidth);

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
        }
        // The item shown under the line: its ink starts one gap below the line's last words.
        private void DrawItem()
        {
            if (shownItem == null || caption == null) return;
            var show = itemsUnder && ShownItem >= 0;
            shownItem.gameObject.SetActive(show);
            if (!show) return;
            shownItem.text = items[ShownItem];
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
        private void MeasureAnswerPages()
        {
            if(caption==null)return;
            var saved=caption.text;var lower=float.PositiveInfinity;
            foreach(var words in pages)
            {
                caption.text=words;caption.ForceMeshUpdate(true,true);
                if(caption.textBounds.size.y>0)lower=Mathf.Min(lower,caption.textBounds.min.y+caption.transform.localPosition.y);
            }
            caption.text=saved;caption.ForceMeshUpdate(true,true);
            ConversationAnswerBottom=float.IsPositiveInfinity(lower)?-.040f:lower;
        }
        private bool VoicePreparationStage => Stage == DialogueStage.Response || Stage == DialogueStage.Clarification
            || Stage == DialogueStage.FreshView || Stage == DialogueStage.LocalSave;
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
            // The working line is whole on its first frame, shimmer included: no fade of its own and none from
            // the console's reveal. It is one line with no timer.
            var working = Stage == DialogueStage.Working;
            var entered = working ? 1f : Mathf.Clamp01(revealAge / (still ? .12f : .18f));
            var eased = entered * entered * (3f - 2f * entered);
            if (reveal != null) reveal.localPosition = still ? Vector3.zero : Vector3.down * (.006f * (1f-eased));
            var opacity = working ? 1f : entered * (dock != null && !fallback ? dock.Opacity : 1f);
            if (speaker != null) speaker.alpha = opacity;
            fallbackStop?.Refresh(delta, 1f, host?.ReducedMotion ?? reduced);
            RefreshBacking(opacity);
            if (caption != null)
            {
                caption.alpha = opacity;
                TextShimmer.Apply(caption, animationTime, Stage == DialogueStage.Working && !still, opacity);
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

        /// <summary>The panel's height for this line alone: its ink with the backing's margins.</summary>
        public float VisibleHeight => Ink(out var bounds) ? Mathf.Min(Height/2f,bounds.max.y+.008f)-Mathf.Max(-Height/2f,bounds.min.y-.008f) : 0f;

        private void RefreshBacking(float opacity)
        {
            if(captionBacking==null || backingRenderer==null || backingTint==null)return;
            var found=Ink(out var bounds);
            backingRenderer.sortingOrder=conversationContentHeight>0f && !fallback ? 0 : 2;
            backingRenderer.enabled=found;
            if(!found)return;
            var left=conversationContentHeight > 0f && !fallback ? -Width/2f-.012f : Mathf.Max(-CaptionWidth/2f-.012f,bounds.min.x-.012f);
            var right=conversationContentHeight > 0f && !fallback ? Width/2f+.012f : Mathf.Min(CaptionWidth/2f+.012f,bounds.max.x+.012f);
            var bottom=conversationContentHeight > 0f && !fallback ? ConversationAnswerBottom-.016f-conversationContentHeight-.012f : Mathf.Max(-Height/2f - Extra,bounds.min.y-.008f);
            var top=Mathf.Min(Height/2f,bounds.max.y+.008f);
            captionBacking.localPosition=new Vector3((left+right)/2f,(bottom+top)/2f,conversationContentHeight > 0f && !fallback ? .006f : .002f);
            captionBacking.localScale=new Vector3(Mathf.Max(.01f,right-left),Mathf.Max(.01f,top-bottom),1f);
            // Docked with nothing under it, the line's panel sits on the console panel's bottom edge, one gap above the
            // shelf, and grows upward with the line; the shelf never moves.
            if(dock!=null && !fallback && conversationContentHeight<=0f)
            {
                transform.localPosition=new Vector3(transform.localPosition.x,-dock.Size.y/2f-bottom,transform.localPosition.z);
                // Paging is a pinch on the panel itself, never on the row of tiles under it.
                if(pageHit!=null){pageHit.center=new Vector3(0,(top+bottom)/2f,0);pageHit.size=new Vector3(CaptionWidth,top-bottom,.012f);}
            }
            var panel=SpatialTheme.Panel;panel.a*=opacity;backingTint.SetColor("_Color",panel);backingRenderer.SetPropertyBlock(backingTint);
        }
        private void OnDestroy()
        {
            if(backingMesh==null)return;
            if(Application.isPlaying)Destroy(backingMesh);else DestroyImmediate(backingMesh);
        }
    }
}
