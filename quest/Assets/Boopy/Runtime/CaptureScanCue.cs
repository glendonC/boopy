#nullable enable
using System;
using Boopy.Client;
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>One actual captured-view acknowledgment. Camera-frustum UI, never object geometry or inferred progress.</summary>
    public sealed class CaptureScanCue : MonoBehaviour
    {
        private readonly LineRenderer[] ink = new LineRenderer[5];
        private readonly LineRenderer[] porcelain = new LineRenderer[5];
        private Snapshot? source;
        private float age;
        private bool reduced;
        public bool Visible { get; private set; }
        private const float Lifetime = .8f;

        public static CaptureScanCue Create(Transform parent)
        {
            var go=new GameObject("Actual captured-view acknowledgment");go.transform.SetParent(parent,false);
            var cue=go.AddComponent<CaptureScanCue>();
            for(var index=0;index<5;index++)
            {
                cue.ink[index]=cue.Stroke("Dark contrast stroke "+index,.0045f,4);
                cue.porcelain[index]=cue.Stroke("Porcelain capture stroke "+index,.0015f,5);
            }
            cue.Hide();return cue;
        }
        private LineRenderer Stroke(string name,float width,int order)
        {
            var host=new GameObject(name);host.transform.SetParent(transform,false);
            var line=Visuals.Line(host,width,false,Visuals.Solid);line.sortingOrder=order;return line;
        }
        public bool Begin(Snapshot snapshot,bool reducedMotion)
        {
            Hide();
            if(!isActiveAndEnabled || !snapshot.SourceTime.HasValue || !CameraFrameTime.IsFresh(snapshot.SourceTime.Value,Time.unscaledTime)
                || !Finite(snapshot.Pose.position) || !Finite(snapshot.Pose.rotation))return false;
            if(!SurfaceGeometry.CameraRay(new System.Numerics.Vector2(.04f,.04f),snapshot.Width,snapshot.Height,snapshot.Camera,out _))return false;
            source=snapshot;reduced=reducedMotion;age=0f;Visible=true;
            Draw();return true;
        }
        public void Refresh(float delta,bool permitted)
        {
            if(!permitted){Hide();return;}
            if(!Visible)return;
            if(float.IsNaN(delta) || float.IsInfinity(delta) || delta<0f){Hide();return;}
            age+=delta;
            if(age>=Lifetime || source==null || !source.SourceTime.HasValue
                || !CameraFrameTime.IsFresh(source.SourceTime.Value,Time.unscaledTime)){Hide();return;}
            Draw();
        }
        public void Hide()
        {
            Visible=false;source=null;
            foreach(var line in ink)if(line!=null)line.enabled=false;
            foreach(var line in porcelain)if(line!=null)line.enabled=false;
        }
        private void Draw()
        {
            if(source==null)return;
            var starts=new[]{new Vector2(.04f,.04f),new Vector2(.96f,.04f),new Vector2(.04f,.96f),new Vector2(.96f,.96f)};
            var alpha=reduced?1f:Mathf.Clamp01((Lifetime-age)/.16f);
            for(var index=0;index<4;index++)
            {
                var at=starts[index];var inward=new Vector2(at.x<.5f?1f:-1f,at.y<.5f?1f:-1f);
                Stroke(index,new[]{Project(at+new Vector2(inward.x*.075f,0)),Project(at),Project(at+new Vector2(0,inward.y*.075f))},alpha);
            }
            // A single finite acquisition sweep. It does not report OCR/model completion.
            var sweep=!reduced && age<.64f;
            ink[4].enabled=porcelain[4].enabled=sweep;
            if(sweep)
            {
                var y=Mathf.Lerp(.07f,.93f,Mathf.Clamp01(age/.64f));
                Stroke(4,new[]{Project(new Vector2(.08f,y)),Project(new Vector2(.92f,y))},alpha*.65f);
            }
        }
        private Vector3 Project(Vector2 image)
        {
            var capture=source!;
            SurfaceGeometry.CameraRay(new System.Numerics.Vector2(image.x,image.y),capture.Width,capture.Height,capture.Camera,out var ray);
            // One-metre optical plane is UI placement only; no measured scene depth is asserted.
            var local=new Vector3(ray.X,ray.Y,ray.Z)/ray.Z;
            return capture.Pose.position+capture.Pose.rotation*local;
        }
        private void Stroke(int index,Vector3[] points,float alpha)
        {
            var capture=source!;var behind=capture.Pose.rotation*Vector3.forward*.001f;
            var dark=new Vector3[points.Length];for(var n=0;n<points.Length;n++)dark[n]=points[n]+behind;
            ink[index].positionCount=dark.Length;ink[index].SetPositions(dark);ink[index].enabled=true;
            porcelain[index].positionCount=points.Length;porcelain[index].SetPositions(points);porcelain[index].enabled=true;
            Visuals.Tint(ink[index],new Color(.065f,.075f,.095f,.82f*alpha));
            Visuals.Tint(porcelain[index],new Color(.95f,.96f,.985f,.90f*alpha));
        }
        private static bool Finite(Vector3 value)=>float.IsFinite(value.x)&&float.IsFinite(value.y)&&float.IsFinite(value.z);
        private static bool Finite(Quaternion value)=>float.IsFinite(value.x)&&float.IsFinite(value.y)&&float.IsFinite(value.z)&&float.IsFinite(value.w)
            && Mathf.Abs(value.x*value.x+value.y*value.y+value.z*value.z+value.w*value.w-1f)<.01f;
        private void OnDisable()=>Hide();
    }
}
