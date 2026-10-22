#nullable enable
using Boopy.Client;
using TMPro;
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>
    /// One line of what Boopy is doing or needs, below the line of sight. It follows the head
    /// lazily rather than being locked to it, the one element that moves with the person.
    /// </summary>
    public sealed class StatusLine : MonoBehaviour
    {
        private const float Distance = 0.9f;
        private const float BelowDegrees = 20f;
        private const float TextWidth = 0.42f;
        private const float Padding = 0.018f;
        private const float IconSpace = 0.04f;

        private TextMeshPro? text;
        private MeshRenderer? plate;
        private LineRenderer? icon;
        private LineRenderer? track;
        private LineRenderer? accent;
        private Transform? head;
        private Vector3 velocity;
        private float hideAt = float.MaxValue;
        private InteractionActivity activity;
        private float width;
        private float height;

        public static StatusLine Create(Transform parent, Transform head, Mesh quad)
        {
            var go = new GameObject("Status");
            go.transform.SetParent(parent, false);
            var line = go.AddComponent<StatusLine>();
            line.head = head;
            var plateObject = new GameObject("Plate");
            plateObject.transform.SetParent(go.transform, false);
            plateObject.AddComponent<MeshFilter>().sharedMesh = quad;
            line.plate = plateObject.AddComponent<MeshRenderer>();
            line.plate.sharedMaterial = Visuals.Solid;
            line.plate.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            var block = new MaterialPropertyBlock();
            block.SetColor("_Color", Visuals.Plate);
            line.plate.SetPropertyBlock(block);
            var textObject = new GameObject("Text");
            textObject.transform.SetParent(go.transform, false);
            textObject.transform.localPosition = new Vector3(0f, 0f, -0.001f);
            line.text = textObject.AddComponent<TextMeshPro>();
            // IBM Plex Sans, as every other text; TextMesh Pro's default is still LiberationSans when the app builds this line.
            line.text.font = BoopyTypography.Load();
            line.text.fontSize = 0.30f;
            line.text.alignment = TextAlignmentOptions.Left;
            line.text.textWrappingMode = TextWrappingModes.Normal;
            line.text.richText = false;
            line.text.color = Visuals.Text;
            line.text.rectTransform.sizeDelta = new Vector2(TextWidth, 0.05f);
            line.icon = LocalLine(go.transform, "Activity", 0.0022f);
            line.track = LocalLine(go.transform, "Activity track", 0.001f);
            line.accent = LocalLine(go.transform, "Activity accent", 0.0018f);
            line.track.positionCount = 2;
            line.accent.positionCount = 2;
            go.SetActive(false);
            return line;
        }

        private static LineRenderer LocalLine(Transform parent, string name, float lineWidth)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);
            var line = Visuals.Line(go, lineWidth, false, Visuals.Solid);
            line.useWorldSpace = false;
            return line;
        }

        /// <summary>Actual recording/request state; animations are indeterminate, not audio levels or completion.</summary>
        public void SetActivity(bool listening, bool thinking)
        {
            var next = ActivityFeedback.From(listening, thinking);
            if (activity == next) return;
            activity = next;
            DrawActivity();
        }

        /// <summary>Shows a line; null hides it. A line with a lifetime disappears by itself.</summary>
        public void Say(string? words, float seconds = 0f)
        {
            if (text == null || plate == null) return;
            if (string.IsNullOrWhiteSpace(words))
            {
                gameObject.SetActive(false);
                return;
            }
            if (!gameObject.activeSelf)
            {
                gameObject.SetActive(true);
                transform.position = Target();
                velocity = Vector3.zero;
            }
            text.text = words;
            // TMP must have an initialized font before preferred values are measured after hiding.
            text.ForceMeshUpdate(true, true);
            var preferred = text.GetPreferredValues(words, TextWidth, Mathf.Infinity);
            var textWidth = Mathf.Clamp(preferred.x, 0.12f, TextWidth);
            var textHeight = Mathf.Max(preferred.y, 0.026f);
            width = textWidth + Padding * 2f + IconSpace;
            height = textHeight + Padding * 2f;
            text.rectTransform.sizeDelta = new Vector2(textWidth, textHeight);
            text.transform.localPosition = new Vector3(IconSpace / 2f, 0f, -0.001f);
            plate.transform.localScale = new Vector3(width, height, 1f);
            hideAt = seconds > 0f ? Time.unscaledTime + seconds : float.MaxValue;
            DrawActivity();
        }

        private void DrawActivity()
        {
            if (icon == null || track == null || accent == null) return;
            var color = activity == InteractionActivity.Listening ? Visuals.Intent
                : activity == InteractionActivity.Thinking ? Visuals.Confirmed : Visuals.Proposed;
            icon.transform.localPosition = new Vector3(-width / 2f + Padding + 0.011f, 0f, -0.001f);
            icon.transform.localRotation = Quaternion.identity;
            icon.transform.localScale = Vector3.one;
            Visuals.Tint(icon, color);
            if (activity == InteractionActivity.Listening)
            {
                // A steady stop/record glyph plus a soft perimeter pulse: never a fabricated waveform.
                icon.loop = true;
                icon.positionCount = 4;
                var radius = 0.007f;
                icon.SetPosition(0, new Vector3(-radius, -radius, 0f));
                icon.SetPosition(1, new Vector3(radius, -radius, 0f));
                icon.SetPosition(2, new Vector3(radius, radius, 0f));
                icon.SetPosition(3, new Vector3(-radius, radius, 0f));
            }
            else if (activity == InteractionActivity.Thinking)
            {
                icon.loop = false;
                icon.positionCount = 20;
                for (var i = 0; i < icon.positionCount; i++)
                {
                    var angle = i * Mathf.PI * 1.4f / (icon.positionCount - 1);
                    icon.SetPosition(i, new Vector3(Mathf.Cos(angle), Mathf.Sin(angle), 0f) * 0.009f);
                }
            }
            else
            {
                icon.loop = false;
                icon.positionCount = 2;
                icon.SetPosition(0, new Vector3(-0.007f, 0f, 0f));
                icon.SetPosition(1, new Vector3(0.007f, 0f, 0f));
            }
            var left = -width / 2f + Padding;
            var right = width / 2f - Padding;
            var y = -height / 2f + 0.004f;
            track.SetPosition(0, new Vector3(left, y, -0.001f));
            track.SetPosition(1, new Vector3(right, y, -0.001f));
            Visuals.Tint(track, new Color(color.r, color.g, color.b, 0.25f));
            accent.enabled = activity != InteractionActivity.Ready;
            Visuals.Tint(accent, color);
            AnimateActivity();
        }

        private void AnimateActivity()
        {
            if (icon == null || accent == null || activity == InteractionActivity.Ready) return;
            if (activity == InteractionActivity.Thinking)
                icon.transform.localRotation = Quaternion.AngleAxis(-Time.unscaledTime * 110f, Vector3.forward);
            else
                icon.transform.localScale = Vector3.one * (1f + 0.10f * Mathf.Sin(Time.unscaledTime * 4f));
            var left = -width / 2f + Padding;
            var right = width / 2f - Padding;
            var y = -height / 2f + 0.004f;
            var segment = Mathf.Min(0.065f, right - left);
            var phase = activity == InteractionActivity.Thinking
                ? 0.5f + 0.5f * Mathf.Sin(Time.unscaledTime * 2.5f) : 0f;
            var from = left + Mathf.Max(0f, right - left - segment) * phase;
            accent.SetPosition(0, new Vector3(from, y, -0.0012f));
            accent.SetPosition(1, new Vector3(from + segment, y, -0.0012f));
        }

        private Vector3 Target()
        {
            if (head == null) return transform.position;
            var flat = new Vector3(head.forward.x, 0f, head.forward.z);
            if (flat.sqrMagnitude < 1e-6f) flat = Vector3.forward;
            var down = Quaternion.AngleAxis(BelowDegrees, Vector3.Cross(Vector3.up, flat.normalized));
            return head.position + down * flat.normalized * Distance;
        }

        private void LateUpdate()
        {
            if (head == null) return;
            if (activity == InteractionActivity.Ready && Time.unscaledTime > hideAt)
            {
                gameObject.SetActive(false);
                return;
            }
            transform.position = Vector3.SmoothDamp(transform.position, Target(), ref velocity, 0.2f);
            var toLine = transform.position - head.position;
            if (toLine.sqrMagnitude > 1e-6f) transform.rotation = Quaternion.LookRotation(toLine.normalized, Vector3.up);
            AnimateActivity();
        }
    }
}
