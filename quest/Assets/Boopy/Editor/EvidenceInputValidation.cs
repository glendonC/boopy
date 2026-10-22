#nullable enable
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Boopy.Client;
using TMPro;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    public static class EvidenceInputValidation
    {
        public static void Validate()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            HangulFont.Install();
            var root = new GameObject("Synthetic evidence input validation");
            try
            {
                var eyes = new GameObject("Synthetic eyes").transform; eyes.SetParent(root.transform, false);
                var console = ContextConsole.Create(root.transform, eyes);
                console.Activate(ConsoleAction.Settings);
                var action = console.GetComponentsInChildren<SpatialAction>(true).Single(value => value.Action == ConsoleAction.EvidenceSource);
                Require(action.gameObject.activeSelf && action.AccessibleLabel == "Include photo: on", "Physical default or input action missing.");
                console.Activate(ConsoleAction.EvidenceSource);
                Require(console.InputPolicy.SpokenOnly && action.AccessibleLabel == "Include photo: off", "Spoken selector did not apply.");
                console.InputPolicy.Begin(); console.ShowListening();
                Require(console.InputPolicy.Pending != null && !console.InputPolicy.Pending.RequiresPicture, "Spoken-only listening requested a picture.");
                Require(console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Intent instrument").BodyText == "Listening…\nLet go when you’re done.", "Listening copy falsely claims picture capture.");
                var app = root.AddComponent<BoopyApp>();
                var hand = new HandInput(true, null, null);
                Set(app, "console", console); Set(app, "active", hand); Set(app, "pendingEvidence", console.InputPolicy.Pending);
                // No microphone clip exists: exercise the production release failure branch.
                typeof(BoopyApp).GetMethod("Handle", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(app, new object[] { PinchEvent.Released, hand });
                Require(console.InputPolicy.Pending == null, "Empty speech leaves pending input latch.");
                Require(console.InputPolicy.Toggle(), "Empty speech blocks changing source.");
                Require(console.InputPolicy.Begin() != null, "Empty speech blocks the next turn.");
                console.InputPolicy.End();
                var strip = DialogueStrip.Create(root.transform, eyes);
                Set(app, "dialogue", strip);
                var scene = SessionScene.Create(root.transform, root.AddComponent<RoomCamera>(), eyes);
                scene.MoveConsole(console, Vector3.forward);
                Set(app, "scene", scene);
                Set(app, "session", new SessionView());
                Set(app, "cancelledWaitNotice", "Stopped waiting. The Mac may still finish this capture.");
                Set(app, "inputAllowed", false);
                strip.Hide();
                typeof(BoopyApp).GetMethod("OnFocusAcquired", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(app, null);
                Require(strip.gameObject.activeSelf && strip.Stage == DialogueStage.Error && strip.FullText.Contains("Mac may still finish"), "Focus return lost truthful cancelled-wait caption: stage=" + strip.Stage + ", active=" + strip.gameObject.activeSelf + ", text=" + strip.FullText + ", busy=" + typeof(BoopyApp).GetField("busy", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(app));
                var saved = new SessionView { Id = "synthetic-saved", State = "committed", Notice = "Ready on your Mac. Not sent yet.", Committed = new Committed { PackageId = "ctx_synthetic_saved" } };
                typeof(BoopyApp).GetMethod("Apply", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(app, new object[] { saved });
                Require(typeof(BoopyApp).GetField("cancelledWaitNotice", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(app) == null, "A newer save failed to clear the cancelled wait.");
                Set(app, "inputAllowed", false); strip.Hide();
                typeof(BoopyApp).GetMethod("OnFocusAcquired", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(app, null);
                Require(strip.Stage == DialogueStage.LocalSave && strip.FullText == "Context kept on your Mac. Handoff not prepared. Not sent yet.", "Focus return resurrected an obsolete cancellation over save.");
                strip.Hide();
                console.ShowCapture(); console.Activate(ConsoleAction.Settings);
                Render(console, eyes);
                console.Activate(ConsoleAction.EvidenceSource);
                Render(console, eyes, "boopy-evidence-input-spoken.png");
                Debug.Log("Boopy evidence input validation passed (synthetic; no wearer test).");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }
        private static void Set(object target, string name, object? value) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(target, value);
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
        private static void Render(ContextConsole console, Transform eyes, string name = "boopy-evidence-input.png")
        {
            var camera = eyes.GetComponent<Camera>();
            if (camera == null) camera = eyes.gameObject.AddComponent<Camera>();
            camera.nearClipPlane = .05f; camera.farClipPlane = 10; camera.allowHDR = false; camera.allowMSAA = false;
            camera.fieldOfView = 58; camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(.15f, .17f, .19f);
            console.Place(new Vector3(0, 0, 1));
            foreach (var text in console.GetComponentsInChildren<TextMeshPro>()) text.ForceMeshUpdate(true, true);
            console.RefreshVisuals(1f);
            var target = new RenderTexture(1000, 1000, 24); target.Create(); camera.targetTexture = target;
            var previous = RenderTexture.active;
            var image = new Texture2D(1000, 1000, TextureFormat.RGB24, false);
            try {
                camera.Render(); RenderTexture.active = target;
                image.ReadPixels(new Rect(0, 0, 1000, 1000), 0, 0); image.Apply();
                var output = Path.Combine(Path.GetTempPath(), name);
                Directory.CreateDirectory(Path.GetDirectoryName(output)!); File.WriteAllBytes(output, image.EncodeToPNG());
            } finally { camera.targetTexture = null; RenderTexture.active = previous; UnityEngine.Object.DestroyImmediate(target); UnityEngine.Object.DestroyImmediate(image); }
        }
    }
}
