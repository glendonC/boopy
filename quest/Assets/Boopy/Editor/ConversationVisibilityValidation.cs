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
    /// <summary>Adversarial synthetic scene: evidence keepout must not erase the actual reply.</summary>
    public static class ConversationVisibilityValidation
    {
        public static void Validate()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single); ScriptCoverage.Install();
            var root = new GameObject("Synthetic broad-source conversation");
            try
            {
                var eyes = new GameObject("Synthetic eyes").transform; eyes.SetParent(root.transform);
                var room = root.AddComponent<RoomCamera>();
                var scene = SessionScene.Create(root.transform, room, eyes);
                var console = ContextConsole.Create(root.transform, eyes); console.SetReducedMotion(true); scene.PlaceConsole(console);
                var caption = DialogueStrip.Create(root.transform, eyes); console.DockDialogue(caption);
                var status = StatusLine.Create(root.transform, eyes, Visuals.Quad());
                var app = root.AddComponent<BoopyApp>();
                foreach (var field in new[] { ("scene",(object)scene),("console",(object)console),("dialogue",(object)caption),("status",(object)status) }) Set(app,field.Item1,field.Item2);
                var view = new SessionView {Id="synthetic-broad",State="review",ReferentId="synthetic-object",Model=new ModelRef {Provider="fixture",Id="synthetic"},Dialogue=new DialogueView {Speaker="boopy",UtteranceId="synthetic-turn",At="1970-01-01T12:00:00Z",Text=string.Concat(Enumerable.Repeat("This recorded display may show a painting. 기록된 그림이에요. ",18))}};
                view.Utterances.Add(new UtteranceRef {Id="synthetic-turn",Text="What is this?",Kind="ask"});
                view.Items.Add(new Item {Id="synthetic-object",Kind="object",Label="Synthetic broad display",Statement="A proposed display.",Status="proposed",Origin="model",Confidence=.4f,Grounding=new Grounding {Kind="box",ObservationId="synthetic-source",Box=new Box2 {X0=0,Y0=0,X1=1,Y1=1}}});
                var reproduced = false;
                foreach (var focal in new[] { 64f,32f,16f })
                {
                    scene.Remember("synthetic-source",new Snapshot(new byte[] {255,216,255,217},128,96,DateTime.UtcNow,new Pose(Vector3.zero,Quaternion.identity),new DepthGrid {Columns=1,Rows=1,Meters=new float?[] {1f}},new CameraInfo {FocalLength=new[] {focal,focal},PrincipalPoint=new[] {64f,48f},SensorResolution=new[] {128,96}}));
                    typeof(BoopyApp).GetMethod("Apply",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(app,new object[] {view});
                    console.RefreshVisuals(1f);
                    Debug.Log("Boopy broad-source probe focal="+focal+" consolePlaced="+scene.ConsolePlaced+" captionVisible="+caption.gameObject.activeInHierarchy+" fallbackVisible="+status.gameObject.activeInHierarchy);
                    if(scene.ConsolePlaced) continue;
                    reproduced = true;
                    Require(console.HasVisibleBar && console.gameObject.activeInHierarchy, "Protected-source fallback hides the app controls.");
                    Require(console.GetComponentsInChildren<SpatialSurface>(true).Where(surface => surface.name == "Intent instrument" || surface.name == "Evidence instrument" || surface.name == "Save dock").All(surface => !surface.gameObject.activeInHierarchy), "Protected-source fallback leaves conversation content over the object.");
                    Physics.SyncTransforms();
                    var pause = console.GetComponentsInChildren<SpatialAction>(true).Single(action => action.Action == ConsoleAction.PauseScene);
                    var pauseRay = new Ray(eyes.position, pause.transform.position - eyes.position);
                    Require(console.HitAction(pauseRay, out _) == ConsoleAction.PauseScene && !caption.HitPage(pauseRay) && console.HitTarget(pauseRay, out _) == null, "Fallback caption steals the persistent scene control or targets hidden context.");
                    var replyVisible = caption.gameObject.activeInHierarchy || status.GetComponentsInChildren<TextMeshPro>().Any(text=>text.gameObject.activeInHierarchy && text.text==view.Dialogue.Text);
                    Require(replyVisible,"Recorded broad object keepout hides the actual reply; fallback only reports missing panel space.");
                    Require(caption.FullText == view.Dialogue.Text && caption.PageCount > 1, "Fallback discarded or silently truncated the actual returned reply.");
                    Require(caption.transform.parent != console.GetComponentsInChildren<SpatialSurface>(true).Single(surface=>surface.name=="Intent instrument").transform, "Hidden companion still owns the fallback hierarchy.");
                    Physics.SyncTransforms(); var ray = new Ray(eyes.position,caption.transform.position-eyes.position);
                    Require(caption.HitPage(ray) && console.HitAction(ray,out _) == ConsoleAction.None && console.HitTarget(ray,out _) == null, "Fallback paging confirms hidden context or cannot be reached.");
                    var exact = "";
                    for(var page=0;page<caption.PageCount;page++) { exact+=caption.VisibleText; caption.NextPage(); }
                    Require(exact==view.Dialogue.Text, "Fallback pages do not preserve exact response words.");
                    var source = view.Items[0].Grounding.ObservationId;
                    view.Items[0].Grounding.Box = new Box2 {X0=.49f,Y0=.49f,X1=.51f,Y1=.51f};
                    typeof(BoopyApp).GetMethod("Apply",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(app,new object[] {view});
                    console.RefreshVisuals(1f);
                    Require(scene.ConsolePlaced && caption.transform.parent == console.GetComponentsInChildren<SpatialSurface>(true).Single(surface=>surface.name=="Intent instrument").transform,
                        "Exact reply did not return to the companion when placement became valid.");
                    Require(caption.FullText==view.Dialogue.Text && view.Items[0].Grounding.ObservationId==source && view.Items[0].Status=="proposed", "Fallback recovery altered response, source or verification.");
                    break;
                }
                Require(reproduced,"Adversarial fixture did not exercise failed console placement.");
                Debug.Log("Boopy conversation visibility validation passed (synthetic broad source; no wearer result).");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }
        private static void Set(object target,string name,object value)=>target.GetType().GetField(name,BindingFlags.Instance|BindingFlags.NonPublic)!.SetValue(target,value);
        private static void Require(bool value,string message) {if(!value)throw new InvalidOperationException(message);}
    }
}
