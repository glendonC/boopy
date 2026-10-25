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
                Capture(app, latched!);
                Require(Get(app, "pending") == null, "Unready synthetic camera produced pixels.");
                console.NextPage();
                Require(console.SelectedItemId == "synthetic-b", "Synthetic focus did not change.");
                Require((string?)Get(app, "pendingTarget") == "synthetic-a" && ((Cues)Get(app, "pendingCues")!).TargetItemId == "synthetic-a", "Focus change retargeted the pending spoken turn.");
                Require(((Voice)Get(app, "voice")!).Recording == false, "Synthetic reference validation started microphone.");
                console.ShowListening(true);
                Require(console.GetComponentsInChildren<TextMeshPro>().Any(text => text.text.Contains("Listening…")), "Targeted speech has no listening acknowledgement.");
                Require(!console.GetComponentsInChildren<TextMeshPro>().Any(text => text.text.Contains("Correcting this item")), "Old correction-specific wording survived.");
                console.Render(view);
                Require(console.SelectedItemId == "synthetic-b", "Unchanged reference overwrote reader navigation.");
                // Listening closed the reader; reopened, its pinch shows the other item.
                console.Activate(ConsoleAction.Review); console.NextPage();
                Require(console.SelectedItemId == "synthetic-a", "Reader navigation fixture failed.");
                var changed = View("synthetic-b"); console.Render(changed);
                Require(console.SelectedItemId == "synthetic-b", "Explicit changed referent left reader on the old item.");
                Require(ContextReview.WorldItems(changed)[0].Id == "synthetic-b", "Changed referent failed room-label priority.");
                Require(changed.Items.All(item => item.Status == "proposed" && item.Confidence == .4f), "Selecting a referent changed verification or confidence.");
                console.NextPage(); console.Render(View("synthetic-b"));
                Require(console.SelectedItemId == "synthetic-a", "Repeated same referent overwrote independent reader focus.");
                // Through the app's own pinch handling: a tap on the reader's card pages it and records nothing; a pinch held past
                // the hold threshold leaves the card on its item and starts the turn aimed at it (the editor's unready camera stops
                // it before any microphone).
                var strip = DialogueStrip.Create(root.transform, eyes);
                Set(app, "head", eyes); Set(app, "console", console); Set(app, "dialogue", strip);
                if (!console.ReaderOpen) console.Activate(ConsoleAction.Review);
                console.RefreshVisuals(1f); Physics.SyncTransforms();
                eyes.rotation = Quaternion.LookRotation(hit.transform.TransformPoint(hit.center) - eyes.position);
                var hand = new HandInput(true, null, null);
                var shown = console.SelectedItemId;
                Handle(app, PinchEvent.Began, hand);
                Require(console.SelectedItemId == shown && Get(app, "pendingEvidence") == null, "A pinch on the reader's card paged it, or started a turn, before it was a tap or a hold.");
                Handle(app, PinchEvent.Tapped, hand);
                Require(console.SelectedItemId != shown && console.ReaderOpen && Get(app, "active") == null && Get(app, "pendingEvidence") == null
                    && !((Voice)Get(app, "voice")!).Recording, "A tap on the reader's card does not page it, or it recorded.");
                // Let go after a slow frame spans the hold threshold, the pinch comes back released, never held: it pages too.
                shown = console.SelectedItemId;
                Handle(app, PinchEvent.Began, hand); Handle(app, PinchEvent.Released, hand);
                Require(console.SelectedItemId != shown && console.ReaderOpen && Get(app, "active") == null && Get(app, "pendingEvidence") == null
                    && !((Voice)Get(app, "voice")!).Recording, "A pinch on the reader's card released without a hold does not page it, or it recorded.");
                shown = console.SelectedItemId;
                Handle(app, PinchEvent.Began, hand); Handle(app, PinchEvent.Holding, hand);
                Require(console.SelectedItemId == shown && strip.Stage == DialogueStage.Error && strip.FullText.Contains("Camera not ready")
                    && !((Voice)Get(app, "voice")!).Recording, "A held pinch on the reader's card does not start the turn aimed at its item: " + strip.FullText);
                // A pinch held to talk sends where the person looks, never where the talking hand points: that hand is raised to
                // pinch, so its ray lands near the frame's top row, and a pointer would outweigh the gaze.
                Set(room, "synthetic", new Snapshot(new byte[] { 255, 216, 255, 217 }, 80, 80, new DateTime(1970, 1, 1, 12, 0, 0, DateTimeKind.Utc),
                    new Pose(eyes.position, eyes.rotation), new DepthGrid { Columns = 1, Rows = 1, Meters = new float?[] { 2f } },
                    new CameraInfo { FocalLength = new float[] { 40, 40 }, PrincipalPoint = new float[] { 40, 40 }, SensorResolution = new[] { 80, 80 } }));
                typeof(Reticle).GetProperty("Point")!.SetValue(Get(app, "gaze"), eyes.position + eyes.forward * 2f);
                var raised = new HandInput(true, null, null);
                typeof(HandInput).GetProperty("RayActive")!.SetValue(raised, true);
                typeof(HandInput).GetProperty("Ray")!.SetValue(raised, new Ray(eyes.position + Vector3.down * .3f, (eyes.forward + Vector3.up * .45f).normalized));
                Set(app, "active", raised); Capture(app, null); Set(app, "active", null);
                var cues = (Cues)Get(app, "pendingCues")!;
                Require(Get(app, "pending") != null && cues.Gaze != null, "The synthetic frame did not give the turn its gaze cue.");
                Require(cues.Pointer == null, "A pinch held to talk sent the talking hand's pointer with the gaze.");
                Set(room, "synthetic", null);
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
        // Capture as a pinch held to talk calls it, with the turn's target.
        private static void Capture(BoopyApp app, string? target) =>
            typeof(BoopyApp).GetMethod("Capture", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(app, new object?[] { target });
        private static void Handle(BoopyApp app, PinchEvent pinch, HandInput hand) =>
            typeof(BoopyApp).GetMethod("Handle", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(app, new object[] { pinch, hand });
        private static void Set(object target, string name, object? value) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(target, value);
        private static object? Get(object target, string name) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(target);
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
