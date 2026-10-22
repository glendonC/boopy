#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Boopy.Client;
using TMPro;
using UnityEditor.SceneManagement;
using UnityEngine;
namespace Boopy.Quest.Editor
{
    /// <summary>Bounded legacy informational questions share the exact answer surface; no choice/send semantics.</summary>
    public static class ConversationPanelValidation
    {
        public static void ValidateAllAndRender()
        {
            ChoiceCardValidation.ValidateAndRender();
            ValidateAndRender();
        }
        public static void ValidateAndRender()
        {
            ContextualFollowUpValidation.Validate();
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);HangulFont.Install();
            foreach(var large in new[]{false,true})foreach(var longAnswer in new[]{false,true})foreach(var reduced in new[]{false,true})
            {
                var root=new GameObject("Synthetic shared answer and follow-up panel");
                var target=new RenderTexture(1600,1000,24);target.Create();var pixels=new Texture2D(1600,1000,TextureFormat.RGB24,false);var old=RenderTexture.active;
                try
                {
                    var eyes=new GameObject("Eyes").transform;eyes.SetParent(root.transform,false);var camera=eyes.gameObject.AddComponent<Camera>();camera.fieldOfView=64;camera.aspect=1.6f;camera.nearClipPlane=.05f;camera.clearFlags=CameraClearFlags.SolidColor;camera.backgroundColor=new Color(.12f,.15f,.19f);camera.targetTexture=target;
                    var console=ContextConsole.Create(root.transform,eyes);console.Place(new Vector3(0,-.12f,1.35f));if(large)console.Activate(ConsoleAction.Size);console.SetReducedMotion(reduced);
                    var strip=DialogueStrip.Create(root.transform,eyes);console.DockDialogue(strip);
                    var answer=longAnswer?string.Concat(Enumerable.Repeat("This fictional desert scene remains a proposal. We can describe its shapes without inventing the person's travels. ",5)):"The Korean for desert is 사막 (samak).";
                    var view=new SessionView{Id="synthetic",State="review",Model=new ModelRef{Provider="fixture",Id="synthetic"},Items=new List<Item>{new Item{Id="item",Label="Dunes",Statement="A fictional proposed landscape.",Status="proposed"}},Utterances=new List<UtteranceRef>{new UtteranceRef{Id="utterance"}},Dialogue=new DialogueView{UtteranceId="utterance",At="1970-01-01T00:00:00Z",Text=answer,Actions=new List<ContextualAction>{new ContextualAction{Id="a",Question="How could I describe the visible shapes in Korean without claiming that I have visited or crossed this desert?"},new ContextualAction{Id="b",Question="Which short Korean phrase names the sand and sunlight while keeping uncertain details about this picture unknown?"}}}};
                    console.Render(view);strip.Show(DialogueStage.Response,answer);console.RefreshVisuals(2);strip.RefreshVisuals(2);
                    var first=console.GetComponentsInChildren<SpatialAction>().Single(a=>a.Action==ConsoleAction.FollowUpOne);var second=console.GetComponentsInChildren<SpatialAction>().Single(a=>a.Action==ConsoleAction.FollowUpTwo);
                    Require(console.SuggestedAction(ConsoleAction.FollowUpOne)?.Id=="a"&&console.SuggestedAction(ConsoleAction.FollowUpTwo)?.Id=="b","Legacy single-tap question binding changed.");
                    var backingRenderer=strip.GetComponentsInChildren<MeshRenderer>().Single(r=>r.name=="Speech contrast backing");var background=backingRenderer.bounds;
                    foreach(var action in new[]{first,second})
                    {
                        Require(action.transform.parent==strip.transform.parent,"Follow-up detached from answer.");Require(backingRenderer.sortingOrder<action.GetComponentsInChildren<MeshRenderer>().Single(r=>r.name=="Action surface").sortingOrder,"Conversation backing obscures follow-up fill feedback.");var bounds=action.GetComponent<BoxCollider>().bounds;
                        Require(bounds.min.x>=background.min.x-.001f&&bounds.max.x<=background.max.x+.001f&&bounds.min.y>=background.min.y-.001f&&bounds.max.y<=background.max.y+.001f,"Follow-up leaves answer backing.");
                        Require(!strip.GetComponent<BoxCollider>().bounds.Intersects(bounds),"Caption pager overlaps follow-up input.");
                    }
                    var top=first.GetComponent<BoxCollider>().bounds.max.y;var lower=strip.transform.TransformPoint(new Vector3(0,strip.ConversationAnswerBottom,0)).y;
                    Require(Mathf.Abs((lower-top)/console.ComfortScale-.016f)<.002f,"Answer-to-row gap is not measured sixteen millimeters.");
                    Require(first.GetComponent<BoxCollider>().bounds.min.y>second.GetComponent<BoxCollider>().bounds.max.y,"Follow-up rows overlap.");
                    var positions=new[]{first.transform.position,second.transform.position};var pages=(List<string>)typeof(DialogueStrip).GetField("pages",BindingFlags.Instance|BindingFlags.NonPublic)!.GetValue(strip)!;
                    Require(string.Concat(pages)==answer,"Answer paging lost exact characters.");
                    for(var page=0;page<strip.PageCount;page++)
                    {
                        strip.NextPage();console.RefreshVisuals(1);strip.RefreshVisuals(1);
                        Require(first.transform.position==positions[0]&&second.transform.position==positions[1],"Paging moved question targets.");
                        foreach(var text in console.GetComponentsInChildren<TextMeshPro>())
                        {
                            text.ForceMeshUpdate(true,true);Require(!text.isTextOverflowing,"Shared panel text overflows.");
                            foreach(var glyph in text.textInfo.characterInfo.Take(text.textInfo.characterCount).Where(g=>g.isVisible))foreach(var corner in new[]{glyph.bottomLeft,glyph.topRight}){var point=camera.WorldToViewportPoint(text.transform.TransformPoint(corner));Require(point.z>0&&point.x>=0&&point.x<=1&&point.y>=0&&point.y<=1,"Shared panel text leaves viewport.");}
                        }
                    }
                    var label=SpatialTheme.Text(root.transform,"Synthetic disclosure",SpatialTheme.Utility,SpatialTheme.Ivory);label.text="SYNTHETIC · AUTHORED ANSWER AND FOLLOW-UPS";label.rectTransform.sizeDelta=new Vector2(1.1f,.06f);label.transform.position=new Vector3(-.4f,-.45f,1.35f);
                    camera.Render();RenderTexture.active=target;pixels.ReadPixels(new Rect(0,0,1600,1000),0,0);pixels.Apply();var path=Path.Combine(Path.GetTempPath(),"boopy-SYNTHETIC-followups-"+(large?"large":"standard")+"-"+(longAnswer?"paged":"short")+(reduced?"-reduced":"")+".png");File.WriteAllBytes(path,pixels.EncodeToPNG());Debug.Log("Synthetic shared conversation render: "+path);
                    strip.ShowNotice("Kept the current conversation.",0);
                    Require(console.SuggestedAction(ConsoleAction.FollowUpOne)==null && console.SuggestedAction(ConsoleAction.FollowUpTwo)==null,"Notice retained questions without their originating answer.");
                    strip.ClearNotice();console.RefreshVisuals(1);strip.RefreshVisuals(1);
                    Require(strip.FullText==answer && first.transform.position==positions[0] && second.transform.position==positions[1],"Same-response notice moved restored targets or lost answer.");
                    console.ShowControlsOnly(console.transform.position);strip.SetFallback(true);Require(console.SuggestedAction(ConsoleAction.FollowUpOne)==null,"Protected presentation exposed question input.");
                    console.Place(new Vector3(0,-.12f,1.35f));strip.SetFallback(false);console.RefreshVisuals(1);strip.RefreshVisuals(1);
                    Require(console.SuggestedAction(ConsoleAction.FollowUpOne)?.Id=="a" && first.transform.position==positions[0] && second.transform.position==positions[1],"Protected fallback return changed question binding or targets.");
                    Require(!strip.GetComponent<BoxCollider>().bounds.Intersects(first.GetComponent<BoxCollider>().bounds),"Protected return overlapped paging input.");
                }
                finally{RenderTexture.active=old;UnityEngine.Object.DestroyImmediate(root);UnityEngine.Object.DestroyImmediate(pixels);UnityEngine.Object.DestroyImmediate(target);}
            }
            Debug.Log("Boopy shared conversation follow-up panel passed: exact paging, stable single-tap actions, measured gap, protected input, no overlap.");
        }
        private static void Require(bool value,string message){if(!value)throw new InvalidOperationException(message);}
    }
}
