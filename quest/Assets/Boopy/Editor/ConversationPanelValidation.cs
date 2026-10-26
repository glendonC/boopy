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
    /// <summary>Bounded informational questions page behind the exact answer, one per page; Ask in the row sends the one shown.</summary>
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
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);ScriptCoverage.Install();
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
                    var first=console.GetComponentsInChildren<SpatialAction>(true).Single(a=>a.Action==ConsoleAction.FollowUpOne);var second=console.GetComponentsInChildren<SpatialAction>(true).Single(a=>a.Action==ConsoleAction.FollowUpTwo);
                    var more=console.GetComponentsInChildren<SpatialAction>(true).Single(a=>a.Action==ConsoleAction.More);
                    // The answer's own pages come first with More in the row; nothing to ask shows until a question's page does.
                    Require(more.gameObject.activeInHierarchy && console.SuggestedAction(ConsoleAction.FollowUpOne)==null && console.SuggestedAction(ConsoleAction.FollowUpTwo)==null,"A question is offered before its page shows.");
                    var pages=(List<string>)typeof(DialogueStrip).GetField("pages",BindingFlags.Instance|BindingFlags.NonPublic)!.GetValue(strip)!;
                    var items=(List<int>)typeof(DialogueStrip).GetField("pageItems",BindingFlags.Instance|BindingFlags.NonPublic)!.GetValue(strip)!;
                    Require(string.Concat(pages.Where((page,index)=>items[index]<0))==answer,"Answer paging lost exact characters.");
                    Require(pages.Where((page,index)=>items[index]>=0).SequenceEqual(view.Dialogue!.Actions.Select(action=>action.Question)),"Questions are not one per page, word for word.");
                    var slot=more.transform.position;var shown=0;
                    for(var page=0;page<strip.PageCount;page++)
                    {
                        console.RefreshVisuals(1);strip.RefreshVisuals(1);
                        var item=strip.ShownItem;
                        var third=item==0?first:item==1?second:more;
                        Require(third.gameObject.activeInHierarchy && third.transform.position==slot && third.transform.parent.name=="Control bar","Paging moved the row's third tile or left it off the row.");
                        Require(console.SuggestedAction(ConsoleAction.FollowUpOne)?.Id==(item==0?"a":null) && console.SuggestedAction(ConsoleAction.FollowUpTwo)?.Id==(item==1?"b":null),"Ask does not send the question shown.");
                        Require(strip.SpeakerText.EndsWith(" · "+(page+1)+" of "+strip.PageCount) && (item<0 || strip.SpeakerText.StartsWith("You could ask")),"The page is not counted where the speaker line sits: "+strip.SpeakerText);
                        if(item>=0)shown++;
                        Require(!strip.GetComponent<BoxCollider>().bounds.Intersects(third.GetComponent<BoxCollider>().bounds),"Caption pager overlaps the row.");
                        foreach(var text in console.GetComponentsInChildren<TextMeshPro>())
                        {
                            text.ForceMeshUpdate(true,true);Require(!text.isTextOverflowing,"Shared panel text overflows.");
                            foreach(var glyph in text.textInfo.characterInfo.Take(text.textInfo.characterCount).Where(g=>g.isVisible))foreach(var corner in new[]{glyph.bottomLeft,glyph.topRight}){var point=camera.WorldToViewportPoint(text.transform.TransformPoint(corner));Require(point.z>0&&point.x>=0&&point.x<=1&&point.y>=0&&point.y<=1,"Shared panel text leaves viewport.");}
                        }
                        strip.NextPage();
                    }
                    Require(shown==2 && strip.ShownItem<0,"Paging did not show both questions and wrap to the answer.");
                    // The render shows the first question's page.
                    while(strip.ShownItem!=0)strip.NextPage();
                    console.RefreshVisuals(1);strip.RefreshVisuals(1);
                    var label=SpatialTheme.Text(root.transform,"Synthetic disclosure",SpatialTheme.Utility,SpatialTheme.Ivory);label.text="SYNTHETIC · AUTHORED ANSWER AND FOLLOW-UPS";label.rectTransform.sizeDelta=new Vector2(1.1f,.06f);label.transform.position=new Vector3(-.4f,-.45f,1.35f);
                    camera.Render();RenderTexture.active=target;pixels.ReadPixels(new Rect(0,0,1600,1000),0,0);pixels.Apply();var path=Path.Combine(Path.GetTempPath(),"boopy-SYNTHETIC-followups-"+(large?"large":"standard")+"-"+(longAnswer?"paged":"short")+(reduced?"-reduced":"")+".png");File.WriteAllBytes(path,pixels.EncodeToPNG());Debug.Log("Synthetic shared conversation render: "+path);
                    strip.ShowNotice("Kept the current conversation.",0);
                    Require(console.SuggestedAction(ConsoleAction.FollowUpOne)==null && console.SuggestedAction(ConsoleAction.FollowUpTwo)==null,"Notice retained questions without their originating answer.");
                    strip.ClearNotice();console.RefreshVisuals(1);strip.RefreshVisuals(1);
                    Require(strip.FullText==answer && strip.ShownItem==0 && console.SuggestedAction(ConsoleAction.FollowUpOne)?.Id=="a" && first.transform.position==slot,"Same-response notice moved the restored page or target, or lost the answer.");
                    console.ShowControlsOnly(console.transform.position);strip.SetFallback(true);Require(console.SuggestedAction(ConsoleAction.FollowUpOne)==null,"Protected presentation exposed question input.");
                    console.Place(new Vector3(0,-.12f,1.35f));strip.SetFallback(false);console.RefreshVisuals(1);strip.RefreshVisuals(1);
                    Require(console.SuggestedAction(ConsoleAction.FollowUpOne)?.Id=="a" && first.transform.position==slot,"Protected fallback return changed question binding or targets.");
                    Require(!strip.GetComponent<BoxCollider>().bounds.Intersects(first.GetComponent<BoxCollider>().bounds),"Protected return overlapped paging input.");
                }
                finally{RenderTexture.active=old;UnityEngine.Object.DestroyImmediate(root);UnityEngine.Object.DestroyImmediate(pixels);UnityEngine.Object.DestroyImmediate(target);}
            }
            Debug.Log("Boopy shared conversation follow-up panel passed: exact paging, questions one per page behind the answer, Ask in a fixed slot, protected input, no overlap.");
        }
        private static void Require(bool value,string message){if(!value)throw new InvalidOperationException(message);}
    }
}
