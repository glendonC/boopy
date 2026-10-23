#nullable enable
using TMPro;
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>Shared physical tokens: one scale, one rhythm, two principal type sizes.</summary>
    public static class SpatialTheme
    {
        // Neutral material roles; evidence-specific semantic colors remain in Visuals.
        public static readonly Color Panel = new Color(16f/255f,17f/255f,18f/255f,.94f);
        public static readonly Color Control = new Color(36f/255f,38f/255f,40f/255f,1f);
        public static readonly Color Emphasis = new Color(52f/255f,55f/255f,58f/255f,1f);
        public static readonly Color TextColor = new Color(243f/255f,244f/255f,243f/255f,1f);
        public static readonly Color Secondary = new Color(184f/255f,188f/255f,191f/255f,1f);
        public static readonly Color Porcelain = new Color(232f/255f,235f/255f,233f/255f,1f);
        public static readonly Color Ink = Panel;
        public static readonly Color Ivory = TextColor;
        public static readonly Color Raised = Control;
        public static readonly Color Smoke = Secondary;
        public static readonly Color Sand = TextColor;
        public static readonly Color Cyan = new Color(.43f,.89f,.94f,1f);
        public static readonly Color ActionRest = new Color(.43f,.89f,.94f,.55f);
        public static readonly Color Amber = new Color(.914f,.773f,.541f,1f);
        /// <summary>docs/design.md Ember, #E5B98C: the attended subject's edge and Boopy's working light.</summary>
        public static readonly Color Ember = new Color(229f / 255f, 185f / 255f, 140f / 255f, 1f);
        public const float RevealSeconds = .320f;
        public const float KeepoutMargin = .04f;
        public const float Width = 0.56f, Padding = 0.015f, Gap = 0.014f;
        public const float Title = 0.27f, Body = 0.23f, Utility = 0.20f, Target = 0.060f;

        public static TextMeshPro Text(Transform parent, string name, float font, Color color)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);
            go.transform.localPosition = Vector3.back * 0.003f;
            var text = go.AddComponent<TextMeshPro>();
            text.font = font >= Title ? BoopyTypography.Medium : BoopyTypography.Load();
            text.fontSize = font;
            text.color = color;
            text.richText = false;
            text.alignment = TextAlignmentOptions.Left;
            text.textWrappingMode = TextWrappingModes.Normal;
            text.overflowMode = TextOverflowModes.Overflow;
            text.GetComponent<MeshRenderer>().sortingOrder = 3;
            return text;
        }

        public static float Height(TextMeshPro text, string words, float width)
        {
            text.ForceMeshUpdate(true, true);
            return text.GetPreferredValues(words, width, Mathf.Infinity).y;
        }

        /// <summary>A visible summary omission; full evidence stays accessible through Details.</summary>
        public static string Summary(TextMeshPro text, string words, float width, float maxHeight)
        {
            if (Height(text, words, width) <= maxHeight) return words;
            var low = 0; var high = words.Length;
            while (low < high)
            {
                var middle = (low + high + 1) / 2;
                if (Height(text, words.Substring(0, middle) + "...", width) <= maxHeight) low = middle;
                else high = middle - 1;
            }
            if (low > 0 && char.IsHighSurrogate(words[low - 1])) low--;
            return words.Substring(0, low) + "...";
        }
    }
}
