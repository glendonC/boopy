#nullable enable
using System;
using System.Linq;
using TMPro;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    public static class FontLifecycleValidation
    {
        public static void Validate()
        {
            var installed = HangulFont.Install();
            Debug.Log("Boopy font probe install=" + (installed != null));
            var regular = BoopyTypography.Load(); var medium = BoopyTypography.Medium;
            Inspect("before", regular, medium);
            Glyphs(regular, "before regular"); Glyphs(medium, "before medium");
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            Inspect("after stored", regular, medium);
            if (HangulFont.Install() == null) throw new InvalidOperationException("System CJK font unavailable after scene reset.");
            var reloaded = BoopyTypography.Load();
            Inspect("after Load", reloaded, BoopyTypography.Medium);
            Glyphs(reloaded, "after regular"); Glyphs(BoopyTypography.Medium, "after medium");
            Debug.Log("Boopy font lifecycle validation passed.");
        }
        private static void Inspect(string stage, TMP_FontAsset? regular, TMP_FontAsset? medium)
        {
            Debug.Log("Boopy font probe " + stage + " default=" + Describe(TMP_Settings.defaultFontAsset) + " regular=" + Describe(regular) + " medium=" + Describe(medium));
        }
        private static string Describe(TMP_FontAsset? asset) => asset == null ? "null" : asset.GetInstanceID() + ":" + asset.name + " fallback=[" + string.Join(",", asset.fallbackFontAssetTable?.Select(f => f == null ? "null" : f.GetInstanceID() + ":" + f.name) ?? Enumerable.Empty<string>()) + "]";
        private static void Glyphs(TMP_FontAsset asset, string stage)
        {
            const string sample = "여행 메모와 한국어 표현";
            var supported = asset.HasCharacters(sample, out uint[] missing, true, true);
            var go = new GameObject("Synthetic Korean glyph probe");
            try
            {
                var text = go.AddComponent<TextMeshPro>(); text.font = asset; text.fontSize = 4; text.text = sample; text.ForceMeshUpdate();
                var hangul = text.textInfo.characterInfo.Take(text.textInfo.characterCount).Where(c => c.character >= '\uAC00' && c.character <= '\uD7A3').ToArray();
                var valid = hangul.Length == sample.Count(c => c >= '\uAC00' && c <= '\uD7A3') && hangul.All(c => c.isVisible && c.textElement != null && c.textElement.unicode == c.character && (c.topRight-c.bottomLeft).sqrMagnitude > 0);
                if (!supported || !valid) throw new InvalidOperationException("Missing actual Korean glyphs: " + stage);
                Debug.Log("Boopy font glyphs " + stage + " supported=" + supported + " missing=" + string.Join(",",missing ?? Array.Empty<uint>()) + " visibleExact=" + valid);
            }
            finally { UnityEngine.Object.DestroyImmediate(go); }
        }
    }
}
