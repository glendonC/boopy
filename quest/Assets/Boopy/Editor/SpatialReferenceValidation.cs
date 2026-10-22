#nullable enable
using System;
using System.Linq;
using System.Reflection;
using Boopy.Client;
using TMPro;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    public static class SpatialReferenceValidation
    {
        public static void Validate()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            HangulFont.Install();
            var root = new GameObject("Synthetic spatial reference validation");
            try
            {
                var eyes = new GameObject("Synthetic eyes").transform; eyes.SetParent(root.transform, false);
                var room = root.AddComponent<RoomCamera>();
                var scene = SessionScene.Create(root.transform, room, eyes);
                var console = ContextConsole.Create(root.transform, eyes); console.Place(new Vector3(0, 0, 1));
                var view = View("synthetic-a");
                console.Render(view); console.Activate(ConsoleAction.Review); console.RefreshVisuals(1f);
                Require(console.SelectedItemId == "synthetic-a", "Initial referent was not selected.");
                var hit = console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Evidence instrument").GetComponent<BoxCollider>();
                var ray = new Ray(eyes.position, hit.transform.TransformPoint(hit.center) - eyes.position);
                Physics.SyncTransforms();
                var latched = console.HitTarget(ray, out _);
                Require(latched == "synthetic-a", "Production reader ray did not resolve the intended target.");
                var app = root.AddComponent<BoopyApp>();
                Set(app, "room", room); Set(app, "scene", scene);
                Set(app, "gaze", Reticle.Create("Synthetic gaze", root.transform, eyes));
                Set(app, "pendingCues", new Cues { TargetItemId = "synthetic-stale" });
                typeof(BoopyApp).GetMethod("Capture", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(app, new object[] { new HandInput(true, null, null), latched!, true });
                Require(Get(app, "pending") == null, "Unready synthetic camera produced pixels.");
                console.Activate(ConsoleAction.NextItem);
                Require(console.SelectedItemId == "synthetic-b", "Synthetic focus did not change.");
                Require((string?)Get(app, "pendingTarget") == "synthetic-a" && ((Cues)Get(app, "pendingCues")!).TargetItemId == "synthetic-a", "Focus change retargeted the pending spoken turn.");
                Require(((Voice)Get(app, "voice")!).Recording == false, "Synthetic reference validation started microphone.");
                console.ShowListening(true);
                Require(console.GetComponentsInChildren<TextMeshPro>().Any(text => text.text.Contains("Listening…")), "Targeted speech has no listening acknowledgement.");
                Require(!console.GetComponentsInChildren<TextMeshPro>().Any(text => text.text.Contains("Correcting this item")), "Old correction-specific wording survived.");
                console.Render(view);
                Require(console.SelectedItemId == "synthetic-b", "Unchanged reference overwrote reader navigation.");
                console.Activate(ConsoleAction.PreviousItem);
                Require(console.SelectedItemId == "synthetic-a", "Reader navigation fixture failed.");
                var changed = View("synthetic-b"); console.Render(changed);
                Require(console.SelectedItemId == "synthetic-b", "Explicit changed referent left reader on the old item.");
                Require(ContextReview.WorldItems(changed)[0].Id == "synthetic-b", "Changed referent failed room-label priority.");
                Require(changed.Items.All(item => item.Status == "proposed" && item.Confidence == .4f), "Selecting a referent changed verification or confidence.");
                console.Activate(ConsoleAction.PreviousItem); console.Render(View("synthetic-b"));
                Require(console.SelectedItemId == "synthetic-a", "Repeated same referent overwrote independent reader focus.");
                Debug.Log("Boopy spatial reference validation passed (synthetic capture boundary; no microphone/camera/device test).");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }
        private static SessionView View(string referent)
        {
            var view = new SessionView { Id = "synthetic-session", State = "review", ReferentId = referent, Model = new ModelRef { Provider = "fixture", Id = "synthetic" } };
            foreach (var id in new[] { "synthetic-a", "synthetic-b" }) view.Items.Add(new Item
            {
                Id = id, Kind = "object", Label = id, Statement = "Synthetic proposed object.", Status = "proposed", Confidence = .4f,
                Grounding = new Grounding { Kind = "box", ObservationId = "synthetic-observation", Box = new Box2 { X0 = .1f, Y0 = .1f, X1 = .2f, Y1 = .2f } },
            });
            return view;
        }
        private static void Set(object target, string name, object? value) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(target, value);
        private static object? Get(object target, string name) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(target);
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
