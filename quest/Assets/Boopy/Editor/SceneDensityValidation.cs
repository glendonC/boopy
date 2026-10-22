#nullable enable
using System;
using System.Collections;
using System.Linq;
using System.Reflection;
using Boopy.Client;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    public static class SceneDensityValidation
    {
        public static void Validate()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            HangulFont.Install();
            var root = new GameObject("Synthetic scene density");
            try
            {
                var eyes = new GameObject("Synthetic eyes").transform; eyes.SetParent(root.transform, false);
                var scene = SessionScene.Create(root.transform, root.AddComponent<RoomCamera>(), eyes);
                scene.Remember("synthetic-frame", new Snapshot(new byte[] { 1, 2 }, 80, 80, new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc), new Pose(Vector3.zero, Quaternion.identity), new DepthGrid { Columns = 1, Rows = 1, Meters = new float?[] { 2f } }, new CameraInfo { FocalLength = new float[] { 40, 40 }, PrincipalPoint = new float[] { 40, 40 }, SensorResolution = new int[] { 80, 80 } }));
                var view = View(null); scene.Render(view);
                Counts(scene, 0, null);
                Require(((IList)Get(scene, "protectedWorld")!).Count >= 4, "Unlabelled source objects lost keepouts.");
                var console = ContextConsole.Create(root.transform, eyes); console.Render(view); console.Activate(ConsoleAction.Review);
                Require(view.Items.Count == 4 && console.SelectedItemId != null, "Quiet world removed explicit reader evidence.");
                scene.FocusItem("synthetic-b"); Counts(scene, 1, "synthetic-b");
                var chip = ((IDictionary)Get(scene, "chips")!)["synthetic-b"];
                var keepout = ((IList)Get(scene, "protectedWorld")!)[0];
                for (var i = 0; i < 100; i++) scene.FocusItem("synthetic-b");
                Require(ReferenceEquals(((IDictionary)Get(scene, "chips")!)["synthetic-b"], chip) && ReferenceEquals(((IList)Get(scene, "protectedWorld")!)[0], keepout), "Stable focus rebuilt annotation/keepouts.");
                scene.FocusItem(null); Counts(scene, 0, null);
                view = View("synthetic-a"); scene.Render(view); Counts(scene, 1, "synthetic-a");
                // Reader selection overrides the current referent locally without confirming it.
                scene.FocusItem("synthetic-c"); Counts(scene, 1, "synthetic-c");
                scene.Focus(null); Counts(scene, 1, "synthetic-a");
                scene.FocusItem("synthetic-c"); scene.Render(View("synthetic-b")); Counts(scene, 1, "synthetic-b");
                var absent = View("synthetic-d"); absent.Items[3].Grounding.ObservationId = "unavailable"; scene.Render(absent); Counts(scene, 0, null);
                scene.FocusItem("synthetic-d"); Counts(scene, 0, null);
                scene.FocusItem("synthetic-a"); Counts(scene, 1, "synthetic-a");
                Require(view.Items.All(item => item.Status == "proposed" && item.Confidence == .3f) && ((IDictionary)Get(scene, "snapshots")!).Count == 1, "Presentation changed certainty/evidence or discarded source pose.");
                scene.Clear(); Counts(scene, 0, null);
                Debug.Log("Boopy scene density validation passed (one explicit grounded annotation; synthetic, no wearer result).");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }
        private static SessionView View(string? referent)
        {
            var view = new SessionView { Id = "synthetic-session", State = "review", ReferentId = referent, Model = new ModelRef { Provider = "fixture", Id = "synthetic" } };
            for (var i = 0; i < 4; i++) view.Items.Add(new Item { Id = "synthetic-" + (char)('a' + i), Kind = "object", Label = "Synthetic object", Statement = "Synthetic proposal", Status = "proposed", Confidence = .3f, Grounding = new Grounding { Kind = "box", ObservationId = "synthetic-frame", Box = new Box2 { X0 = .08f + i * .2f, X1 = .18f + i * .2f, Y0 = .4f, Y1 = .5f } } });
            return view;
        }
        private static void Counts(SessionScene scene, int count, string? id)
        {
            var chips = (IDictionary)Get(scene, "chips")!; var outlines = (IDictionary)Get(scene, "overlays")!;
            Require(chips.Count == count && outlines.Count == count, "World annotation density exceeded explicit one/none policy.");
            if (id != null) Require(chips.Contains(id) && outlines.Contains(id), "Wrong source annotated.");
            Require(scene.GetComponentsInChildren<Chip>().Length <= 1 && scene.GetComponentsInChildren<GroundedOverlay>().Length <= 1, "Removed annotation stayed visible.");
        }
        private static object? Get(object target, string name) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(target);
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
