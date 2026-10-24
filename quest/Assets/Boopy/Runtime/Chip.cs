#nullable enable
using System;
using System.Collections.Generic;
using Boopy.Client;
using TMPro;
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>A concise scene label. Full evidence lives in the console, so focus never reflows neighbors.</summary>
    public sealed class Chip : MonoBehaviour
    {
        private const float MaxWidth = 0.25f;
        private const float Padding = 0.012f;
        private TextMeshPro? caption;
        private TextMeshPro? gloss;
        private TextMeshPro? state;
        private MeshRenderer? plate;
        private LineRenderer? border;
        private LineRenderer? leader;
        private BoxCollider? hit;
        private Transform? visual;
        private MaterialPropertyBlock? block;
        private Vector2 size;
        private Color edge;
        private float opacity = 1f;
        private float focusAmount;
        private float reveal = 1f;
        private bool focused;
        private bool reducedMotion;
        private bool hasIdentityAccent;
        private Color identityAccent;
        private bool peerFocused;
        private bool presentationOnly;
        // The leader stops this far short of the subject's outline, toward the chip.
        private const float LeaderGap = .005f;
        private IReadOnlyList<Vector3> subjectOutline = Array.Empty<Vector3>();

        public string ItemId { get; private set; } = "";
        public Vector3? Anchor { get; private set; }
        public Vector3 Home { get; private set; }
        public bool Placed { get; private set; }
        public float Shrink { get; set; } = 1f;

        /// <summary>Conservative apparent footprint at 1m, including focus and forgiving hit bounds.</summary>
        public Vector2 LayoutSize => new Vector2(Mathf.Max(size.x * 1.04f, hit?.size.x ?? 0f),
            Mathf.Max(size.y * 1.04f, hit?.size.y ?? 0f));

        public static Chip Create(Transform parent, Mesh quad)
        {
            var go = new GameObject("Chip");
            go.transform.SetParent(parent, false);
            var chip = go.AddComponent<Chip>();
            chip.block = new MaterialPropertyBlock();
            chip.visual = new GameObject("Visual").transform;
            chip.visual.SetParent(go.transform, false);
            var plateObject = new GameObject("Text island");
            plateObject.transform.SetParent(chip.visual, false);
            plateObject.AddComponent<MeshFilter>().sharedMesh = quad;
            chip.plate = plateObject.AddComponent<MeshRenderer>();
            chip.plate.sharedMaterial = Visuals.Solid;
            chip.plate.sortingOrder = 0;
            chip.plate.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            var frameObject = new GameObject("Clipped frame");
            frameObject.transform.SetParent(chip.visual, false);
            chip.border = Visuals.Line(frameObject, 0.001f, true, Visuals.Solid);
            chip.border.useWorldSpace = false;
            chip.border.sortingOrder = 1;
            chip.border.positionCount = 8;
            var leaderObject = new GameObject("Evidence attachment");
            leaderObject.transform.SetParent(go.transform, false);
            chip.leader = Visuals.Line(leaderObject, 0.0007f, false, Visuals.Solid);
            chip.leader.positionCount = 2;
            chip.leader.sortingOrder = 1;
            chip.leader.enabled = false;
            chip.caption = Text(chip.visual, "Label", SpatialTheme.Title);
            chip.gloss = Text(chip.visual, "Gloss", SpatialTheme.Body);
            chip.state = Text(chip.visual, "State", SpatialTheme.Utility);
            chip.state.color = Visuals.Proposed;
            chip.hit = go.AddComponent<BoxCollider>();
            return chip;
        }

        private static TextMeshPro Text(Transform parent, string name, float fontSize)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);
            go.transform.localPosition = new Vector3(0f, 0f, -0.001f);
            var text = go.AddComponent<TextMeshPro>();
            text.font = fontSize >= SpatialTheme.Title ? BoopyTypography.Medium : BoopyTypography.Load();
            text.fontSize = fontSize;
            text.alignment = TextAlignmentOptions.Left;
            text.textWrappingMode = TextWrappingModes.Normal;
            text.richText = false;
            text.color = Visuals.Text;
            text.rectTransform.sizeDelta = new Vector2(MaxWidth, 0.05f);
            text.GetComponent<MeshRenderer>().sortingOrder = 2;
            return text;
        }

        public void Show(Item item, bool isIntent)
        {
            presentationOnly = false;
            ItemId = item.Id;
            name = "Chip " + item.Id;
            if (caption == null || gloss == null || state == null || border == null || plate == null || hit == null) return;
            var style = ChipStyles.For(item, isIntent);
            opacity = style.Opacity;
            edge = hasIdentityAccent ? identityAccent : Visuals.Border(style.Tone);
            caption.fontSize = SpatialTheme.Title;
            caption.fontStyle = style.Tone == ChipTone.Rejected ? FontStyles.Strikethrough : FontStyles.Normal;
            caption.text = item.Label;
            caption.color = isIntent ? Visuals.Intent : Visuals.Text;
            caption.ForceMeshUpdate(true, true);
            var labelSize = caption.GetPreferredValues(item.Label, MaxWidth, Mathf.Infinity);
            var labelHeight = Mathf.Max(labelSize.y, 0.024f);
            var hasGloss = !string.IsNullOrWhiteSpace(item.Gloss);
            gloss.gameObject.SetActive(hasGloss);
            gloss.text = item.Gloss ?? "";
            gloss.ForceMeshUpdate(true, true);
            var glossSize = hasGloss ? gloss.GetPreferredValues(gloss.text, MaxWidth, Mathf.Infinity) : Vector2.zero;
            var glossHeight = hasGloss ? Mathf.Max(0.018f, glossSize.y) + 0.003f : 0f;
            state.text = item.Kind + " / " + style.Tag;
            state.ForceMeshUpdate(true, true);
            var stateSize = state.GetPreferredValues(state.text, MaxWidth, Mathf.Infinity);
            var stateHeight = Mathf.Max(0.015f, stateSize.y);
            var contentWidth = Mathf.Clamp(Mathf.Max(labelSize.x, Mathf.Max(glossSize.x, stateSize.x)), 0.12f, MaxWidth);
            size = new Vector2(contentWidth + Padding * 2f, labelHeight + glossHeight + stateHeight + Padding * 2f + 0.006f);
            caption.rectTransform.sizeDelta = new Vector2(contentWidth, labelHeight);
            gloss.rectTransform.sizeDelta = new Vector2(contentWidth, glossHeight);
            state.rectTransform.sizeDelta = new Vector2(contentWidth, stateHeight);
            caption.transform.localPosition = new Vector3(0f, size.y / 2f - Padding - labelHeight / 2f, -0.001f);
            gloss.transform.localPosition = new Vector3(0f, size.y / 2f - Padding - labelHeight - glossHeight / 2f, -0.001f);
            state.transform.localPosition = new Vector3(0f, -size.y / 2f + Padding + stateHeight / 2f, -0.001f);
            plate.transform.localScale = new Vector3(size.x, size.y, 1f);
            // A solid hairline in the tone's color on every chip; proposed shows in the words and the tone, not in dashes.
            border.sharedMaterial = Visuals.Solid;
            border.widthMultiplier = style.Emphasis ? 0.002f : 0.0012f;
            var w = size.x / 2f;
            var h = size.y / 2f;
            const float cut = 0.005f;
            var points = new[] { new Vector2(-w + cut, -h), new Vector2(w - cut, -h),
                new Vector2(w, -h + cut), new Vector2(w, h - cut), new Vector2(w - cut, h),
                new Vector2(-w + cut, h), new Vector2(-w, h - cut), new Vector2(-w, -h + cut) };
            for (var i = 0; i < points.Length; i++) border.SetPosition(i, new Vector3(points[i].x, points[i].y, -0.0005f));
            border.textureScale = new Vector2(1f / 0.006f, 1f);
            hit.size = new Vector3(size.x + 0.018f, Mathf.Max(0.058f, size.y + 0.014f), 0.014f);
            ApplyAppearance();
        }

        /// <summary>A model's concise proposed name; no conversation item, correction target or action.</summary>
        public void ShowProposed(string proposedName)
        {
            ItemId = ""; name = "Proposed live label"; presentationOnly = true; Placed = false;
            if (caption == null || gloss == null || state == null || border == null || plate == null || hit == null) return;
            hit.enabled = false; hit.size = Vector3.zero;
            gloss.gameObject.SetActive(false); state.gameObject.SetActive(false);
            caption.font = BoopyTypography.Medium; caption.fontSize = SpatialTheme.Title;
            caption.fontStyle = FontStyles.Normal; caption.text = proposedName + "?";
            caption.color = Visuals.Text; caption.ForceMeshUpdate(true, true);
            var measured = caption.GetPreferredValues(caption.text, MaxWidth, Mathf.Infinity);
            var width = Mathf.Clamp(measured.x, .06f, MaxWidth); var height = Mathf.Max(measured.y, .024f);
            size = new Vector2(width + Padding * 2f, height + Padding * 2f);
            caption.rectTransform.sizeDelta = new Vector2(width, height);
            caption.transform.localPosition = new Vector3(0f, 0f, -.001f);
            plate.transform.localScale = new Vector3(size.x, size.y, 1f);
            border.sharedMaterial = Visuals.Solid; border.widthMultiplier = .0012f;
            var w = size.x / 2f; var h = size.y / 2f; const float cut = .005f;
            var corners = new[] { new Vector2(-w + cut, -h), new Vector2(w - cut, -h),
                new Vector2(w, -h + cut), new Vector2(w, h - cut), new Vector2(w - cut, h),
                new Vector2(-w + cut, h), new Vector2(-w, h - cut), new Vector2(-w, -h + cut) };
            for (var i = 0; i < corners.Length; i++) border.SetPosition(i, new Vector3(corners[i].x, corners[i].y, -.0005f));
            border.textureScale = new Vector2(1f / .006f, 1f);
            opacity = 1f; edge = Visuals.Border(ChipTone.Proposed); focusAmount = 0f; focused = false;
            peerFocused = false; ApplyAppearance();
        }

        private void ApplyAppearance()
        {
            if (plate == null || caption == null || gloss == null || state == null || border == null || block == null) return;
            var alpha = Mathf.Max(0.82f, opacity) * reveal;
            var plateColor = Color.Lerp(Visuals.Plate, new Color(.17f, .18f, .20f, .95f), focusAmount);
            plateColor.a *= reveal;
            block.SetColor("_Color", plateColor);
            plate.SetPropertyBlock(block);
            Visuals.Tint(border, new Color(edge.r, edge.g, edge.b, alpha * Mathf.Lerp(0.65f, 1f, focusAmount) * (peerFocused ? .55f : 1f)));
            caption.alpha = alpha;
            gloss.alpha = alpha;
            state.alpha = alpha;
            if (leader != null) Visuals.Tint(leader, new Color(edge.r, edge.g, edge.b, 0.4f * alpha * (peerFocused ? .55f : 1f)));
        }

        public void SetIdentityAccent(int slot)
        {
            var accent = ObjectAccents.Color(slot);
            identityAccent = new Color(accent.X, accent.Y, accent.Z, 1f);
            hasIdentityAccent = true; edge = identityAccent; ApplyAppearance();
        }

        public void SetPeerFocused(bool on)
        {
            if (peerFocused == on) return;
            peerFocused = on; ApplyAppearance();
        }

        public void Place(Vector3 home, Vector3? anchor)
        {
            Home = home;
            Anchor = anchor;
            if (!Placed) reveal = reducedMotion ? 1f : 0f;
            Placed = true;
            transform.position = home;
            if (leader != null) leader.enabled = anchor != null;
            ApplyAppearance();
        }

        public void SetReducedMotion(bool on)
        {
            reducedMotion = on;
            if (on) { reveal = 1f; ApplyAppearance(); }
        }

        public void SetOverlayOccluded(bool occluded)
        {
            if (visual != null) visual.gameObject.SetActive(!occluded);
            if (hit != null) hit.enabled = !occluded && !presentationOnly;
            if (leader != null) leader.enabled = !occluded && Anchor != null;
        }

        public void Focus(bool on) => focused = on;

        /// <summary>The subject's drawn outline, or none. The leader stops just outside it, never on the object's face.</summary>
        public void SetSubjectOutline(IReadOnlyList<Vector3> outline) => subjectOutline = outline;

        // Where the leader first meets the subject's outline as seen from the eyes, pulled back toward the
        // chip; the anchor when there is no outline; null when the leader would start on or inside it.
        private Vector3? LeaderEnd(Vector3 eyes, Vector3 from, Vector3 to)
        {
            if (subjectOutline.Count < 3) return to;
            var first = float.PositiveInfinity;
            for (var index = 0; index < subjectOutline.Count; index++)
            {
                var a = subjectOutline[index] - eyes;
                var b = subjectOutline[(index + 1) % subjectOutline.Count] - eyes;
                // The plane through the eyes and this edge; the leader crosses the edge where it crosses that plane between its ends.
                var normal = Vector3.Cross(a, b);
                var start = Vector3.Dot(normal, from - eyes);
                var finish = Vector3.Dot(normal, to - eyes);
                if (Mathf.Abs(start - finish) < 1e-9f) continue;
                var along = start / (start - finish);
                if (along < 0f || along > 1f || along >= first) continue;
                var crossing = from + (to - from) * along - eyes;
                if (Vector3.Dot(Vector3.Cross(a, crossing), normal) < 0f || Vector3.Dot(Vector3.Cross(crossing, b), normal) < 0f) continue;
                first = along;
            }
            if (float.IsPositiveInfinity(first) || Vector3.Distance(from, to) * first <= LeaderGap) return null;
            return Vector3.MoveTowards(from + (to - from) * first, from, LeaderGap);
        }

        /// <summary>Turns the visual to the eyes; focus accents never move or resize the collider.</summary>
        public void Face(Transform head)
        {
            var toChip = transform.position - head.position;
            var distance = toChip.magnitude;
            if (distance > 1e-3f) transform.rotation = Quaternion.LookRotation(toChip / distance, Vector3.up);
            transform.localScale = Vector3.one * Layout.ApparentScale(distance) * Shrink;
            var nextFocus = reducedMotion ? (focused ? 1f : 0f) : Mathf.MoveTowards(focusAmount, focused ? 1f : 0f, Time.unscaledDeltaTime / 0.08f);
            var nextReveal = reducedMotion ? 1f : Mathf.MoveTowards(reveal, 1f, Time.unscaledDeltaTime / 0.24f);
            if (!Mathf.Approximately(nextFocus, focusAmount) || !Mathf.Approximately(nextReveal, reveal))
            {
                focusAmount = nextFocus;
                reveal = nextReveal;
                if (visual != null) visual.localScale = Vector3.one * (1f + 0.035f * focusAmount);
                ApplyAppearance();
            }
            if (leader != null && Anchor != null && leader.enabled)
            {
                var bottom = transform.TransformPoint(new Vector3(0f, -size.y / 2f, 0f));
                var end = LeaderEnd(head.position, bottom, Anchor.Value);
                leader.forceRenderingOff = end == null;
                leader.SetPosition(0, bottom);
                leader.SetPosition(1, end ?? bottom);
                // With AA disabled a thinner line can draw nothing: hold 1.3 mrad at the farther end.
                leader.widthMultiplier = Mathf.Max(.0007f, .0013f * Mathf.Max(Vector3.Distance(head.position, bottom), Vector3.Distance(head.position, end ?? bottom)));
            }
        }
    }
}
