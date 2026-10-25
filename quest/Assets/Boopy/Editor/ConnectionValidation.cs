#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.IO;
using TMPro;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>Actual connection presentation with controlled synthetic health only; no providers or captures.</summary>
    public static class ConnectionValidation
    {
        private const BindingFlags Flags=BindingFlags.Instance|BindingFlags.NonPublic;
        public static void Validate()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);
            var root=new GameObject("Synthetic connection lifecycle");
            var previous=SynchronizationContext.Current; SynchronizationContext.SetSynchronizationContext(null);
            try
            {
                var eyes=new GameObject("Synthetic eyes").transform; eyes.SetParent(root.transform,false);
                var console=ContextConsole.Create(root.transform,eyes);
                var app=root.AddComponent<BoopyApp>(); var handler=new ControlledHealth();
                using var client=new ServiceClient(handler:handler);
                Set(app,"client",client); Set(app,"console",console);
                var first=(Task)Call(app,"CheckMac",true)!;
                Require(State(console)=="checking" && handler.Requests.Count==1,"Startup did not visibly check actual health.");
                Call(app,"OnFocusLost");
                handler.Complete(0,Valid); first.GetAwaiter().GetResult();
                Require(State(console)=="checking","Late health after focus loss claimed a connection.");
                Set(app,"inputAllowed",true);
                var second=(Task)Call(app,"CheckMac",true)!;
                handler.Complete(1,Valid); second.GetAwaiter().GetResult();
                Require(State(console)=="connected" && console.VoiceEnabled,"Valid Boopy health did not expose configured voice capability.");
                console.Activate(ConsoleAction.Speech);
                Require(!console.VoiceEnabled,"Explicit voice mute failed.");
                var refresh=(Task)Call(app,"CheckMac",false)!;
                Require(State(console)=="connected" && !console.VoiceEnabled,"Background refresh flickered status or reset mute.");
                handler.Complete(2,Valid); refresh.GetAwaiter().GetResult();
                Require(!console.VoiceEnabled,"Successful refresh reset explicit voice mute.");
                console.Activate(ConsoleAction.Speech);
                Require(console.VoiceEnabled,"Voice fixture was not re-enabled before loss of connection.");
                var invalid=(Task)Call(app,"CheckMac",false)!;
                handler.Complete(3,"{}"); invalid.GetAwaiter().GetResult();
                Require(State(console)=="unavailable" && !console.VoiceEnabled,"Generic HTTP200 retained connection/voice readiness.");
                console.Render(new SessionView {Id="synthetic-old-session",State="review",SpeechOutputAvailable=true});
                Require(State(console)=="unavailable" && !console.VoiceEnabled,"Rendering historical session capability overrode current unavailable connection.");
                Require(handler.Requests.Count==4 && Get(app,"pendingEvidence")==null && Get(app,"captureRequest")==null,
                    "Connection checks created capture or mutated context.");
                var room=root.AddComponent<RoomCamera>();var hud=LiveSceneHud.Create(root.transform,eyes,room);
                Set(app,"room",room);Set(app,"liveHud",hud);
                foreach(var capability in new[] { "available", "absent", "unknown" })
                {
                    var response=Valid.Substring(0,Valid.Length-1)+(capability=="available"
                        ? ",\"liveScene\":{\"provider\":\"local\",\"model\":\"synthetic\"}"
                        : capability=="absent" ? ",\"liveScene\":null" : "")+"}";
                    using var inFlight=new CancellationTokenSource();Set(app,"liveRequest",inFlight);
                    var check=(Task)Call(app,"CheckMac",false)!;handler.Complete(handler.Requests.Count-1,response);check.GetAwaiter().GetResult();
                    var available=capability=="available";
                    Require(inFlight.IsCancellationRequested!=available,"Health capability failed to cancel unavailable/unknown ambient work.");
                    Set(app,"liveRequest",null);
                    Call(app,"UpdateLiveScene",0f);
                    Require((bool)Get(hud,"active")! == available,"Ambient HUD ignored the explicit capability gate.");
                    if(!available)
                    {
                        var count=handler.Requests.Count;
                        for(var attempt=0;attempt<3;attempt++)
                        {
                            Call(app,"UpdateLiveScene",100f+attempt);
                            ((Task)Call(app,"ObserveScene")!).GetAwaiter().GetResult();
                        }
                        Require(handler.Requests.Count==count && Get(app,"liveRequest")==null,
                            "Unavailable/unknown capability continued ambient request attempts.");
                    }
                    console.Activate(ConsoleAction.Settings);
                    Require(console.GetComponentsInChildren<SpatialSurface>().Any(surface=>surface.BodyText.Contains(
                        available ? "Outlines are available." : capability=="absent" ? "Outlines are unavailable." : "Outline status is unknown.")),
                        "Settings concealed or overstated live capability.");
                    console.Activate(ConsoleAction.Settings);
                }
                // A failed live frame is logged by the service's code and status, not only the exception's type.
                var logged=(string)typeof(BoopyApp).GetMethod("LiveFailure",BindingFlags.Static|BindingFlags.NonPublic)!
                    .Invoke(null,new object[]{new ServiceException(502,"scene_invalid","Scene update did not match this view.")})!;
                Require(logged=="scene_invalid status=502","A failed live frame is logged as "+logged+", without its code and status.");
                Set(app,"connectionLiveSceneAvailable",true);
                Set(app,"liveScenePaused",false);
                foreach(var blocked in new[] { "busy", "reading", "focus", "paused" })
                {
                    Set(app,"busy",blocked=="busy"); Set(app,"liveScenePaused",blocked=="paused");
                    Set(console,"readerOpen",blocked=="reading");
                    Set(console,"focused",blocked=="focus" ? ConsoleAction.Talk : ConsoleAction.None);
                    using var inFlight=new CancellationTokenSource();Set(app,"liveRequest",inFlight);
                    var requests=handler.Requests.Count;
                    Call(app,"UpdateLiveScene",0f);
                    Require(inFlight.IsCancellationRequested && !(bool)Get(hud,"active")!,
                        "Ambient work did not yield to " + blocked);
                    Require(hud.CurrentTarget == null && !hud.HasPresentationFocus,
                        "Suppressed ambient state retained a target or own-label capture hold: " + blocked);
                    Set(app,"liveRequest",null);
                    ((Task)Call(app,"ObserveScene")!).GetAwaiter().GetResult();
                    Require(handler.Requests.Count==requests && Get(app,"liveRequest")==null,
                        "Suppressed ambient state started fresh capture: " + blocked);
                }
                Set(app,"busy",false);Set(app,"liveScenePaused",false);Set(console,"readerOpen",false);Set(console,"focused",ConsoleAction.None);
                Call(app,"UpdateLiveScene",0f);
                Require((bool)Get(hud,"active")!,"Ambient perception did not resume when conversation yielded.");
                SettingsLayouts(root,eyes,console);
                Debug.Log("Boopy connection lifecycle passed; synthetic health, no Muse-account or model-readiness claim.");
            }
            finally{SynchronizationContext.SetSynchronizationContext(previous); UnityEngine.Object.DestroyImmediate(root);}
        }
        private const string Valid="{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"meta-model-api\",\"model\":\"synthetic\"},\"speechOutputAvailable\":true}";
        private static void SettingsLayouts(GameObject root,Transform eyes,ContextConsole console)
        {
            HangulFont.Install(); console.Place(new Vector3(0,-.08f,1.2f)); eyes.rotation=Quaternion.identity;
            var camera=eyes.gameObject.AddComponent<Camera>();camera.fieldOfView=64;camera.aspect=1.6f;
            camera.nearClipPlane=.05f;camera.clearFlags=CameraClearFlags.SolidColor;camera.backgroundColor=new Color(.15f,.17f,.19f);
            var target=new RenderTexture(1200,750,24);target.Create();var pixels=new Texture2D(1200,750,TextureFormat.RGB24,false);
            var prior=RenderTexture.active;
            try
            {
                camera.targetTexture=target;
                console.Activate(ConsoleAction.Settings);
                // Every Settings text fits and stays in view.
                void Fits(string state)
                {
                    foreach(var text in console.GetComponentsInChildren<TextMeshPro>())
                    {
                        text.ForceMeshUpdate(true,true);
                        Require(!text.isTextOverflowing,"Settings text overflow at "+state+": "+text.name+" label="+text.text+" rect="+text.rectTransform.sizeDelta+" preferred="+text.GetPreferredValues(text.text,float.PositiveInfinity,float.PositiveInfinity)+" action="+text.GetComponentInParent<SpatialAction>()?.Action);
                        foreach(var glyph in text.textInfo.characterInfo.Take(text.textInfo.characterCount).Where(g=>g.isVisible))
                        foreach(var corner in new[] {glyph.bottomLeft,glyph.topRight})
                        {
                            var point=camera.WorldToViewportPoint(text.transform.TransformPoint(corner));
                            Require(point.z>0 && point.x>=0 && point.x<=1 && point.y>=0 && point.y<=1,"Settings text leaves viewport: "+text.name);
                        }
                    }
                }
                foreach(var state in new[] {"connected-unavailable","connected-on","connected-off","unavailable-unavailable"})
                foreach(var large in new[] {false,true})
                {
                    var parts=state.Split('-');var connection=parts[0];var voiceState=parts[1];
                    if((console.ComfortScale>1f)!=large)console.Activate(ConsoleAction.Size);
                    console.SetConnectionStatus(connection,voiceState!="unavailable");console.SetLiveSceneCapability(null);
                    if(voiceState!="unavailable" && console.VoiceEnabled!=(voiceState=="on"))console.Activate(ConsoleAction.Speech);
                    console.RefreshVisuals(1f);
                    var connectionWords=connection=="connected" ? "Boopy answers through your Mac." : "Boopy can’t reach your Mac. Check the USB cable.";
                    var voiceWords=voiceState=="unavailable" ? "Voice is unavailable." : voiceState=="on" ? "Voice reads replies aloud." : "Voice is off.";
                    // The first page says what is connected (the assistant, the Mac, outlines, voice) and sets nothing.
                    var expected="Your AI is not connected.\n"+connectionWords+"\nOutline status is unknown.\n"+voiceWords;
                    Require(console.GetComponentsInChildren<SpatialSurface>().Any(surface=>surface.BodyText==expected),
                        "Settings truncated capability/recovery guidance at "+connection+" large="+large);
                    Fits(state);
                    // Large text has the next page to itself.
                    console.NextPage();console.RefreshVisuals(1f);
                    Require(console.GetComponentsInChildren<SpatialSurface>().Any(surface=>surface.BodyText=="Large text is "+(large?"on.":"off.")),
                        "Settings lost the Large text page at "+connection+" large="+large);
                    // Voice's own page says the same, and its tile turns it off or on; unavailable, it shows no tile.
                    for(var page=0;page<3;page++)console.NextPage();
                    console.RefreshVisuals(1f);
                    var voiceSentence=voiceState=="unavailable" ? "Voice is unavailable." : voiceState=="on" ? "Voice is on." : "Voice is off.";
                    var voiceLabel=voiceState=="on" ? "Turn off" : "Turn on";
                    var voice=console.GetComponentsInChildren<SpatialAction>().SingleOrDefault(action=>action.Action==ConsoleAction.Speech);
                    Require(console.GetComponentsInChildren<SpatialSurface>().Any(surface=>surface.BodyText==voiceSentence)
                        && (voiceState=="unavailable" ? voice==null : voice!=null && voice.AccessibleLabel==voiceLabel),
                        "Settings voice explanation contradicts its control: "+state);
                    Fits(state);
                    camera.Render();RenderTexture.active=target;pixels.ReadPixels(new Rect(0,0,1200,750),0,0);pixels.Apply();
                    var path=Path.Combine(Path.GetTempPath(),"boopy-scene-capability-"+state+"-"+(large?"large":"standard")+".png");
                    File.WriteAllBytes(path,pixels.EncodeToPNG());Debug.Log("Boopy synthetic capability Settings render: "+path);
                    // Back to the first page for the next state.
                    console.NextPage();console.NextPage();
                }
            }
            finally {camera.targetTexture=null;RenderTexture.active=prior;UnityEngine.Object.DestroyImmediate(pixels);UnityEngine.Object.DestroyImmediate(target);}
        }
        private sealed class ControlledHealth:HttpMessageHandler
        {
            public readonly List<TaskCompletionSource<HttpResponseMessage>> Requests=new List<TaskCompletionSource<HttpResponseMessage>>();
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancel)
            {
                Require(request.Method==HttpMethod.Get && request.RequestUri!.AbsolutePath=="/v1/health","Connection check used a mutation or account endpoint.");
                var pending=new TaskCompletionSource<HttpResponseMessage>(); Requests.Add(pending); return pending.Task;
            }
            public void Complete(int index,string body)=>Requests[index].SetResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(body)});
        }
        private static string State(ContextConsole console)=>(string)Get(console,"connectionState")!;
        private static object? Call(object target,string name,params object[] args)=>target.GetType().GetMethod(name,Flags)!.Invoke(target,args);
        private static object? Get(object target,string name)=>target.GetType().GetField(name,Flags)!.GetValue(target);
        private static void Set(object target,string name,object? value)=>target.GetType().GetField(name,Flags)!.SetValue(target,value);
        private static void Require(bool value,string message){if(!value)throw new InvalidOperationException(message);}
    }
}
