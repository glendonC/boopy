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
    public static class EvidenceChoiceValidation
    {
        public static void Validate()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            ScriptCoverage.Install();
            var root = new GameObject("Synthetic response evidence choice");
            try
            {
                var eyes = new GameObject("Synthetic eyes").transform; eyes.SetParent(root.transform, false);
                var console = ContextConsole.Create(root.transform, eyes); console.Place(new Vector3(0, 0, 1));
                Require(!Visible(console, ConsoleAction.UseCurrentView), "Idle UI invented a source question.");
                var view = Response("synthetic-turn", "fresh-view", "current-surroundings");
                console.Render(view); console.RefreshVisuals(1f); Offered(console);
                {
                    var control = console.GetComponentsInChildren<SpatialAction>(true).Single(value => value.Action == ConsoleAction.UseSpokenOnly);
                    Require(control.transform.parent.name == "Control bar" && control.GetComponent<BoxCollider>().size.x <= SpatialTheme.ShelfSlot + .000001f, "The photo switch is not a tile of the row.");
                    var ray = new Ray(eyes.position, control.transform.position - eyes.position);
                    Require(console.HitAction(ray, out _) == ConsoleAction.UseSpokenOnly && console.CanRelease(ConsoleAction.UseSpokenOnly, ray), "Choice hit target missing or overlaps.");
                }
                Render(console, eyes);
                console.SetBusy(true); Require(!Visible(console, ConsoleAction.UseSpokenOnly), "Busy operation exposes choice.");
                console.Activate(ConsoleAction.UseSpokenOnly); Require(!console.InputPolicy.SpokenOnly, "Busy changed source.");
                console.SetBusy(false); console.InputPolicy.SetInteractionState(false, false);
                console.Activate(ConsoleAction.UseSpokenOnly); Require(!console.InputPolicy.SpokenOnly, "Lost focus changed source.");
                console.InputPolicy.SetInteractionState(true, false); console.SetCaptureRecovery(true);
                Require(!Visible(console, ConsoleAction.UseCurrentView), "Manual recovery competes with choice.");
                console.Activate(ConsoleAction.UseSpokenOnly); Require(!console.InputPolicy.SpokenOnly, "Manual recovery changed source.");
                console.SetCaptureRecovery(false); console.Render(view);
                console.ShowListening(); Require(!Visible(console, ConsoleAction.UseSpokenOnly), "Recording shows choice.");
                console.Activate(ConsoleAction.UseSpokenOnly); Require(!console.InputPolicy.SpokenOnly, "Hidden listening choice changed source without pending turn.");
                console.Render(view); console.ShowProcessing(); Require(!Visible(console, ConsoleAction.UseSpokenOnly), "Processing shows choice.");
                console.Activate(ConsoleAction.UseSpokenOnly); Require(!console.InputPolicy.SpokenOnly, "Hidden processing choice changed source.");
                console.ShowCapture(); Require(!Visible(console, ConsoleAction.UseSpokenOnly), "Idle capture resurrected a prior response choice.");
                console.Activate(ConsoleAction.UseSpokenOnly); Require(!console.InputPolicy.SpokenOnly, "Idle capture allowed stale source action.");
                console.Render(view); console.Activate(ConsoleAction.UseCurrentView);
                // The switch stays, reading the other choice, until the ask ends; More returns then.
                Require(!console.InputPolicy.SpokenOnly && Visible(console, ConsoleAction.UseSpokenOnly) && !Visible(console, ConsoleAction.UseCurrentView), "Idempotent current-view choice changed the switch.");
                Require(!Visible(console, ConsoleAction.More), "More returned before the ask ended.");
                console.Render(view); Require(Visible(console, ConsoleAction.UseSpokenOnly), "The same response dropped the photo switch before the ask ended.");
                var header = console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Intent instrument");
                Require(header.BodyText.Contains("Look toward the subject, then Talk."), "No next-turn instruction after current choice.");
                console.Render(Response("synthetic-next", "clarify", "unknown")); Offered(console);
                console.Activate(ConsoleAction.UseSpokenOnly);
                Require(console.InputPolicy.SpokenOnly && !Visible(console, ConsoleAction.UseSpokenOnly) && Visible(console, ConsoleAction.UseCurrentView), "Spoken choice did not switch the tile to Photo.");
                Require(header.BodyText.Contains("photo sharing off"), "Spoken next turn instruction falsely claims capture.");
                // The ask ends with a later turn: More returns, and the Context sheet offers to prepare the context.
                var later = Response("synthetic-later", "reuse", "current-surroundings"); console.Render(later);
                Require(Visible(console, ConsoleAction.More) && !Visible(console, ConsoleAction.UseCurrentView), "More did not return when the ask ended.");
                console.Activate(ConsoleAction.Options);
                Require(Visible(console, ConsoleAction.PrepareSave), "Explicit actions lost save access.");
                console.Activate(ConsoleAction.Options);
                foreach (var source in new[] { "past-recollection", "virtual-scene", "displayed-image" })
                { console.Render(Response("synthetic-" + source, "clarify", source)); Require(!Visible(console, ConsoleAction.UseCurrentView), "Other source got a physical-view offer."); }
                var stale = Response("synthetic-old", "clarify", "unknown"); stale.Utterances.Add(new UtteranceRef { Id = "synthetic-newer" });
                console.Render(stale); Require(!Visible(console, ConsoleAction.UseCurrentView), "Stale attention offered source choice.");
                console.Render(Response("", "clarify", "unknown")); Require(!Visible(console, ConsoleAction.UseCurrentView), "Empty identity offered choice.");
                var saved = Response("synthetic-saved", "fresh-view", "current-surroundings"); saved.State = "committed"; saved.Committed = new Committed { PackageId = "synthetic-package" };
                console.Render(saved); Require(Visible(console, ConsoleAction.More) && !Visible(console, ConsoleAction.UseCurrentView), "Saved receipt changed into choice.");
                console.Activate(ConsoleAction.Options); Require(Visible(console, ConsoleAction.Handoff), "Saved context lost deliberate handoff access.");
                var failed = new SessionView { Id = "synthetic-failure", Notice = "Synthetic failed capture." };
                console.Render(failed); Require(Visible(console, ConsoleAction.More) && !Visible(console, ConsoleAction.UseCurrentView), "Generic failed capture invented evidence choice.");
                ValidateCameraGuard(false); ValidateCameraGuard(true);
                Debug.Log("Boopy response-local evidence choice validation passed (synthetic; no wearer/device result).");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }
        private static SessionView Response(string id, string action, string source)
        {
            var view = new SessionView { Id = "synthetic-session", State = "review", Model = new ModelRef { Provider = "fixture", Id = "synthetic" }, Attention = new AttentionView { UtteranceId = id, Action = action, Source = source }, Notice = "Please select evidence for the next turn." };
            view.Utterances.Add(new UtteranceRef { Id = id, Text = "Synthetic request." });
            view.Items.Add(new Item { Id = "synthetic-item", Kind = "object", Label = "Synthetic", Statement = "Synthetic proposal." }); return view;
        }
        private static void ValidateCameraGuard(bool ongoing)
        {
            var root = new GameObject("Synthetic unavailable camera");
            try
            {
                var eyes = new GameObject("Synthetic eyes").transform; eyes.SetParent(root.transform, false);
                var console = ContextConsole.Create(root.transform, eyes); var strip = DialogueStrip.Create(root.transform, eyes);
                var app = root.AddComponent<BoopyApp>();
                Set(app, "console", console); Set(app, "dialogue", strip); Set(app, "room", root.AddComponent<RoomCamera>());
                SessionView? prior = ongoing ? Response("synthetic-prior", "reuse", "current-surroundings") : null;
                Set(app, "session", prior);
                typeof(BoopyApp).GetMethod("BeginTalk", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(app, new object?[] { null });
                Require(((Voice)Get(app, "voice")!).Recording == false, "Unavailable camera started microphone recording.");
                Require(console.InputPolicy.Pending == null && Get(app, "pendingEvidence") == null && Get(app, "active") == null, "Unavailable camera entered a pending recording.");
                Require(ReferenceEquals(Get(app, "session"), prior), "Unavailable camera discarded prior context.");
                Require(strip.Stage == DialogueStage.Error && strip.FullText.Contains("Camera not ready"), "Unavailable camera failed without truthful caption.");
            } finally { UnityEngine.Object.DestroyImmediate(root); }
        }
        private static void Render(ContextConsole console, Transform eyes)
        {
            var camera = eyes.gameObject.AddComponent<Camera>(); camera.fieldOfView = 58; camera.nearClipPlane = .05f;
            camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = new Color(.15f, .17f, .19f); camera.allowHDR = false; camera.allowMSAA = false;
            foreach (var text in console.GetComponentsInChildren<TextMeshPro>()) text.ForceMeshUpdate(true, true);
            var target = new RenderTexture(1000, 1000, 24); target.Create(); var image = new Texture2D(1000, 1000, TextureFormat.RGB24, false); var previous = RenderTexture.active;
            try { camera.targetTexture = target; camera.Render(); RenderTexture.active = target; image.ReadPixels(new Rect(0, 0, 1000, 1000), 0, 0); image.Apply(); File.WriteAllBytes(Path.Combine(Path.GetTempPath(), "boopy-evidence-choice.png"), image.EncodeToPNG()); }
            finally { camera.targetTexture = null; RenderTexture.active = previous; UnityEngine.Object.DestroyImmediate(target); UnityEngine.Object.DestroyImmediate(image); }
        }
        private static bool Visible(ContextConsole console, ConsoleAction action) => console.GetComponentsInChildren<SpatialAction>(true).Single(control => control.Action == action).gameObject.activeInHierarchy;
        private static void Offered(ContextConsole console) { Require(Visible(console, console.InputPolicy.SpokenOnly ? ConsoleAction.UseCurrentView : ConsoleAction.UseSpokenOnly), "Matching response has no evidence choice."); Require(!Visible(console, ConsoleAction.PrepareSave) && !Visible(console, ConsoleAction.More), "Foreground preparation/actions compete with source choice."); }
        private static void Set(object target, string name, object? value) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(target, value);
        private static object? Get(object target, string name) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(target);
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
