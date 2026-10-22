#nullable enable
using TMPro;
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>A brightness sweep through real waiting text, never simulated progress.</summary>
    public static class TextShimmer
    {
        public static void Apply(TextMeshPro text, float time, bool active, float opacity)
        {
            text.ForceMeshUpdate();
            var info = text.textInfo;
            var min = float.PositiveInfinity; var max = float.NegativeInfinity;
            for (var i = 0; i < info.characterCount; i++)
            {
                var glyph = info.characterInfo[i];
                if (!glyph.isVisible) continue;
                min = Mathf.Min(min, glyph.bottomLeft.x); max = Mathf.Max(max, glyph.topRight.x);
            }
            var width = Mathf.Max(.001f, max - min);
            var band = Mathf.Repeat(time / 2f, 1f) * 1.6f - .3f;
            for (var i = 0; i < info.characterCount; i++)
            {
                var glyph = info.characterInfo[i]; if (!glyph.isVisible) continue;
                var x = ((glyph.bottomLeft.x + glyph.topRight.x) * .5f - min) / width;
                var distance = (x - band) / .18f;
                var light = active ? .48f + .52f * Mathf.Exp(-distance * distance) : 1f;
                var color = (Color32)new Color(SpatialTheme.Ivory.r * light, SpatialTheme.Ivory.g * light, SpatialTheme.Ivory.b * light, opacity);
                var colors = info.meshInfo[glyph.materialReferenceIndex].colors32;
                for (var corner = 0; corner < 4; corner++) colors[glyph.vertexIndex + corner] = color;
            }
            text.UpdateVertexData(TMP_VertexDataUpdateFlags.Colors32);
        }
    }
}
