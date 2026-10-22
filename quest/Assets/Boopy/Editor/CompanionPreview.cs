#nullable enable
using System;
using System.IO;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>Close-up synthetic material/expression preview; never needs headset data.</summary>
    public static class CompanionPreview
    {
        [MenuItem("Boopy/Render Companion Preview")]
        public static void Render()
        {
            try
            {
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                var root = new GameObject("Companion expression preview").transform;
                var camera = new GameObject("Preview eyes").AddComponent<Camera>();
                camera.transform.position = new Vector3(0f, .008f, -.6f);
                camera.orthographic = true;
                camera.orthographicSize = .18f;
                camera.nearClipPlane = .01f;
                camera.farClipPlane = 3f;
                camera.clearFlags = CameraClearFlags.SolidColor;
                camera.backgroundColor = new Color(.19f, .21f, .24f);
                BoopyTypography.Load();
                var states = new[] { "idle", "listening", "processing", "review", "saved", "error" };
                for (var index = 0; index < states.Length; index++)
                {
                    var scout = CompanionOrb.Create(root);
                    scout.transform.position = new Vector3((index - 2.5f) * .205f, .017f, 0f);
                    scout.SetState(states[index]);
                    scout.Refresh(0f, true);
                    if (scout.GetComponentsInChildren<Collider>().Length != 0)
                        throw new InvalidOperationException("The companion must not intercept scene controls.");
                    var caption = SpatialTheme.Text(root, "State " + states[index], .15f, Color.white);
                    caption.text = states[index];
                    caption.alignment = TextAlignmentOptions.Center;
                    caption.rectTransform.sizeDelta = new Vector2(.180f, .03f);
                    caption.transform.position = new Vector3(scout.transform.position.x, -.100f, 0f);
                    caption.transform.rotation = Quaternion.identity;
                }
                var path = Path.Combine(Path.GetTempPath(), "boopy-companion-expressions.png");
                Capture(camera, 2560, 700, path);
                root.gameObject.SetActive(false);
                var animatedRoot = new GameObject("Synthetic companion motion").transform;
                var animated = CompanionOrb.Create(animatedRoot);
                camera.orthographicSize = .125f;
                camera.transform.position = new Vector3(0f, .008f, -.6f);
                var directory = Path.Combine(Path.GetTempPath(), "boopy-companion-behavior-sequence");
                Directory.CreateDirectory(directory);
                var disclosure=SpatialTheme.Text(animatedRoot,"Synthetic event disclosure",.012f,Color.white);
                disclosure.alignment=TextAlignmentOptions.Center;disclosure.rectTransform.sizeDelta=new Vector2(.24f,.035f);
                disclosure.transform.position=new Vector3(0f,-.095f,0f);
                var frame = 0;
                // Synthetic application events, not autonomous travel or measured provider timing.
                var sequence = new[] { "greeting", "idle", "focus", "listening", "processing", "review", "playback", "listening", "processing-reduced", "processing-pinned", "error", "idle", "saved" };
                foreach (var phase in sequence)
                {
                    animated.SetSpeaking(0f);
                    animated.ReturnHome();
                    var processing=phase.StartsWith("processing",StringComparison.Ordinal);
                    var reduced=phase=="processing-reduced";
                    animated.SetFrozen(phase=="processing-pinned");
                    animated.SetState(phase == "focus" || phase == "greeting" ? "idle" : phase == "playback" ? "review" : processing ? "processing" : phase);
                    disclosure.text="SYNTHETIC · "+phase;
                    if(phase=="greeting") {animated.SetAttention(new Vector3(.2f,.04f,-1f));animated.Greet();}
                    if (phase == "focus") animated.FlyToward(new Vector3(.35f, .08f, -1f));
                    for (var tick = 0; tick < (processing ? 96 : 18); tick++)
                    {
                        animated.SetSpeaking(phase == "playback" ? .25f + .55f * Mathf.Abs(Mathf.Sin(tick * .6f)) : 0f);
                        animated.Refresh(1f / 12f, reduced);
                        ValidateEnvelope(animated);
                        Capture(camera, 700, 700, Path.Combine(directory, $"frame-{frame++:D3}.png"));
                    }
                }
                File.WriteAllText(Path.Combine(directory,"README.txt"),"Synthetic production CompanionOrb event sequence at nominal12fps. Processing lasts8s per authored segment to expose sustained considering, reduced and translation-pinned behavior. No model latency, provider progress, real microphone, audible playback or wearer comfort is measured. Playback magnitude is an explicit synthetic input. Idle adds no new behavior. Each frame names its synthetic event.\n");
                Debug.Log("Boopy companion preview: " + path + "; 12fps production motion frames: " + directory);
            }
            catch (Exception error)
            {
                Debug.LogException(error);
                if (Application.isBatchMode) EditorApplication.Exit(1);
            }
        }

        private static void ValidateEnvelope(CompanionOrb companion)
        {
            foreach (var filter in companion.GetComponentsInChildren<MeshFilter>())
            {
                if (filter.sharedMesh == null) continue;
                foreach (var vertex in filter.sharedMesh.vertices)
                {
                    var at = companion.transform.InverseTransformPoint(filter.transform.TransformPoint(vertex));
                    if (Mathf.Abs(at.x) > .1001f || Mathf.Abs(at.y) > .1151f)
                        throw new InvalidOperationException("Companion animation left its reserved 200 x 230 mm flight zone.");
                }
            }
        }

        private static void Capture(Camera camera, int width, int height, string path)
        {
            var target = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32);
            camera.targetTexture = target;
            camera.Render();
            var prior = RenderTexture.active;
            RenderTexture.active = target;
            var pixels = new Texture2D(target.width, target.height, TextureFormat.RGB24, false);
            pixels.ReadPixels(new Rect(0f, 0f, target.width, target.height), 0, 0);
            pixels.Apply();
            File.WriteAllBytes(path, pixels.EncodeToPNG());
            RenderTexture.active = prior;
            camera.targetTexture = null;
            UnityEngine.Object.DestroyImmediate(pixels);
            UnityEngine.Object.DestroyImmediate(target);
        }
    }
}
