#nullable enable
using System;
using System.IO;
using System.Linq;
using TMPro;
using UnityEditor.SceneManagement;
using UnityEngine;
namespace Boopy.Quest.Editor
{
    /// <summary>Actual native controls under synthetic light/dark fields; no wearer or vendor-material equivalence claim.</summary>
    public static class NeutralMaterialValidation
    {
        public static void ValidateAndRender()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);HangulFont.Install();
            foreach(var reduced in new[]{false,true})foreach(var large in new[]{false,true})foreach(var bright in new[]{false,true})
            {
                var root=new GameObject("Synthetic neutral material state matrix");
                var target=new RenderTexture(1600,1000,24);target.Create();var pixels=new Texture2D(1600,1000,TextureFormat.RGB24,false);var old=RenderTexture.active;
                try
                {
                    var camera=root.AddComponent<Camera>();camera.fieldOfView=64;camera.aspect=1.6f;camera.nearClipPlane=.05f;camera.clearFlags=CameraClearFlags.SolidColor;camera.backgroundColor=bright?new Color(.87f,.84f,.77f):new Color(.045f,.045f,.045f);camera.targetTexture=target;
                    var layout=new GameObject("Native state matrix").transform;layout.SetParent(root.transform,false);layout.localPosition=new Vector3(0,.10f,1.6f);layout.localScale=Vector3.one*(large?1.2f:1f);
                    var states=new[]{"Rest","Hover","Pressed","Selected","Selected + hover","Disabled"};
                    for(var index=0;index<states.Length;index++)
                    {
                        var state=states[index];var rowY=.22f-index*.095f;
                        var title=SpatialTheme.Text(layout,state,SpatialTheme.Utility,bright?SpatialTheme.Panel:SpatialTheme.TextColor);title.text=state;title.rectTransform.sizeDelta=new Vector2(.30f,.05f);title.transform.localPosition=new Vector3(-.48f,rowY,0);
                        foreach(var primary in new[]{false,true})
                        {
                            var words=primary?"Talk":state.StartsWith("Selected")?"Selected · A visible option":"A visible option";
                            var action=SpatialAction.Create(layout,primary?ConsoleAction.Talk:ConsoleAction.FollowUpOne,words,primary ? .14f : .36f);action.transform.localPosition=new Vector3(primary ? .46f : .12f,rowY,0);
                            var box=action.GetComponent<BoxCollider>();var size=box.size;var center=box.center;var position=action.transform.localPosition;
                            var selected=state.StartsWith("Selected");action.SetSelected(selected);
                            action.Focus(state.Contains("Hover")||state.Contains("hover")||state=="Pressed");action.Press(state=="Pressed");action.Refresh(.3f,1f,reduced);
                            var plate=action.GetComponentsInChildren<MeshRenderer>().Single(r=>r.name=="Action surface");var block=new MaterialPropertyBlock();plate.GetPropertyBlock(block);var color=block.GetColor("_Color");
                            Require(Spread(color)<.035f,"Native control retains chromatic accent.");
                            Require(action.GetComponentsInChildren<Transform>(true).All(t=>!t.name.Contains("underline",StringComparison.OrdinalIgnoreCase)),"Underline geometry remains.");
                            Require(action.GetComponentsInChildren<TextMeshPro>().All(t=>(t.fontStyle&FontStyles.Underline)==0),"Text supplies a hidden underline.");
                            Require(box.size==size&&box.center==center&&action.transform.localPosition==position,"State changes the fixed hit target.");
                            var boundary=action.GetComponentsInChildren<LineRenderer>(true).Single(r=>r.name=="Action boundary");Require(boundary.enabled==selected,"Transient hover/press resembles persistent selection.");
                            Require(boundary.positionCount>16,"Selected boundary is still four square segments.");
                            if(!primary && state=="Rest")Require(Near(color,SpatialTheme.Control),"Secondary rest lost approved control token.");
                            // One tile style: Talk rests on the control token like every tile (ControlGrammarValidation.OneStyle checks the row).
                            if(primary && state=="Rest")Require(Near(color,SpatialTheme.Control),"Talk at rest leaves the one tile style's control token.");
                            if(!primary && state=="Hover")Require(Near(color,SpatialTheme.Emphasis),"Hover does not affect the whole control face.");
                            if(state=="Pressed")Require(block.GetFloat("_Press")>.99f,"Pressed state lost explicit material feedback.");
                            if(reduced)Require(action.transform.Find("Press visual").localPosition==Vector3.zero,"Reduced state retains material displacement.");
                            if(state=="Disabled")
                            {
                                action.SetInteractable(false);action.Focus(true);action.Press(true);action.Refresh(.3f,1f,reduced);plate.GetPropertyBlock(block);
                                Require(!box.enabled&&block.GetFloat("_Press")==0,"Disabled control responds to input.");
                                var disabled=block.GetColor("_Color");action.Focus(false);action.Press(false);action.Refresh(.3f,1f,reduced);plate.GetPropertyBlock(block);Require(block.GetColor("_Color")==disabled,"Disabled control retains hover feedback.");
                            }
                            foreach(var text in action.GetComponentsInChildren<TextMeshPro>()){text.ForceMeshUpdate(true,true);Require(!text.isTextOverflowing,"State label clips.");}
                        }
                    }
                    var disclosure=SpatialTheme.Text(root.transform,"Synthetic disclosure",SpatialTheme.Utility,bright?SpatialTheme.Panel:SpatialTheme.TextColor);disclosure.text="SYNTHETIC · NATIVE CONTROL STATES · "+(bright?"BRIGHT FIELD":"DARK FIELD");disclosure.rectTransform.sizeDelta=new Vector2(1.3f,.06f);disclosure.transform.position=new Vector3(-.45f,-.55f,1.6f);
                    camera.Render();RenderTexture.active=target;pixels.ReadPixels(new Rect(0,0,1600,1000),0,0);pixels.Apply();var path=Path.Combine(Path.GetTempPath(),"boopy-neutral-states-"+(bright?"bright":"dark")+"-"+(large?"large":"standard")+(reduced?"-reduced":"")+".png");File.WriteAllBytes(path,pixels.EncodeToPNG());Debug.Log("Synthetic neutral state render: "+path);
                }
                finally{RenderTexture.active=old;UnityEngine.Object.DestroyImmediate(root);UnityEngine.Object.DestroyImmediate(pixels);UnityEngine.Object.DestroyImmediate(target);}
            }
            VisualPrimitiveValidation.Validate();ActionIconValidation.Validate();CharacterValidation.Validate();
            Debug.Log("Boopy neutral state/material validation passed: no underline, fixed targets, selected versus hover, disabled/reduced, neutral companion; synthetic backgrounds only.");
        }
        private static float Spread(Color c)=>Mathf.Max(c.r,Mathf.Max(c.g,c.b))-Mathf.Min(c.r,Mathf.Min(c.g,c.b));
        private static bool Near(Color a,Color b)=>Mathf.Abs(a.r-b.r)<.002f&&Mathf.Abs(a.g-b.g)<.002f&&Mathf.Abs(a.b-b.b)<.002f;
        private static void Require(bool value,string message){if(!value)throw new InvalidOperationException(message);}
    }
}
