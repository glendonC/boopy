#nullable enable
using System;
using System.Linq;
using Boopy.Quest;
using TMPro;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>Synthetic visual-contract checks; no headset comfort or design acceptance claim.</summary>
    public static class VisualPrimitiveValidation
    {
        public static void Validate()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);
            var root=new GameObject("Synthetic neutral primitive contract");
            try
            {
                var action=SpatialAction.Create(root.transform,ConsoleAction.Talk,"Talk",.18f);
                var box=action.GetComponent<BoxCollider>();var originalSize=box.size;var originalCenter=box.center;
                var plate=action.GetComponentsInChildren<MeshFilter>().Single(filter=>filter.name=="Action surface");
                Require(plate.sharedMesh.vertexCount>20,"Action face is still a rectangular quad.");
                Require(plate.sharedMesh.vertices.All(v=>Mathf.Abs(v.x)<=.5001f && Mathf.Abs(v.y)<=.5001f),"Rounded face escapes its target.");
                Require(!action.GetComponentsInChildren<LineRenderer>().Single(line=>line.name=="Action boundary").enabled,"Colored perimeter cage remains visible.");
                var property=new MaterialPropertyBlock();plate.GetComponent<MeshRenderer>().GetPropertyBlock(property);
                var resting=property.GetColor("_Color");Require(resting.a>.9f && Mathf.Abs(resting.r-SpatialTheme.Porcelain.r)<.001f && Mathf.Abs(resting.g-SpatialTheme.Porcelain.g)<.001f,"Primary action lacks its neutral porcelain fill.");
                action.Focus(true);action.Press(true);action.Refresh(.2f,1f,false);
                Require(box.size==originalSize && box.center==originalCenter,"Hover/press moves hit geometry.");
                Require(action.AccessibleLabel=="Talk","Primitive changed exact action wording.");
                action.Refresh(.1f,.5f,false);
                Require(action.transform.Find("Press visual").localPosition.y<0,"Action well does not join the surface entrance.");
                action.Refresh(.1f,.5f,true);
                Require(action.transform.Find("Press visual").localPosition.y==0,"Reduced action reveal retains positional motion.");
                action.Refresh(1f,.2f,false);Require(!box.enabled,"Faded action retains an invisible hit target.");
                var surface=SpatialSurface.Create(root.transform,"Synthetic rounded surface");surface.Configure("State","","Exact synthetic copy",bottomSpace:.08f);
                surface.Assemble(0,false);surface.Refresh(.16f);
                Require(surface.Opacity>.45f && surface.Opacity<.55f,"Full-motion reveal is not coordinated over 320ms.");
                var visual=surface.transform.Find("Instrument visual");Require(visual.localPosition.y<0,"Full-motion reveal has no restrained settle.");
                surface.Refresh(.16f);Require(surface.Opacity>=.999f && Mathf.Abs(visual.localPosition.y)<.0001f,"Reveal does not finish at the measured pose.");
                surface.Assemble(0,true);surface.Refresh(.06f);
                Require(surface.Opacity>.45f && surface.Opacity<.55f && visual.localPosition==Vector3.zero,"Reduced motion is not opacity-only.");
                surface.Refresh(.06f);Require(surface.BodyText=="Exact synthetic copy","Reveal changed exact text.");
                Debug.Log("Boopy neutral primitive validation passed: rounded filled faces, fixed hits, 320ms reveal and reduced opacity-only.");
            }
            finally {UnityEngine.Object.DestroyImmediate(root);}
        }
        private static void Require(bool condition,string message){if(!condition)throw new InvalidOperationException(message);}
    }
}
