#nullable enable
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using Newtonsoft.Json.Linq;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>Explicit isolated fictional service only. Production app dispatch, real HTTP and native rendering.</summary>
    public static class ChoiceHttpValidation
    {
        private const BindingFlags Flags=BindingFlags.Instance|BindingFlags.NonPublic;
        private static Task? running;
        private static double started;
        public static void Run()
        {
            // Do not use -quit: Unity's Editor loop must deliver the actual captured synchronization context.
            if(running!=null)throw new InvalidOperationException("An isolated choice validation already runs.");
            started=EditorApplication.timeSinceStartup;
            running=RunAsync();EditorApplication.update+=Poll;
        }
        private static void Poll()
        {
            if(running==null)return;
            if(!running.IsCompleted && EditorApplication.timeSinceStartup-started<150)return;
            EditorApplication.update-=Poll;
            var success=running.Status==TaskStatus.RanToCompletion;
            if(!success) { var failure=running.Exception?.GetBaseException(); Debug.LogError("Boopy isolated fictional choice HTTP validation failed: "+(failure is ChoiceValidationException ? failure.Message : failure?.GetType().Name??"deadline")+". No provider diagnostics logged."); }
            running=null;EditorApplication.Exit(success?0:1);
        }
        private static async Task RunAsync()
        {
            var path=Environment.GetEnvironmentVariable("BOOPY_CHOICE_HTTP_METADATA");
            if(string.IsNullOrWhiteSpace(path))throw new InvalidOperationException("Explicit isolated fictional service metadata required.");
            var metadata=JObject.Parse(File.ReadAllText(path));
            var url=(string?)metadata["baseUrl"];
            if(!Uri.TryCreate(url,UriKind.Absolute,out var address)||address.Scheme!="http"||address.Host!="127.0.0.1"||address.IsDefaultPort||address.Port==47900)
                throw new InvalidOperationException("Only explicit ephemeral loopback service is supported.");
            var initial=Wire.Read<SessionView>(metadata["initialSessionView"]!.ToString());
            if(initial.Dialogue?.Choice?.Supported!=true||initial.Dialogue.Text.Trim()!=initial.Dialogue.Choice.Prompt.Trim())
                throw new InvalidOperationException("Actual fictional provider card must satisfy the current native contract.");
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);ScriptCoverage.Install();
            var output=Path.Combine(Path.GetTempPath(),"boopy-unified-real-http");Directory.CreateDirectory(output);
            var root=new GameObject("Fictional local model · actual HTTP production dispatch");
            var target=new RenderTexture(1600,1000,24);target.Create();var pixels=new Texture2D(1600,1000,TextureFormat.RGB24,false);var old=RenderTexture.active;
            using var client=new ServiceClient(url!,requestTimeout:TimeSpan.FromSeconds(65));
            try
            {
                var eyes=new GameObject("Eyes").transform;eyes.SetParent(root.transform,false);var camera=eyes.gameObject.AddComponent<Camera>();
                camera.fieldOfView=64;camera.aspect=1.6f;camera.nearClipPlane=.05f;camera.clearFlags=CameraClearFlags.SolidColor;camera.backgroundColor=new Color(.12f,.15f,.19f);camera.targetTexture=target;
                var console=ContextConsole.Create(root.transform,eyes);console.Place(new Vector3(0,-.12f,1.35f));
                var strip=DialogueStrip.Create(root.transform,eyes);console.DockDialogue(strip);
                var app=root.AddComponent<BoopyApp>();Set(app,"console",console);Set(app,"dialogue",strip);Set(app,"session",initial);Set(app,"client",client);Set(app,"head",eyes);
                var label=SpatialTheme.Text(root.transform,"Preview disclosure",SpatialTheme.Utility,SpatialTheme.Ivory);label.text="REAL HTTP + LOCAL MODEL · SYNTHETIC SCENE · EDITOR PREVIEW";label.rectTransform.sizeDelta=new Vector2(1.35f,.06f);label.transform.position=new Vector3(-.45f,-.45f,1.35f);
                Apply(app,initial);Frame("01-question");
                console.ShowControlsOnly(console.transform.position);strip.SetFallback(true);
                Require(console.SelectedChoice(ConsoleAction.SendChoice)==null,"Protected presentation exposes choice input.");Frame("02-protected");
                console.Place(new Vector3(0,-.12f,1.35f));strip.SetFallback(false);
                // Stop the actual dispatch before waiting; no synthetic handler intercepts network activity.
                var stopped=Choose(app,ConsoleAction.SendChoice);var wait=(CancellationTokenSource?)Get(app,"captureRequest");
                Require(wait!=null,"Real choice did not own a cancellable wait.");wait!.Cancel();await stopped;
                Require(ReferenceEquals(Get(app,"session"),initial)&&strip.FullText.Contains("Stopped waiting"),"Cancelled request changed the session or omitted the caption.");Frame("03-cancelled");
                // Explicit read, never mutation retry: reconcile the same isolated session before the next human-equivalent choice.
                var canonical=await client.ReadSessionAsync(initial.Id);Apply(app,canonical);Frame("04-restored");
                // One tap sends the option the line shows: the Mac records the selection, then answers it.
                Require(console.SelectedChoice(ConsoleAction.SendChoice)?.OptionId==initial.Dialogue.Choice.Options[0].Id,"Choose does not offer the option shown.");Frame("05-shown");
                var submitted=Choose(app,ConsoleAction.SendChoice);
                Require(console.SelectedChoice(ConsoleAction.SendChoice)==null,"Submitted card remains actionable.");Frame("06-sending");
                var lastProgress=strip.FullText;var progressFrames=0;Exception? progressFailure=null;
                void ProgressFrame()
                {
                    if(strip.Stage!=DialogueStage.Working||strip.FullText==lastProgress||progressFrames>=4)return;
                    lastProgress=strip.FullText;try{Frame("06-progress-"+(++progressFrames));}catch(Exception failure){progressFailure=failure;}
                }
                EditorApplication.update+=ProgressFrame;
                try{await submitted;}finally{EditorApplication.update-=ProgressFrame;}
                Require(progressFailure==null,"Actual progress render failed its geometry guards.");
                var final=(SessionView)Get(app,"session")!;
                var finalDialogue=final.Dialogue??throw new ChoiceValidationException("Final reply missing.");
                Require(final.InterpretationFailure==null && final.Utterances.Count==canonical.Utterances.Count+1 && final.Model?.Provider==initial.Model?.Provider && final.Model?.Id==initial.Model?.Id && final.Model?.Provider=="ollama","Submit did not preserve successful configured provider provenance.");
                Require(final.Id==initial.Id&&finalDialogue.UtteranceId!=canonical.Dialogue!.UtteranceId,"Actual submit did not return a new answer.");
                // The reply is a new model turn with its own proposed items. Choosing confirmed nothing: nothing is committed, and every
                // item that is not proposed was already so in the canonical read. A selection changing no evidence is pinned on the
                // service side (service/src/interactive-choice.test.ts).
                Require(final.Committed==null && final.Items.All(item=>item.Status=="proposed"||canonical.Items.Any(prior=>prior.Id==item.Id && prior.Status==item.Status)),"Choosing confirmed evidence.");
                Require(final.Utterances.Last().Text.EndsWith("Selected: "+initial.Dialogue.Choice.Options[0].Value),"The Mac did not receive the option shown.");
                Require(strip.FullText==finalDialogue.Text&&!(bool)Get(app,"busy")!&&Get(app,"captureRequest")==null,"Actual answer lost text or retained lock.");Frame("07-reply");
                File.WriteAllText(Path.Combine(output,"summary.json"),new JObject{["syntheticScene"]=true,["realHttp"]=true,["newUtteranceCount"]=final.Utterances.Count-canonical.Utterances.Count,["exactVisibleAnswer"]=strip.FullText==finalDialogue.Text,["chosenOptionId"]=initial.Dialogue.Choice.Options[0].Id,["actualProgressFrames"]=progressFrames,["externalDelivery"]=false}.ToString());
                Debug.Log("Boopy real isolated HTTP Choose passed; fictional scene, one-tap select and submit/protected/cancel/reply, no headset or consumer delivery. Artifacts: "+output);
                void Frame(string name)
                {
                    console.RefreshVisuals(2);strip.RefreshVisuals(2);
                    Require(strip.GetComponentsInChildren<TextMeshPro>().Any(t=>t.name=="Actual response" && t.alpha>.9f && !string.IsNullOrWhiteSpace(t.text)),"Actual HTTP caption is not visibly rendered.");
                    foreach(var text in strip.GetComponentsInChildren<TextMeshPro>())
                    {
                        text.ForceMeshUpdate(true,true);Require(!text.isTextOverflowing,"Actual HTTP reply overflow.");
                        foreach(var glyph in text.textInfo.characterInfo.Take(text.textInfo.characterCount).Where(g=>g.isVisible))foreach(var corner in new[]{glyph.bottomLeft,glyph.topRight})
                        {var point=camera.WorldToViewportPoint(text.transform.TransformPoint(corner));Require(point.z>0&&point.x>=0&&point.x<=1&&point.y>=0&&point.y<=1,"Actual HTTP reply leaves viewport.");}
                    }
                    camera.Render();RenderTexture.active=target;pixels.ReadPixels(new Rect(0,0,1600,1000),0,0);pixels.Apply();File.WriteAllBytes(Path.Combine(output,name+".png"),pixels.EncodeToPNG());
                }
            }
            finally{RenderTexture.active=old;UnityEngine.Object.DestroyImmediate(root);UnityEngine.Object.DestroyImmediate(pixels);UnityEngine.Object.DestroyImmediate(target);}
        }
        private static Task Choose(BoopyApp app,ConsoleAction action)=>(Task)typeof(BoopyApp).GetMethod("Choose",Flags)!.Invoke(app,new object[]{action})!;
        private static void Apply(BoopyApp app,SessionView view)=>typeof(BoopyApp).GetMethod("Apply",Flags)!.Invoke(app,new object[]{view});
        private static void Set(object target,string field,object? value)=>target.GetType().GetField(field,Flags)!.SetValue(target,value);
        private static object? Get(object target,string field)=>target.GetType().GetField(field,Flags)!.GetValue(target);
        private sealed class ChoiceValidationException:Exception { public ChoiceValidationException(string message):base(message){} }
        private static void Require(bool value,string message){if(!value)throw new ChoiceValidationException(message);}
    }
}
