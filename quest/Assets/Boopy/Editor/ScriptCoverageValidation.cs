#nullable enable
using System;
using System.IO;
using System.Linq;
using Boopy.Client;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>
    /// Every script Boopy may show is drawn by a real face or by DESIGN's honest line, never as empty boxes: French with
    /// accents, Hangul, Japanese, Chinese and Tifinagh draw (this Mac has faces for all of them); Arabic, which joins its
    /// letters right to left, shows "(can't show Arabic text yet)"; a character no face has shows "(can't show this text
    /// yet)". Only what is drawn changes: the item and the line keep the words themselves. A chip and a line per script go
    /// to stills in BOOPY_RENDER_DIR. Synthetic words only.
    /// </summary>
    public static class ScriptCoverageValidation
    {
        private static readonly (string Name, string Words, string? Honest)[] Samples =
        {
            ("french", "Le chameau déjà là, œuvre à l'oasis", null),
            ("hangul", "낙타 사막", null),
            ("japanese", "らくだ ラクダ 駱駝", null),
            ("chinese", "骆驼和沙漠", null),
            ("tifinagh", "ⴰⵍⵖⵎ", null),
            ("arabic", "جمل", "(can't show Arabic text yet)"),
            ("uncovered", "\U000F0000\U000F0001", "(can't show this text yet)"),
        };

        public static void ValidateAndRender()
        {
            try
            {
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                ScriptCoverage.Install();
                var output = Environment.GetEnvironmentVariable("BOOPY_RENDER_DIR") is string dir && dir.Length > 0 ? dir : Path.Combine(Path.GetTempPath(), "boopy-script-coverage");
                Directory.CreateDirectory(output);
                foreach (var (name, words, honest) in Samples)
                {
                    var shown = ScriptCoverage.Prepare(words);
                    Require(honest == null ? shown == words : shown == honest, $"{name}: drawn as \"{shown}\".");
                    Render(name, words, shown, output);
                }
                Debug.Log("Boopy script coverage validation passed (synthetic words): " + output);
            }
            catch (Exception error)
            {
                Debug.LogException(error);
                if (Application.isBatchMode) EditorApplication.Exit(1);
                else throw;
            }
        }

        // A chip and a line with the words: each drawn character has a real glyph, and the item and line keep the words.
        private static void Render(string name, string words, string shown, string output)
        {
            const int width = 1200, height = 700;
            var root = new GameObject("SYNTHETIC script " + name);
            var target = new RenderTexture(width, height, 24); target.Create();
            var pixels = new Texture2D(width, height, TextureFormat.RGB24, false);
            var previous = RenderTexture.active;
            try
            {
                var eyes = new GameObject("Synthetic eyes").transform; eyes.SetParent(root.transform, false);
                var item = new Item { Id = "synthetic-" + name, Kind = "object", Label = words, Statement = "Synthetic.", Status = "proposed", Confidence = .5f };
                var chip = Chip.Create(root.transform, Visuals.Quad());
                chip.gameObject.SetActive(true); chip.Show(item, false); chip.Place(new Vector3(-.12f, .08f, 1f), null); chip.Face(eyes);
                var strip = DialogueStrip.Create(root.transform, eyes);
                strip.SetComfort(1f, true);
                strip.Show(DialogueStage.Response, words);
                for (var frame = 0; frame < 30; frame++) strip.RefreshVisuals(.05f);
                Require(item.Label == words && strip.FullText == words, $"{name}: preparing the drawn words changed the words themselves.");
                var label = chip.GetComponentsInChildren<TextMeshPro>(true).Single(text => text.name == "Label");
                Require(label.text == shown && strip.VisibleText == shown, $"{name}: the chip or the line draws \"{label.text}\" / \"{strip.VisibleText}\".");
                // TextMesh Pro reports every character no face has, and draws its box in its place.
                var missing = new System.Collections.Generic.List<string>();
                TMP_Text.MissingCharacterEventCallback report = (unicode, index, text, font, component) => missing.Add($"U+{unicode:X4}");
                TMP_Text.OnMissingCharacter += report;
                try
                {
                    foreach (var text in new[] { label, strip.GetComponentsInChildren<TextMeshPro>().First(candidate => candidate.text == strip.VisibleText) })
                    {
                        text.ForceMeshUpdate(true, true);
                        var info = text.textInfo;
                        for (var i = 0; i < info.characterCount; i++)
                            Require(info.characterInfo[i].character != '\u25A1', $"{name}: character {i} is drawn as an empty box in \"{text.text}\".");
                    }
                }
                finally { TMP_Text.OnMissingCharacter -= report; }
                Require(missing.Count == 0, $"{name}: no face has {string.Join(", ", missing.Distinct())}.");
                // Hangul stays in the one family: the bundled IBM Plex Sans KR, Medium on the chip and Regular on the line.
                if (name == "hangul")
                    foreach (var (text, face) in new[] { (label, "IBMPlexSansKR-Medium"), (strip.GetComponentsInChildren<TextMeshPro>().First(candidate => candidate.text == strip.VisibleText), "IBMPlexSansKR-Regular") })
                    {
                        var drawn = text.textInfo.characterInfo.Take(text.textInfo.characterCount).Where(character => !char.IsWhiteSpace(character.character)).ToArray();
                        Require(drawn.All(character => character.fontAsset != null && character.fontAsset.name.StartsWith(face, StringComparison.Ordinal)),
                            $"hangul: drawn in {string.Join(", ", drawn.Select(character => character.fontAsset == null ? "none" : character.fontAsset.name).Distinct())}, not {face}.");
                    }
                var camera = eyes.gameObject.AddComponent<Camera>();
                camera.fieldOfView = 40; camera.nearClipPlane = .05f; camera.clearFlags = CameraClearFlags.SolidColor;
                camera.backgroundColor = new Color(.42f, .44f, .45f); camera.allowHDR = false; camera.allowMSAA = false;
                camera.transform.LookAt(new Vector3(0f, 0f, 1f));
                camera.targetTexture = target; camera.Render(); camera.targetTexture = null;
                RenderTexture.active = target; pixels.ReadPixels(new Rect(0, 0, width, height), 0, 0); pixels.Apply();
                File.WriteAllBytes(Path.Combine(output, "SYNTHETIC-script-" + name + ".png"), pixels.EncodeToPNG());
            }
            finally
            {
                RenderTexture.active = previous;
                UnityEngine.Object.DestroyImmediate(root); UnityEngine.Object.DestroyImmediate(pixels); target.Release(); UnityEngine.Object.DestroyImmediate(target);
            }
        }

        private static void Require(bool valid, string message) { if (!valid) throw new InvalidOperationException(message); }
    }
}
