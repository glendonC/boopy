#nullable enable
using System;
using System.IO;
using System.Linq;
using TMPro;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>
    /// Korean captions break at word spaces, not between syllables of one word. The project's TMP
    /// Settings turn on TextMeshPro's modern Hangul line breaking; this renders one synthetic Korean
    /// caption with the setting off and on, checks that the project value is on, and checks that no
    /// line of the caption ends inside a word while it is on.
    /// </summary>
    public static class HangulBreakValidation
    {
        /// <summary>
        /// Run first, before anything loads a face: the app builds its status line before its console, so the
        /// status line must choose IBM Plex Sans itself rather than TextMesh Pro's default LiberationSans.
        /// </summary>
        private static void StatusLineStartsInPlex()
        {
            var root = new GameObject("SYNTHETIC status line");
            try
            {
                StatusLine.Create(root.transform, root.transform, Visuals.Quad());
                var text = root.GetComponentInChildren<TextMeshPro>(true);
                Require(text != null && text.font == BoopyTypography.Load(), $"The status line is set in {text?.font?.name}, not IBM Plex Sans.");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }

        private const string Caption = "사막 캠프에서 낙타를 텐트 왼쪽에 놓고 한국어로 말해 보세요. 그다음 낙타가 텐트 왼쪽에 있어요라고 말해 보세요.";
        private static readonly string Output = Environment.GetEnvironmentVariable("BOOPY_RENDER_DIR") is string dir && dir.Length > 0 ? dir : Path.GetTempPath();

        public static void ValidateAndRender()
        {
            StatusLineStartsInPlex();
            HangulFont.Install();
            var project = TMP_Settings.useModernHangulLineBreakingRules;
            Require(project, "TMP Settings do not break Korean at word spaces (m_UseModernHangulLineBreakingRules is 0).");
            var root = new GameObject("SYNTHETIC Korean caption");
            var target = new RenderTexture(1600, 1000, 24);
            var pixels = new Texture2D(1600, 1000, TextureFormat.RGB24, false);
            try
            {
                var camera = new GameObject("Synthetic eyes").AddComponent<Camera>();
                camera.transform.SetParent(root.transform, false);
                camera.transform.position = new Vector3(0, 1.55f, 0);
                camera.fieldOfView = 58; camera.clearFlags = CameraClearFlags.SolidColor;
                camera.backgroundColor = new Color(.69f, .72f, .73f);
                camera.targetTexture = target;
                var strip = DialogueStrip.Create(root.transform, camera.transform);
                strip.SetComfort(1, true);
                var before = Draw(strip, camera, target, pixels, false, "before");
                var after = Draw(strip, camera, target, pixels, true, "after");
                Require(before > 0, "The legacy rule broke no word in the synthetic caption, so this check would prove nothing.");
                Require(after == 0, $"With modern Hangul line breaking on, {after} caption lines still end inside a word.");
                Debug.Log($"Boopy Hangul line breaking validation passed: legacy rule ended {before} lines inside a word, modern rule none (synthetic caption).");
            }
            finally
            {
                TMP_Settings.useModernHangulLineBreakingRules = project;
                RenderTexture.active = null;
                UnityEngine.Object.DestroyImmediate(root); UnityEngine.Object.DestroyImmediate(pixels); target.Release(); UnityEngine.Object.DestroyImmediate(target);
            }
        }

        /// <summary>Show the caption under one rule, render it, and count lines that end inside a word.</summary>
        private static int Draw(DialogueStrip strip, Camera camera, RenderTexture target, Texture2D pixels, bool modern, string name)
        {
            TMP_Settings.useModernHangulLineBreakingRules = modern;
            strip.Show(DialogueStage.Response, Caption);
            for (var frame = 0; frame < 30; frame++) strip.RefreshVisuals(.05f);
            var caption = strip.GetComponentsInChildren<TextMeshPro>().First(text => text.text == strip.VisibleText);
            caption.ForceMeshUpdate(true, true);
            var info = caption.textInfo;
            Require(info.lineCount > 1, "The synthetic caption did not wrap, so it cannot show line breaking.");
            var inside = 0;
            for (var line = 0; line < info.lineCount - 1; line++)
            {
                var last = info.lineInfo[line].lastCharacterIndex;
                var next = last + 1 < info.characterCount ? info.characterInfo[last + 1].character : ' ';
                if (!char.IsWhiteSpace(info.characterInfo[last].character) && !char.IsWhiteSpace(next)) inside++;
            }
            camera.Render(); RenderTexture.active = target;
            pixels.ReadPixels(new Rect(0, 0, 1600, 1000), 0, 0); pixels.Apply();
            var path = Path.Combine(Output, "boopy-SYNTHETIC-hangul-caption-" + name + ".png");
            File.WriteAllBytes(path, pixels.EncodeToPNG());
            Debug.Log($"Boopy Korean caption render ({(modern ? "modern" : "legacy")} Hangul line breaking, {info.lineCount} lines, {inside} inside a word): {path}");
            return inside;
        }

        private static void Require(bool valid, string message) { if (!valid) throw new InvalidOperationException(message); }
    }
}
