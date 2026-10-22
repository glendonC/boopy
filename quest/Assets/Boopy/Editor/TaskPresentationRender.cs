#nullable enable
using System;
using System.IO;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>
    /// Stills of the production task presentation in a synthetic room with a synthetic outlined
    /// subject: the task, after an answer, and a wrong item, at standard and large text. Synthetic
    /// views and transport through BoopyApp; not a wearer, timing or provider result.
    /// SpatialPreview shows no console for two reasons: it never creates or docks a dialogue strip,
    /// and its captures refresh the console with a zero time step right after every surface's
    /// reveal was reset to zero, so the console, its text and its controls stay transparent.
    /// These stills dock the strip and advance the reveal before each capture.
    /// </summary>
    public static class TaskPresentationRender
    {
        private const int Width = 1600, Height = 900;

        public static void Render()
        {
            var output = Path.Combine(Path.GetTempPath(), "boopy-task-preview");
            var context = SynchronizationContext.Current;
            try
            {
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                HangulFont.Install();
                SynchronizationContext.SetSynchronizationContext(null);
                Directory.CreateDirectory(output);
                foreach (var large in new[] { false, true }) RenderSize(output, large);
                Debug.Log("Boopy task presentation stills: " + output);
            }
            catch (Exception error)
            {
                Debug.LogException(error);
                if (Application.isBatchMode) EditorApplication.Exit(1);
                else throw;
            }
            finally { SynchronizationContext.SetSynchronizationContext(context); }
        }

        private static void RenderSize(string output, bool large)
        {
            var size = large ? "large" : "standard";
            var previous = RenderTexture.active;
            var target = new RenderTexture(Width, Height, 24);
            var pixels = new Texture2D(Width, Height, TextureFormat.RGB24, false);
            using var f = new TaskPresentationValidation.Fixture(large);
            try
            {
                target.Create();
                var camera = f.Eyes.gameObject.AddComponent<Camera>();
                camera.fieldOfView = 58f; camera.nearClipPlane = .05f; camera.farClipPlane = 10f;
                camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = new Color(.12f, .13f, .14f);
                camera.allowHDR = false; camera.allowMSAA = false; camera.targetTexture = target;
                RenderSettings.ambientLight = new Color(.45f, .45f, .45f);
                var light = new GameObject("Fixed studio light").AddComponent<Light>(); light.transform.SetParent(f.Root.transform);
                light.type = LightType.Directional; light.intensity = 1f; light.transform.rotation = Quaternion.Euler(35f, -30f, 0f);
                Prop(f.Root.transform, "Synthetic floor", new Vector3(0f, -.65f, 2.5f), new Vector3(5f, .10f, 5f), new Color(.26f, .27f, .28f));
                Prop(f.Root.transform, "Synthetic back wall", new Vector3(0f, .6f, 3.4f), new Vector3(5f, 2.6f, .05f), new Color(.20f, .21f, .22f));
                // The stone the synthetic capture grounded: its box lands here from the recorded pose and depth.
                Prop(f.Root.transform, "Synthetic stone marker", new Vector3(-.34f, -.05f, 2f), new Vector3(.56f, .70f, .05f), new Color(.54f, .53f, .50f));
                f.Scene.SetReducedMotion(true); f.Console.SetReducedMotion(true);

                f.Transport.Open.Enqueue(() => TaskPresentationValidation.Reply(HttpStatusCode.OK, TaskPresentationValidation.TaskView()));
                f.Start();
                Still(f, camera, target, pixels, Path.Combine(output, "task-" + size + ".png"));

                var current = (InteractionPresentation)typeof(BoopyApp).GetField("task", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(f.App)!;
                f.Transport.Answers.Enqueue(() => TaskPresentationValidation.Reply(HttpStatusCode.OK,
                    TaskPresentationValidation.TaskView(2, TaskPresentationValidation.Attempts(TaskPresentationValidation.FirstAnswer))));
                ((Task)typeof(BoopyApp).GetMethod("SendAnswer", BindingFlags.Instance | BindingFlags.NonPublic)!
                    .Invoke(f.App, new object[] { current, SpeechValidation.SyntheticWav() })!).GetAwaiter().GetResult();
                Still(f, camera, target, pixels, Path.Combine(output, "answer-" + size + ".png"));

                f.App.PresentTask(TaskPresentationValidation.TaskView(3, TaskPresentationValidation.Attempts(TaskPresentationValidation.FirstAnswer),
                    "[{\"type\":\"status\",\"code\":\"wrong-item\"}]"));
                Still(f, camera, target, pixels, Path.Combine(output, "wrong-item-" + size + ".png"));
            }
            finally
            {
                RenderTexture.active = previous;
                UnityEngine.Object.DestroyImmediate(pixels);
                UnityEngine.Object.DestroyImmediate(target);
            }
        }

        // Advance the production reveal and the companion's attention, then capture one frame.
        private static void Still(TaskPresentationValidation.Fixture f, Camera camera, RenderTexture target, Texture2D pixels, string path)
        {
            for (var frame = 0; frame < 24; frame++)
            {
                foreach (var text in f.Root.GetComponentsInChildren<TextMeshPro>()) text.ForceMeshUpdate(true, true);
                foreach (var chip in TaskPresentationValidation.ActiveChips(f)) chip.Face(f.Eyes);
                foreach (var overlay in f.Scene.GetComponentsInChildren<GroundedOverlay>()) overlay.RefreshVisuals(1f / 24f);
                if (f.Scene.TryGetActiveAnchor(out var anchor)) f.Console.AttendTo(anchor, true);
                f.Console.RefreshVisuals(1f / 24f); f.Strip.RefreshVisuals(1f / 24f);
            }
            camera.Render();
            RenderTexture.active = target;
            pixels.ReadPixels(new Rect(0, 0, Width, Height), 0, 0);
            pixels.Apply();
            File.WriteAllBytes(path, pixels.EncodeToPNG());
        }

        private static void Prop(Transform root, string name, Vector3 position, Vector3 size, Color color)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            go.name = name; go.transform.SetParent(root, false); go.transform.position = position; go.transform.localScale = size;
            var material = new Material(Shader.Find("Standard")) { color = color };
            go.GetComponent<MeshRenderer>().sharedMaterial = material;
            // No collider: the props are scenery, not hit targets for the scene's chip raycasts.
            UnityEngine.Object.DestroyImmediate(go.GetComponent<Collider>());
        }
    }
}
