#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Boopy.Client;
using TMPro;
using UnityEditor.SceneManagement;
using UnityEngine;
namespace Boopy.Quest.Editor
{
    public static class ChoiceCardValidation
    {
        public static void ValidateAndRender()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single); ScriptCoverage.Install();
            ValidateDispatch();
            foreach(var large in new[]{false,true}) foreach(var selected in new[]{false,true}) foreach(var reduced in new[]{false,true})
            {
                var root=new GameObject("SYNTHETIC native choice card");
                var target=new RenderTexture(1600,1000,24); target.Create();
                var pixels=new Texture2D(1600,1000,TextureFormat.RGB24,false);var old=RenderTexture.active;
                try
                {
                    var eyes=new GameObject("Eyes").transform;eyes.SetParent(root.transform,false);
                    var camera=eyes.gameObject.AddComponent<Camera>();camera.fieldOfView=64;camera.aspect=1.6f;camera.nearClipPlane=.05f;
                    camera.clearFlags=CameraClearFlags.SolidColor;camera.backgroundColor=new Color(.12f,.15f,.19f);camera.targetTexture=target;
                    var disclosure=SpatialTheme.Text(root.transform,"SYNTHETIC fixture disclosure",SpatialTheme.Utility,SpatialTheme.Ivory);disclosure.text="SYNTHETIC · AUTHORED CHOICE FIXTURE";disclosure.rectTransform.sizeDelta=new Vector2(.8f,.04f);disclosure.transform.position=new Vector3(-.4f,-.42f,1.35f);
                    var console=ContextConsole.Create(root.transform,eyes); console.Place(new Vector3(0,-.05f,1.35f));
                    if(large)console.Activate(ConsoleAction.Size);
                    if(console.ReducedMotion!=reduced)console.Activate(ConsoleAction.Motion);
                    var choice=new ChoiceCard{Id="synthetic-card",Kind="choice",Prompt="What would you like to explore about the dunes around you?",Options=new List<ChoiceOption>{
                        Option("a","How these sweeping sand dunes change with the wind"),Option("b","A short Korean phrase about the sunlight on these dunes"),Option("c","How to describe this place without inventing a journey")},SelectedOptionId=selected?"b":null};
                    var view=new SessionView{Id="synthetic-session",State="review",Utterances=new List<UtteranceRef>{new UtteranceRef{Id="synthetic-turn"}},Dialogue=new DialogueView{UtteranceId="synthetic-turn",At="1970-01-01T00:00:00Z",Text=choice.Prompt,Choice=choice}};
                    var strip=DialogueStrip.Create(root.transform,eyes);console.DockDialogue(strip);
                    console.Render(view);strip.Show(DialogueStage.Response,view.Dialogue!.Text);console.RefreshVisuals(1);strip.RefreshVisuals(2);
                    // The prompt with one option under it and "1 of 3" on the speaker line; Choose, a tile of the row, sends the one
                    // shown. A selection the Mac kept changes nothing shown.
                    Require(console.SelectedChoice(ConsoleAction.SendChoice)?.OptionId=="a" && strip.VisibleText.Contains(choice.Prompt) && strip.VisibleText.Contains(choice.Options[0].Label)
                        && strip.SpeakerText.EndsWith(" · 1 of 3"),"Choice unavailable: "+strip.SpeakerText+" / "+strip.VisibleText);
                    var backing=strip.GetComponentsInChildren<MeshRenderer>().Single(r=>r.name=="Speech contrast backing").bounds;
                    var choose=console.GetComponentsInChildren<SpatialAction>().Single(a=>a.Action==ConsoleAction.SendChoice);
                    Require(choose.transform.parent.name=="Control bar" && choose.AccessibleLabel=="Choose","Choose is not a tile of the row.");
                    Require(!strip.GetComponent<BoxCollider>().bounds.Intersects(choose.GetComponent<BoxCollider>().bounds),"Caption pager overlaps choice input.");
                    Require(choose.GetComponent<BoxCollider>().bounds.max.y<backing.min.y,"Choose sits on the line's panel.");
                    Require(console.GetComponentsInChildren<SpatialAction>().All(a=>a.transform.parent.name=="Control bar"),"A choice control sits off the row.");
                    foreach(var text in console.GetComponentsInChildren<TextMeshPro>())
                    {
                        text.ForceMeshUpdate(true,true);Require(!text.isTextOverflowing,"Choice text overflow: "+text.text);
                        foreach(var g in text.textInfo.characterInfo.Take(text.textInfo.characterCount).Where(g=>g.isVisible))
                        foreach(var corner in new[]{g.bottomLeft,g.topRight}) {var p=camera.WorldToViewportPoint(text.transform.TransformPoint(corner));Require(p.z>0&&p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1,"Choice left viewport: "+text.text);}
                    }
                    camera.Render();RenderTexture.active=target;pixels.ReadPixels(new Rect(0,0,1600,1000),0,0);pixels.Apply();
                    var path=Path.Combine(Path.GetTempPath(),"boopy-SYNTHETIC-choice-"+(large?"large":"standard")+"-"+(selected?"selected":"unselected")+(reduced?"-reduced":"")+".png");File.WriteAllBytes(path,pixels.EncodeToPNG());Debug.Log("Synthetic authored choice render: "+path);
                    var hoverControl=choose;
                    var sample=camera.WorldToScreenPoint(hoverControl.transform.TransformPoint(new Vector3(.054f,0,0)));
                    var sx=Mathf.Clamp(Mathf.RoundToInt(sample.x),0,pixels.width-1);var sy=Mathf.Clamp(Mathf.RoundToInt(sample.y),0,pixels.height-1);
                    var restingPixel=pixels.GetPixel(sx,sy);
                    hoverControl.Focus(true);hoverControl.Refresh(.3f,1f,reduced);
                    camera.Render();RenderTexture.active=target;pixels.ReadPixels(new Rect(0,0,1600,1000),0,0);pixels.Apply();
                    var hoverPixel=pixels.GetPixel(sx,sy);
                    Require(hoverPixel.grayscale-restingPixel.grayscale>.015f,"Actual conversation backing obscures whole-face hover contrast.");
                    File.WriteAllBytes(path.Replace(".png","-hover.png"),pixels.EncodeToPNG());
                    hoverControl.Focus(false);hoverControl.Refresh(.3f,1f,reduced);
                    // A pinch on the panel shows the next option, and the last wraps to the first.
                    strip.NextPage();
                    Require(console.SelectedChoice(ConsoleAction.SendChoice)?.OptionId=="b" && strip.VisibleText.Contains(choice.Options[1].Label) && strip.SpeakerText.EndsWith(" · 2 of 3"),"Paging does not show the next option.");
                    strip.NextPage();strip.NextPage();
                    Require(console.SelectedChoice(ConsoleAction.SendChoice)?.OptionId=="a" && strip.SpeakerText.EndsWith(" · 1 of 3"),"Paging does not wrap to the first option.");
                    strip.NextPage();
                    strip.ShowNotice("Stopped waiting. The Mac may still finish this choice.",0);
                    Require(console.SelectedChoice(ConsoleAction.SendChoice)==null,"Stopped-wait caption retained choice input without its question.");
                    // The choice still stands under the notice: nothing takes its slot.
                    Require(!console.GetComponentsInChildren<SpatialAction>().Any(tile=>tile.gameObject.activeInHierarchy&&(tile.Action==ConsoleAction.More||tile.Action==ConsoleAction.SendChoice)),"A notice over a choice lets a tile take the choice's slot.");
                    strip.ClearNotice();console.RefreshVisuals(1);strip.RefreshVisuals(1);
                    Require(console.SelectedChoice(ConsoleAction.SendChoice)?.OptionId=="b" && choice.SelectedOptionId==(selected?"b":null),"Restored caption lost the option shown or the kept selection.");
                    console.ShowControlsOnly(console.transform.position);Require(console.SelectedChoice(ConsoleAction.SendChoice)==null,"Protected UI accepted choice.");console.Place(new Vector3(0,-.05f,1.35f));
                    console.SetBusy(true);Require(console.SelectedChoice(ConsoleAction.SendChoice)==null,"Busy choice remained live.");console.SetBusy(false);
                    view.Dialogue!.UtteranceId="stale";console.Render(view);Require(console.SelectedChoice(ConsoleAction.SendChoice)==null,"Stale response accepted choice.");view.Dialogue.UtteranceId="synthetic-turn";
                    choice.Kind="unsupported";console.Render(view);Require(console.SelectedChoice(ConsoleAction.SendChoice)==null,"Unsupported UI did not fall back.");
                }
                finally{RenderTexture.active=old;UnityEngine.Object.DestroyImmediate(root);UnityEngine.Object.DestroyImmediate(pixels);UnityEngine.Object.DestroyImmediate(target);}
            }
            Debug.Log("Boopy bounded native choice validation passed (synthetic authored content, no inference or external send).");
        }
        public static void RenderRealModel()
        {
            var source=Environment.GetEnvironmentVariable("BOOPY_CHOICE_PREVIEW_PATH");
            if(string.IsNullOrWhiteSpace(source))throw new InvalidOperationException("Explicit fictional provider artifact required.");
            var artifact=Newtonsoft.Json.Linq.JObject.Parse(File.ReadAllText(source));
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);ScriptCoverage.Install();
            foreach(var state in new[]{"initialSessionView","selectedSessionView","finalSessionView","cancelledSelected","restoredSelected"}) foreach(var large in new[]{false,true})
            {
                var noticeCase=state=="cancelledSelected"||state=="restoredSelected";
                var view=Wire.Read<SessionView>(artifact[noticeCase?"selectedSessionView":state]!.ToString());
                var root=new GameObject("Actual local model fictional scene preview");var target=new RenderTexture(1600,1000,24);target.Create();
                var pixels=new Texture2D(1600,1000,TextureFormat.RGB24,false);var old=RenderTexture.active;
                try
                {
                    var eyes=new GameObject("Eyes").transform;eyes.SetParent(root.transform,false);var camera=eyes.gameObject.AddComponent<Camera>();
                    camera.fieldOfView=64;camera.aspect=1.6f;camera.nearClipPlane=.05f;camera.clearFlags=CameraClearFlags.SolidColor;camera.backgroundColor=new Color(.12f,.15f,.19f);camera.targetTexture=target;
                    var console=ContextConsole.Create(root.transform,eyes);console.Place(new Vector3(0,-.12f,1.35f));
                    if(large)console.Activate(ConsoleAction.Size);
                    var strip=DialogueStrip.Create(root.transform,eyes);console.DockDialogue(strip);console.Render(view);
                    strip.Show(DialogueStage.Response,view.Dialogue?.Text??view.Notice??"No reply.");
                    if(noticeCase)
                    {
                        var selected=view.Dialogue!.Choice!.SelectedOptionId;
                        strip.Show(DialogueStage.Error,"Stopped waiting. The Mac may still finish this choice.");console.ShowError("Stopped waiting. The Mac may still finish this choice.");
                        Require(console.SelectedChoice(ConsoleAction.SendChoice)==null,"Recorded stopped notice exposes card without its question.");
                        if(state=="restoredSelected")
                        {
                            console.Render(view);strip.Show(DialogueStage.Response,view.Dialogue.Text);Require(console.SelectedChoice(ConsoleAction.SendChoice)!=null,"Saved caption did not offer the choice again.");
                        }
                        Require(view.Dialogue.Choice.SelectedOptionId==selected,"Notice erased journaled selection.");
                    }
                    console.RefreshVisuals(2);strip.RefreshVisuals(2);
                    Require(strip.GetComponentsInChildren<TextMeshPro>().Any(t=>t.text==strip.FullText && t.alpha>.9f),"Actual model caption did not visibly render.");
                    foreach(var text in strip.GetComponentsInChildren<TextMeshPro>())
                    {
                        text.ForceMeshUpdate(true,true);Require(!text.isTextOverflowing,"Actual reply overflow.");
                        foreach(var glyph in text.textInfo.characterInfo.Take(text.textInfo.characterCount).Where(g=>g.isVisible))
                        foreach(var corner in new[]{glyph.bottomLeft,glyph.topRight}){var point=camera.WorldToViewportPoint(text.transform.TransformPoint(corner));Require(point.z>0&&point.x>=0&&point.x<=1&&point.y>=0&&point.y<=1,"Actual reply left viewport.");}
                    }
                    var label=SpatialTheme.Text(root.transform,"Preview disclosure",SpatialTheme.Utility,SpatialTheme.Ivory);label.text=noticeCase?"RECORDED MODEL · SYNTHETIC NOTICE · EDITOR PREVIEW":"REAL LOCAL MODEL · SYNTHETIC SCENE · EDITOR PREVIEW";label.rectTransform.sizeDelta=new Vector2(1.2f,.06f);label.transform.position=new Vector3(-.6f,-.45f,1.35f);
                    camera.Render();RenderTexture.active=target;pixels.ReadPixels(new Rect(0,0,1600,1000),0,0);pixels.Apply();
                    var path=Path.Combine(Path.GetTempPath(),"boopy-REAL-MODEL-choice-"+state+(large?"-large":"")+".png");File.WriteAllBytes(path,pixels.EncodeToPNG());Debug.Log("Real local model fictional scene native UI: "+path);
                }
                finally{RenderTexture.active=old;UnityEngine.Object.DestroyImmediate(root);UnityEngine.Object.DestroyImmediate(pixels);UnityEngine.Object.DestroyImmediate(target);}
            }
        }
        private const System.Reflection.BindingFlags Flags=System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic;
        private static void Set(object target,string field,object? value)=>target.GetType().GetField(field,Flags)!.SetValue(target,value);
        private static object? Get(object target,string field)=>target.GetType().GetField(field,Flags)!.GetValue(target);
        private static void ValidateDispatch()
        {
            var previous=System.Threading.SynchronizationContext.Current;System.Threading.SynchronizationContext.SetSynchronizationContext(null);
            try
            {
                // One tap is two posts, the selection and then the send; an outcome strikes at either.
                foreach(var atSend in new[]{false,true}) foreach(var outcome in new[]{"accepted","cancelled","focus-lost","failed","replaced","superseded","unreadable","broken","refused","busy"})
                {
                    var root=new GameObject("Synthetic choice dispatch");
                    try
                    {
                        var eyes=new GameObject("Eyes").transform;eyes.SetParent(root.transform,false);
                        var console=ContextConsole.Create(root.transform,eyes);var strip=DialogueStrip.Create(root.transform,eyes);
                        var view=new SessionView{Id="synthetic",State="review",Utterances=new List<UtteranceRef>{new UtteranceRef{Id="utterance"}},Dialogue=new DialogueView{UtteranceId="utterance",At="1970-01-01T00:00:00Z",Text="What interests you?",Choice=new ChoiceCard{Id="card",Kind="choice",Prompt="What interests you?",Options=new List<ChoiceOption>{Option("a","Dunes"),Option("b","Light")}}}};
                        console.DockDialogue(strip);console.Render(view);strip.Show(DialogueStage.Response,view.Dialogue!.Text);var app=root.AddComponent<BoopyApp>();Set(app,"console",console);Set(app,"dialogue",strip);Set(app,"session",view);
                        var handler=new ChoiceHandler{View=view};
                        handler.OnPost=()=>
                        {
                            Require((bool)Get(app,"busy")! && Get(app,"captureRequest")!=null,"Choice lacks request lock.");
                            Require(console.SelectedChoice(ConsoleAction.SendChoice)==null,"Choice remained actionable during dispatch.");
                            if(atSend && handler.Posts==1)return;
                            if(outcome=="cancelled")((System.Threading.CancellationTokenSource)Get(app,"captureRequest")!).Cancel();
                            if(outcome=="focus-lost")typeof(BoopyApp).GetMethod("OnFocusLost",Flags)!.Invoke(app,null);
                            if(outcome=="replaced") { Set(app,"captureRequest",new System.Threading.CancellationTokenSource());strip.Show(DialogueStage.Response,"A newer reply.");throw new System.Net.Http.HttpRequestException("late synthetic drop"); }
                            if(outcome=="failed")throw new System.Net.Http.HttpRequestException("synthetic drop");
                            // A newer request takes over while this one is answered normally: a selection overtaken this way is never sent.
                            if(outcome=="superseded") { Set(app,"captureRequest",new System.Threading.CancellationTokenSource());strip.Show(DialogueStage.Response,"A newer reply."); }
                            // The Mac answers with words the headset cannot read.
                            if(outcome=="unreadable")handler.Body="unreadable";
                            // The Mac refuses the choice as no longer available, or as busy with the last request, in its own words.
                            if(outcome=="refused"){handler.Status=System.Net.HttpStatusCode.Conflict;handler.Body="{\"error\":{\"code\":\"stale_choice\",\"message\":\"That choice is no longer available. Ask again.\"}}";}
                            if(outcome=="busy"){handler.Status=System.Net.HttpStatusCode.Conflict;handler.Body="{\"error\":{\"code\":\"busy\",\"message\":\"Still working on the last request.\"}}";}
                            // The answer fails in a way the connection does not explain.
                            if(outcome=="broken")throw new InvalidOperationException("synthetic broken reply");
                        };
                        using var client=new ServiceClient(handler:handler);Set(app,"client",client);
                        ((System.Threading.Tasks.Task)typeof(BoopyApp).GetMethod("Choose",Flags)!.Invoke(app,new object[]{ConsoleAction.SendChoice})!).GetAwaiter().GetResult();
                        Require(handler.Posts==(outcome=="accepted"||atSend?2:1) && handler.Paths[0].EndsWith("/choice-selection") && (handler.Posts==1||handler.Paths[1].EndsWith("/choice-submit")),
                            "One tap is not one selection and then one send ("+outcome+(atSend?" at the send":" at the selection")+"): "+string.Join(", ",handler.Paths));if(outcome=="replaced"||outcome=="superseded") { Require((bool)Get(app,"busy")! && Get(app,"captureRequest")!=null && strip.FullText=="A newer reply.","Late choice changed newer request.");((System.Threading.CancellationTokenSource)Get(app,"captureRequest")!).Dispose();Set(app,"captureRequest",null); }
                        else Require(!(bool)Get(app,"busy")! && Get(app,"captureRequest")==null,"Choice retained lock.");
                        if(outcome!="accepted")Require(ReferenceEquals(Get(app,"session"),view),"Late choice replaced original session.");
                        // From the send on the card is gone for every outcome. Before it, a card whose selection failed or was cancelled
                        // stays: its line says so for a moment, and once those words end the card is offered again.
                        var before=!atSend&&(outcome=="cancelled"||outcome=="failed"||outcome=="unreadable"||outcome=="broken"||outcome=="busy");
                        if(!before)Require(console.SelectedChoice(ConsoleAction.SendChoice)==null,"Dispatched card offered unsafe retry.");
                        else
                        {
                            var said=outcome=="cancelled"?"Stopped waiting. You can choose again."
                                : outcome=="busy"?"Still working on the last request."
                                : "Boopy didn't hear back from your Mac. Reconnect, then choose again.";
                            Require(strip.FullText==said&&console.SelectedChoice(ConsoleAction.SendChoice)==null,"Before the send the line does not say the card stays ("+outcome+"): "+strip.FullText);
                            // The choice still stands under the words: nothing takes its slot, so no tile turns into Choose under a hand.
                            var tiles=console.GetComponentsInChildren<SpatialAction>().Where(tile=>tile.gameObject.activeInHierarchy).Select(tile=>tile.Action).ToArray();
                            Require(!tiles.Contains(ConsoleAction.More)&&!tiles.Contains(ConsoleAction.SendChoice)&&!tiles.Contains(ConsoleAction.FollowUpOne),"While the words show, the choice's slot holds a tile ("+outcome+"): "+string.Join(", ",tiles));
                            strip.ClearNotice();console.RefreshVisuals(1);strip.RefreshVisuals(1);
                            Require(console.SelectedChoice(ConsoleAction.SendChoice)?.OptionId=="a"&&strip.FullText==view.Dialogue!.Text,"A card whose selection failed or was cancelled is not offered again ("+outcome+").");
                        }
                        if(atSend&&outcome=="cancelled")Require(strip.FullText=="Stopped waiting. The Mac may still finish this choice.","A stop after the send reads: "+strip.FullText);
                        // From the send on, Boopy did not hear back from a lost connection or a broken answer; a refusal keeps the Mac's words.
                        const string unheard="Boopy didn't hear back from your Mac. The Mac may still finish this choice. Reconnect, then Talk to answer.";
                        if(atSend&&(outcome=="broken"||outcome=="failed"))Require(strip.FullText==unheard,"A "+outcome+" answer after the send reads: "+strip.FullText);
                        if(atSend&&outcome=="busy")Require(strip.FullText=="Still working on the last request.","A busy Mac after the send reads: "+strip.FullText);
                        // A choice the Mac says is no longer available goes at either stage, its words on the line, and stays gone after the
                        // canonical read: offered again, every tap would be refused the same way.
                        if(outcome=="refused")
                        {
                            Require(strip.FullText=="That choice is no longer available. Ask again." && console.SelectedChoice(ConsoleAction.SendChoice)==null,"A stale choice reads: "+strip.FullText);
                            console.Render(view);strip.Show(DialogueStage.Response,view.Dialogue!.Text);console.RefreshVisuals(1);strip.RefreshVisuals(1);
                            Require(console.SelectedChoice(ConsoleAction.SendChoice)==null,"A stale choice is offered again after the canonical read ("+(atSend?"at the send":"at the selection")+").");
                        }
                    }
                    finally{UnityEngine.Object.DestroyImmediate(root);}
                }
            }
            finally{System.Threading.SynchronizationContext.SetSynchronizationContext(previous);}
        }
        private sealed class ChoiceHandler:System.Net.Http.HttpMessageHandler
        {
            public SessionView View=new SessionView();public Action? OnPost;public int Posts;public string? Body;public System.Net.HttpStatusCode Status=System.Net.HttpStatusCode.OK;public readonly List<string> Paths=new List<string>();
            protected override System.Threading.Tasks.Task<System.Net.Http.HttpResponseMessage> SendAsync(System.Net.Http.HttpRequestMessage request,System.Threading.CancellationToken cancel)
            {
                if(request.Method==System.Net.Http.HttpMethod.Get)return System.Threading.Tasks.Task.FromResult(new System.Net.Http.HttpResponseMessage(System.Net.HttpStatusCode.OK){Content=new System.Net.Http.StringContent("{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}}")});
                Posts++;Paths.Add(request.RequestUri!.AbsolutePath);OnPost?.Invoke();
                if(Body!=null)return System.Threading.Tasks.Task.FromResult(new System.Net.Http.HttpResponseMessage(Status){Content=new System.Net.Http.StringContent(Body)});
                var returned=Wire.Read<SessionView>(Wire.Write(View));returned.Dialogue!.Choice!.SelectedOptionId="a";
                return System.Threading.Tasks.Task.FromResult(new System.Net.Http.HttpResponseMessage(System.Net.HttpStatusCode.OK){Content=new System.Net.Http.StringContent(Wire.Write(returned),System.Text.Encoding.UTF8,"application/json")});
            }
        }
        private static ChoiceOption Option(string id,string label)=>new ChoiceOption{Id=id,Label=label,Value=label};
        private static void Require(bool value,string message){if(!value)throw new InvalidOperationException(message);}
    }
}
