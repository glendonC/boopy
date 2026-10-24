#nullable enable
using TMPro;
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>A reusable measured text surface with optional readability backing.</summary>
    public sealed class SpatialSurface : MonoBehaviour
    {
        private Transform? visual;
        private MeshRenderer? plate;
        private MeshFilter? face;
        private Vector2 faceSize;
        private LineRenderer? rim;
        private TextMeshPro? eyebrow, title, body;
        private MaterialPropertyBlock? block;
        private float started, delay, amount = 1f;
        // A fade, unlike the reveal, moves toward its own opacity over its own time and never settles the panel downward.
        private float target = 1f, fadeSeconds;
        private bool reduced;
        private bool chrome = true;
        private bool textVisible = true;
        private bool companionInset;
        private bool trailingInset;
        private bool column;
        private bool wasShimmering;
        private Color? identityAccent;
        public Vector2 Size { get; private set; }
        /// <summary>Where the surface's middle sits across the console: on the line's column, or the console's middle.</summary>
        public float CenterX => column ? SpatialTheme.ShelfLeft + SpatialTheme.ShelfWidth / 2f : 0f;
        public float Opacity => amount;
        public string BodyText => body?.text ?? "";
        public string StateText => eyebrow?.text ?? "";
        public string TitleText => title?.text ?? "";

        private void OnDestroy()
        {
            if (face == null || face.sharedMesh == null) return;
            if (Application.isPlaying) Destroy(face.sharedMesh); else DestroyImmediate(face.sharedMesh);
        }

        public static SpatialSurface Create(Transform parent, string name)
        {
            var go = new GameObject(name); go.transform.SetParent(parent, false);
            var surface = go.AddComponent<SpatialSurface>();
            surface.block = new MaterialPropertyBlock();
            surface.visual = new GameObject("Instrument visual").transform;
            surface.visual.SetParent(go.transform, false);
            var plate = new GameObject("Readability island"); plate.transform.SetParent(surface.visual, false);
            surface.face = plate.AddComponent<MeshFilter>();
            surface.plate = plate.AddComponent<MeshRenderer>(); surface.plate.sharedMaterial = Visuals.Solid;
            surface.plate.sortingOrder = 0; surface.plate.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            var rim = new GameObject("Instrument edge"); rim.transform.SetParent(surface.visual, false);
            surface.rim = Visuals.Line(rim, 0.0012f, false, Visuals.Solid);
            surface.rim.useWorldSpace = false; surface.rim.positionCount = 3; surface.rim.sortingOrder = 2;
            surface.eyebrow = SpatialTheme.Text(surface.visual, "State", SpatialTheme.Utility, SpatialTheme.Smoke);
            surface.title = SpatialTheme.Text(surface.visual, "Title", SpatialTheme.Title, SpatialTheme.Ivory);
            surface.title.fontStyle = FontStyles.Normal;
            surface.body = SpatialTheme.Text(surface.visual, "Body", SpatialTheme.Body, SpatialTheme.Ivory);
            return surface;
        }

        public void Configure(string state, string heading, string words, float maxBodyHeight = 0.078f, float bottomSpace = 0f, bool intent = false, float maxTitleHeight = .072f)
        {
            if (eyebrow == null || title == null || body == null) return;
            var measure = SpatialTheme.Width - SpatialTheme.Padding * 2f - (companionInset ? .13f : 0f) - (trailingInset ? .07f : 0f);
            // On the line's column the words start on the text column and keep every word the full measure would show: the
            // panel grows to hold them, and nothing pads it under its last words.
            var width = column ? SpatialTheme.ShelfWidth : measure;
            eyebrow.text = state;
            title.text = SpatialTheme.Summary(title, heading, measure, maxTitleHeight);
            title.color = intent ? SpatialTheme.Sand : SpatialTheme.Ivory;
            body.text = SpatialTheme.Summary(body, words, measure, maxBodyHeight);
            var stateHeight = string.IsNullOrEmpty(state) ? 0f : Mathf.Max(0.017f, SpatialTheme.Height(eyebrow, state, width));
            var titleHeight = string.IsNullOrEmpty(heading) ? 0f : Mathf.Max(0.024f, SpatialTheme.Height(title, title.text, width));
            var bodyHeight = string.IsNullOrEmpty(words) ? 0f : Mathf.Max(0.020f, SpatialTheme.Height(body, body.text, width));
            var h = stateHeight + titleHeight + bodyHeight + SpatialTheme.Padding * 2f
                + (stateHeight > 0f ? 0.008f : 0f) + (bodyHeight > 0f && (titleHeight > 0f || !column) ? 0.009f : 0f) + bottomSpace;
            // The column's panel spans the text column with the line's 12 mm side margin.
            Size = new Vector2(column ? SpatialTheme.ShelfWidth + .024f : SpatialTheme.Width, h);
            var top = h / 2f - SpatialTheme.Padding;
            Arrange(eyebrow, width, stateHeight, ref top, 0.008f);
            Arrange(title, width, titleHeight, ref top, 0.009f);
            Arrange(body, width, bodyHeight, ref top, 0f);
            if (plate != null) plate.transform.localScale = new Vector3(Size.x, Size.y, 1f);
            if (rim != null)
            {
                rim.SetPosition(0, new Vector3(-Size.x / 2f, -Size.y / 2f + 0.020f, -0.001f));
                rim.SetPosition(1, new Vector3(-Size.x / 2f, Size.y / 2f - 0.008f, -0.001f));
                rim.SetPosition(2, new Vector3(Size.x / 2f - 0.030f, Size.y / 2f - 0.008f, -0.001f));
            }
            if (companionInset)
                foreach (var label in new[] { eyebrow, title, body }) label.transform.localPosition += Vector3.right * .065f;
            if (trailingInset)
                foreach (var label in new[] { eyebrow, title, body }) label.transform.localPosition -= Vector3.right * .035f;
            Refresh(0f);
        }

        public void SetIdentityAccent(Color? color) { identityAccent = color; Refresh(0f); }
        public void SetTrailingInset(bool on) => trailingInset = on;
        /// <summary>A sheet or card on the line's column: its dark panel across the text column, as the line's own.</summary>
        public void SetColumn(bool on) => column = on;
        public void SetChrome(bool visible) { chrome = visible; Refresh(0f); }
        public void SetCompanionInset(bool on) => companionInset = on;
        public void SetTextVisible(bool visible)
        {
            textVisible = visible;
            foreach (var label in new[] { eyebrow, title, body })
                if (label != null) label.GetComponent<MeshRenderer>().enabled = visible;
        }
        public void SetBody(string words) { if (body != null) body.text = words; }

        public void Shimmer(float time, bool active)
        {
            if (body == null || !body.gameObject.activeInHierarchy || (!active && !wasShimmering)) return;
            wasShimmering = active;
            TextShimmer.Apply(body, time, active && !reduced, amount);
        }

        private static void Arrange(TextMeshPro text, float width, float height, ref float top, float gap)
        {
            text.gameObject.SetActive(height > 0f);
            text.rectTransform.sizeDelta = new Vector2(width, height);
            text.transform.localPosition = new Vector3(0f, top - height / 2f, -0.003f);
            top -= height + (height > 0f ? gap : 0f);
        }

        public void Assemble(float secondsDelay, bool reducedMotion)
        { started = 0f; delay = secondsDelay; reduced = reducedMotion; amount = 0f; target = 1f; fadeSeconds = 0f; Refresh(0f); }

        /// <summary>Toward <paramref name="opacity"/> over <paramref name="seconds"/>: alpha only, the panel stays where it is.</summary>
        public void FadeTo(float opacity, float seconds) { started = delay; target = Mathf.Clamp01(opacity); fadeSeconds = Mathf.Max(.001f, seconds); }

        /// <summary>From clear to full over <paramref name="seconds"/>, alpha only.</summary>
        public void FadeIn(float seconds) { amount = 0f; FadeTo(1f, seconds); }

        public void SetState(string words) { if (eyebrow != null) eyebrow.text = words; }

        public void ReserveHeight(float minimum)
        {
            if (Size.y >= minimum || plate == null || rim == null) return;
            var offset = (minimum - Size.y) / 2f;
            foreach (var label in new[] { eyebrow, title, body }) if (label != null) label.transform.localPosition += Vector3.up * (companionInset ? 0f : offset);
            Size = new Vector2(Size.x, minimum);
            plate.transform.localScale = new Vector3(Size.x, Size.y, 1f);
            rim.SetPosition(0, new Vector3(-Size.x / 2f, -Size.y / 2f + .020f, -.001f));
            rim.SetPosition(1, new Vector3(-Size.x / 2f, Size.y / 2f - .008f, -.001f));
            rim.SetPosition(2, new Vector3(Size.x / 2f - .030f, Size.y / 2f - .008f, -.001f));
        }

        public void Refresh(float delta)
        {
            if (visual == null || plate == null || block == null || rim == null) return;
            started += Mathf.Max(0f, delta);
            if (started >= delay) amount = Mathf.MoveTowards(amount, target, delta / (fadeSeconds > 0f ? fadeSeconds : reduced ? .12f : SpatialTheme.RevealSeconds));
            if (face != null && faceSize != Size)
            {
                var old=face.sharedMesh; face.sharedMesh=RoundedPlate.Create(Size.x,Size.y,.022f);faceSize=Size;
                if(old!=null) { if(Application.isPlaying)Destroy(old);else DestroyImmediate(old); }
            }
            var eased = amount * amount * (3f - 2f * amount);
            visual.localScale = Vector3.one;
            visual.localPosition = reduced || fadeSeconds > 0f ? Vector3.zero : Vector3.down * (.006f * (1f - eased));
            plate.enabled = chrome;
            rim.enabled = chrome && identityAccent.HasValue;

            var color = SpatialTheme.Ink; color.a *= amount; block.SetColor("_Color", color); plate.SetPropertyBlock(block);
            var edge = identityAccent ?? SpatialTheme.Cyan;
            Visuals.Tint(rim, new Color(edge.r, edge.g, edge.b, amount * 0.8f));
            if (eyebrow != null) eyebrow.alpha = amount;
            if (title != null) title.alpha = amount;
            if (body != null) body.alpha = amount;
            SetTextVisible(textVisible);
        }
    }
}
