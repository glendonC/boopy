#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Boopy.Client;
using UnityEditor.SceneManagement;
using UnityEngine;
using N = System.Numerics;

namespace Boopy.Quest.Editor
{
    public static class ConsoleFootprintValidation
    {
        private const BindingFlags Flags = BindingFlags.NonPublic | BindingFlags.Instance;
        public static void Validate()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single); ScriptCoverage.Install();
            foreach(var pitch in new[] {-42f,42f}) foreach(var reader in new[] {false,true}) Check(pitch,reader);
            Debug.Log("Boopy console footprint validation passed: pitched actual corners, expanded actions/reader, large comfort, disjoint chip placements (synthetic).");
        }
        private static void Check(float pitch,bool reader)
        {
            var root=new GameObject("Synthetic console footprint");
            try
            {
                var head=new GameObject("Synthetic eyes").transform; head.SetParent(root.transform); head.rotation=Quaternion.Euler(pitch,32f,0);
                var room=root.AddComponent<RoomCamera>(); var scene=SessionScene.Create(root.transform,room,head);
                var console=ContextConsole.Create(root.transform,head); console.SetReducedMotion(true); scene.SetReducedMotion(true); scene.PlaceConsole(console);
                var view=new SessionView {Id="synthetic-footprint",State="review",ReferentId="synthetic-item",Model=new ModelRef {Provider="fixture",Id="synthetic"}};
                view.Items.Add(new Item {Id="synthetic-item",Kind="object",Label="Synthetic source",Statement="A source-backed proposed object.",Origin="model",Status="proposed",Confidence=.4f,Grounding=new Grounding {Kind="box",ObservationId="synthetic-observation",Box=new Box2 {X0=.1f,Y0=.45f,X1=.2f,Y1=.55f}}});
                scene.Remember("synthetic-observation",new Snapshot(new byte[] {255,216,255,217},128,96,DateTime.UtcNow,new Pose(head.position,head.rotation),new DepthGrid {Columns=1,Rows=1,Meters=new float?[] {1f}},new CameraInfo {FocalLength=new[] {100f,100f},PrincipalPoint=new[] {64f,48f},SensorResolution=new[] {128,96}}));
                console.Render(view); console.Activate(ConsoleAction.Options);
                if(reader) console.Activate(ConsoleAction.Review);
                if(console.ComfortScale < 1.1f) console.Activate(ConsoleAction.Size);
                console.RefreshVisuals(1f); scene.Render(view);
                Require(scene.ConsolePlaced,"Expanded pitched console could not be reserved in the synthetic clear area.");
                var occupied=new List<LabelRect>();
                var reserve=typeof(SessionScene).GetMethod("ReserveConsole",Flags)!;
                Require((bool)reserve.Invoke(scene,new object[] {occupied})! && occupied.Count==1,"Console reservation lacks a single envelope.");
                var actual=Corners(scene,console.transform.position+console.transform.up*console.LayoutCenterOffset,console.transform.right,console.transform.up,console.LayoutSize);
                var envelope=occupied[0];
                Require((bool)typeof(SessionScene).GetMethod("FollowFootprintClear",Flags)!.Invoke(scene,new object[] {console,console.transform.position})!,"Actual reserved pose disagrees with following keepout safety.");
                Require(actual.All(p=>p.X>=envelope.MinX-.0001f && p.X<=envelope.MaxX+.0001f && p.Y>=envelope.MinY-.0001f && p.Y<=envelope.MaxY+.0001f),"Reserved envelope does not contain all four actually oriented console corners.");
                scene.Render(view);
                actual=Corners(scene,console.transform.position+console.transform.up*console.LayoutCenterOffset,console.transform.right,console.transform.up,console.LayoutSize);
                var consoleBounds=LabelRect.Envelope(actual);
                var chips=scene.GetComponentsInChildren<Chip>(true).Where(chip=>chip.gameObject.activeInHierarchy && chip.Placed).ToArray();
                Require(chips.Length>0,"Fixture did not exercise a later chip placement.");
                foreach(var chip in chips)
                {
                    chip.Face(head);
                    var size=chip.LayoutSize*chip.transform.lossyScale.x;
                    var chipBounds=LabelRect.Envelope(Corners(scene,chip.transform.position,chip.transform.right,chip.transform.up,size));
                    Require(!consoleBounds.Intersects(chipBounds,0),"Later chip overlaps the actual pitched console footprint.");
                }
                Require(view.Items[0].Status=="proposed" && view.Items[0].Grounding.ObservationId=="synthetic-observation","Layout changed source or verification.");
            }
            finally {UnityEngine.Object.DestroyImmediate(root);}
        }
        private static N.Vector2[] Corners(SessionScene scene,Vector3 center,Vector3 right,Vector3 up,Vector2 dimensions)
        {
            var result=new List<N.Vector2>(); var project=typeof(SessionScene).GetMethod("Project",Flags)!;
            foreach(var x in new[] {-1f,1f}) foreach(var y in new[] {-1f,1f})
            {
                var args=new object[] {center+right*(dimensions.x*.5f*x)+up*(dimensions.y*.5f*y),default(N.Vector2)};
                Require((bool)project.Invoke(scene,args)!,"Actual footprint corner is behind the layout frame."); result.Add((N.Vector2)args[1]);
            }
            return result.ToArray();
        }
        private static void Require(bool value,string message) {if(!value)throw new InvalidOperationException(message);}
    }
}
