#nullable enable
using TMPro;
using System.Collections.Generic;
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
        private string previousText = "";
        private DialogueStage previousStage;
        private float noticeExpires, stageStartedAt, previousStartedAt;
        private Transform? head;
        private TextMeshPro? speaker, caption;
        private Vector3 velocity;
        private bool reduced;
        private float animationTime;
        private bool interactionLocked;
        private readonly List<string> pages = new List<string>();
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
        public string VisibleText => caption?.text ?? "";
        public string SpeakerText => speaker?.text ?? "";
        public int PageCount => pages.Count;

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
            strip.caption = SpatialTheme.Text(strip.reveal, "Actual response", SpatialTheme.Body, SpatialTheme.Ivory);
            strip.caption.rectTransform.sizeDelta = new Vector2(Width, CaptionHeight);
            strip.caption.transform.localPosition = new Vector3(0, -.012f, -.004f);
            strip.caption.overflowMode = TextOverflowModes.Truncate;
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

        public void Show(DialogueStage stage, string words)
        {
            noticeActive = false; voicePreparing = false; taskSpeaker = null;
            Stage = stage; FullText = words; stageStartedAt = Time.unscaledTime;
            revealAge = 0f;
            if (caption == null || speaker == null) return;
            var width = CaptionWidth;
            speaker.rectTransform.sizeDelta = new Vector2(width, .036f);
            caption.rectTransform.sizeDelta = new Vector2(width, CaptionHeight);
            if (pageHit != null) pageHit.size = new Vector3(width, Height, .012f);
            if (dock != null && !fallback) transform.localPosition = new Vector3(.065f - (Width - width) / 2f, 0, -.004f);
            pages.Clear(); page = 0;
            var start = 0;
            while (start < words.Length)
            {
                var low = 1; var high = words.Length - start;
                while (low < high)
                {
                    var mid = (low + high + 1) / 2;
                    if (SpatialTheme.Height(caption, words.Substring(start, mid), width) <= CaptionHeight) low = mid;
                    else high = mid - 1;
                }
                if (start + low < words.Length && low > 1 && char.IsHighSurrogate(words[start + low - 1])) low--;
                // Prefer a natural boundary while preserving every source character, including whitespace.
                if (start + low < words.Length)
                {
                    var boundary = words.LastIndexOf(' ', start + low - 1, low);
                    if (boundary >= start + low / 2) low = boundary - start + 1;
                }
                pages.Add(words.Substring(start, low)); start += low;
            }
            if (pages.Count == 0) pages.Add("");
            DrawPage();
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
            Show(DialogueStage.Clarification, words);
            restoreVisible = visible; previousText = savedText; previousStage = savedStage; previousPage = savedPage; previousStartedAt = savedStartedAt;
            previousTaskSpeaker = savedSpeaker;
            noticeExpires = seconds > 0 ? Time.unscaledTime + seconds : float.PositiveInfinity;
            noticeActive = true;
        }
        public void ClearNotice()
        {
            if (!noticeActive) return;
            noticeActive = false;
            if (restoreVisible) { Show(previousStage, previousText); taskSpeaker = previousTaskSpeaker; page = Mathf.Clamp(previousPage, 0, pages.Count - 1); stageStartedAt = previousStartedAt; DrawPage(); } else Hide();
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
        public bool HitPage(Ray ray) => HitFallbackAction(ray, out _) == ConsoleAction.None && (host == null || host.HitAction(ray, out _) == ConsoleAction.None) && gameObject.activeInHierarchy && pages.Count > 1 && pageHit != null && pageHit.Raycast(ray, out _, 3f);
        public void NextPage() { if (pages.Count > 1) { page = (page + 1) % pages.Count; DrawPage(); } }
        private void DrawPage()
        {
            revealAge = 0f;
            if (speaker == null || caption == null) return;
            RefreshSpeaker();
            caption.text = pages[page];
        }
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
            speaker.text = Stage == DialogueStage.Listening || Stage == DialogueStage.Working ? ""
                : (voicePreparing && VoicePreparationStage ? "Preparing voice…"
                    : taskSpeaker ?? ((Stage == DialogueStage.Response || Stage == DialogueStage.LocalSave) ? "Boopy" : "Boopy · " + StateName(Stage)))
                    + (pages.Count > 1 ? voicePreparing && VoicePreparationStage
                        ? $" · {page + 1}/{pages.Count}" : $" · {page + 1}/{pages.Count} · Next page" : "");
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
            var still=host?.ReducedMotion ?? reduced;
            if(!still)animationTime+=Mathf.Max(0f,delta);
            revealAge += Mathf.Max(0f, delta);
            var entered = Mathf.Clamp01(revealAge / (still ? .12f : .18f));
            var eased = entered * entered * (3f - 2f * entered);
            if (reveal != null) reveal.localPosition = still ? Vector3.zero : Vector3.down * (.006f * (1f-eased));
            var opacity = entered * (dock != null && !fallback ? dock.Opacity : 1f);
            if (speaker != null) speaker.alpha = opacity;
            fallbackStop?.Refresh(delta, 1f, host?.ReducedMotion ?? reduced);
            // This measures this actual outstanding wait, including when motion is reduced.
            // It never pretends to know which provider step is running or how much is complete.
            if (Stage == DialogueStage.Working && caption != null)
            {
                var elapsed = Mathf.Max(0f, Time.unscaledTime - stageStartedAt);
                caption.text = elapsed >= 10f ? FullText + $"\nStill waiting · {Mathf.FloorToInt(elapsed)}s" : FullText;
            }
            RefreshBacking(opacity);
            if (caption != null)
            {
                caption.alpha = opacity;
                TextShimmer.Apply(caption, animationTime, Stage == DialogueStage.Working && !still, opacity);
            }
            if (dock != null && !fallback) return;
            // Resolve from the current expanded controls every frame; independent damping can
            // sweep the subtitle through Settings, and independent facing defeats the bar lock.
            if (PlaceFallback()) return;
            if (interactionLocked) return;
            transform.position = reduced ? Target() : Vector3.SmoothDamp(transform.position, Target(), ref velocity, .22f);
            Face();
        }
        private void RefreshBacking(float opacity)
        {
            if(captionBacking==null || backingRenderer==null || backingTint==null)return;
            var bounds=new Bounds();var found=false;
            foreach(var text in new[]{speaker,caption})
            {
                if(text==null || string.IsNullOrWhiteSpace(text.text))continue;
                text.ForceMeshUpdate(true,true);var ink=text.textBounds;
                if(ink.size.x<=0 || ink.size.y<=0)continue;
                ink.center+=text.transform.localPosition;
                if(!found){bounds=ink;found=true;}else bounds.Encapsulate(ink);
            }
            backingRenderer.sortingOrder=conversationContentHeight>0f && !fallback ? 0 : 2;
            backingRenderer.enabled=found;
            if(!found)return;
            var left=conversationContentHeight > 0f && !fallback ? -Width/2f-.012f : Mathf.Max(-CaptionWidth/2f-.012f,bounds.min.x-.012f);
            var right=conversationContentHeight > 0f && !fallback ? Width/2f+.012f : Mathf.Min(CaptionWidth/2f+.012f,bounds.max.x+.012f);
            var bottom=conversationContentHeight > 0f && !fallback ? ConversationAnswerBottom-.016f-conversationContentHeight-.012f : Mathf.Max(-Height/2f,bounds.min.y-.008f);
            var top=Mathf.Min(Height/2f,bounds.max.y+.008f);
            captionBacking.localPosition=new Vector3((left+right)/2f,(bottom+top)/2f,conversationContentHeight > 0f && !fallback ? .006f : .002f);
            captionBacking.localScale=new Vector3(Mathf.Max(.01f,right-left),Mathf.Max(.01f,top-bottom),1f);
            var panel=SpatialTheme.Panel;panel.a*=opacity;backingTint.SetColor("_Color",panel);backingRenderer.SetPropertyBlock(backingTint);
        }
        private void OnDestroy()
        {
            if(backingMesh==null)return;
            if(Application.isPlaying)Destroy(backingMesh);else DestroyImmediate(backingMesh);
        }
    }
}
