#nullable enable
using System;
using System.IO;
using System.Reflection;
using Boopy.Client;
using TMPro;
using UnityEditor;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    public static class DialogueValidation
    {
        [MenuItem("Boopy/Validate Dialogue Strip")]
        public static void Validate()
        {
            HangulFont.Install();
            var root = new GameObject("Synthetic dialogue validation");
            try
            {
                var eyes = new GameObject("Synthetic eyes").transform; eyes.SetParent(root.transform, false);
                var strip = DialogueStrip.Create(root.transform, eyes);
                Require(!strip.gameObject.activeSelf, "Caption shown before an actual interaction.");
                foreach (DialogueStage stage in Enum.GetValues(typeof(DialogueStage)))
                {
                    strip.Show(stage, "Synthetic response: 사하라 여행.");
                    Require(stage == DialogueStage.Listening || stage == DialogueStage.Working
                        ? strip.SpeakerText == ""
                        : strip.SpeakerText.StartsWith("Boopy"), "Activity repeated its state, or a response lost Boopy attribution.");
                    Require(strip.VisibleText.Contains("사하라"), "Hangul caption lost.");
                    Require(strip.Stage == stage, "Displayed state differs from actual state.");
                }
                var longText = new string('가', 180);
                strip.Show(DialogueStage.Response, longText);
                Require(strip.FullText == longText, "Caption rewrote source response.");
                Require(strip.PageCount > 1 && strip.SpeakerText.EndsWith(" · 1 of " + strip.PageCount), "Long caption has no explicit full-text access.");
                Require(strip.VisibleText.Length < longText.Length, "Long caption exceeded compact strip.");
                var reconstructed = "";
                for (var index = 0; index < strip.PageCount; index++) { reconstructed += strip.VisibleText; strip.NextPage(); }
                Require(reconstructed == longText, "Caption paging lost original response text.");
                Require(strip.GetComponentsInChildren<TextMeshPro>().Length == 2, "Caption contains extra interface clutter.");
                strip.Hide(); Require(!strip.gameObject.activeSelf, "Hide did not hide caption.");
                var app = root.AddComponent<BoopyApp>();
                typeof(BoopyApp).GetField("dialogue", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(app, strip);
                typeof(BoopyApp).GetMethod("Apply", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(app, new object[] { new SessionView() });
                Require(!strip.gameObject.activeSelf, "An empty session produced a fabricated caption.");
                Debug.Log("Boopy dialogue validation passed (synthetic; wearer comfort unverified).");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }

        public static void Render()
        {
            Validate();
            var root = new GameObject("Synthetic caption render");
            var camera = new GameObject("Synthetic eyes").AddComponent<Camera>();
            camera.transform.SetParent(root.transform, false);
            camera.transform.position = new Vector3(0, 1.55f, 0);
            camera.fieldOfView = 58; camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(.69f, .72f, .73f);
            var strip = DialogueStrip.Create(root.transform, camera.transform);
            strip.SetComfort(1, true);
            strip.Show(DialogueStage.FreshView, "Show me what you want to ask about.\n새로운 장면을 보여 주세요.");
            var output = Path.Combine(Path.GetTempPath(), "boopy-dialogue-preview.png");
            var target = new RenderTexture(1600, 1000, 24);
            camera.targetTexture = target; camera.Render(); RenderTexture.active = target;
            var texture = new Texture2D(1600, 1000, TextureFormat.RGB24, false);
            texture.ReadPixels(new Rect(0, 0, 1600, 1000), 0, 0); texture.Apply();
            File.WriteAllBytes(output, texture.EncodeToPNG());
            strip.NextPage(); camera.Render();
            texture.ReadPixels(new Rect(0, 0, 1600, 1000), 0, 0); texture.Apply();
            File.WriteAllBytes(Path.Combine(Path.GetTempPath(), "boopy-dialogue-preview-page2.png"), texture.EncodeToPNG());
            RenderTexture.active = null; camera.targetTexture = null;
            UnityEngine.Object.DestroyImmediate(texture); UnityEngine.Object.DestroyImmediate(target);
            UnityEngine.Object.DestroyImmediate(root);
            Debug.Log("Boopy synthetic dialogue preview: " + output);
        }
        private static void Require(bool valid, string message) { if (!valid) throw new Exception(message); }
    }
}
