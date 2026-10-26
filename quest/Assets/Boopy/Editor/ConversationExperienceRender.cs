#nullable enable
using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using TMPro;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>Synthetic production render, never a wearer, provider or timing measurement.</summary>
    public static class ConversationExperienceRender
    {
        private static readonly string Output = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "Builds", "adaptive-conversation"));
        private const BindingFlags Flags = BindingFlags.Instance | BindingFlags.NonPublic;
        public static void Render()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single); ScriptCoverage.Install();
            Directory.CreateDirectory(Output); Directory.CreateDirectory(Path.Combine(Output, "sequence"));
            var root = new GameObject("Synthetic conversation production render");
            var privateDirectory = Path.Combine(Path.GetTempPath(), "boopy-render-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(privateDirectory);
            var context = SynchronizationContext.Current; SynchronizationContext.SetSynchronizationContext(null);
            RenderTexture? target = null; Texture2D? pixels = null; var previous = RenderTexture.active;
            try
            {
                var head = new GameObject("Fixed synthetic viewer").transform; head.SetParent(root.transform, false);
                var camera = head.gameObject.AddComponent<Camera>(); camera.fieldOfView = 58; camera.nearClipPlane = .05f; camera.farClipPlane = 10;
                camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = new Color(.12f, .13f, .14f); camera.allowHDR = false; camera.allowMSAA = false;
                RenderSettings.ambientLight = new Color(.45f, .45f, .45f);
                var light = new GameObject("Fixed studio light").AddComponent<Light>(); light.transform.SetParent(root.transform); light.type = LightType.Directional; light.intensity = 1; light.transform.rotation = Quaternion.Euler(35,-30,0);
                Prop(root.transform, "Synthetic floor", new Vector3(0,-.65f,2.5f), new Vector3(5,.10f,5), new Color(.26f,.27f,.28f));
                Prop(root.transform, "Synthetic stone marker", new Vector3(-.34f,-.05f,2), new Vector3(.56f,.70f,.05f), new Color(.54f,.53f,.50f));
                Prop(root.transform, "Synthetic display board", new Vector3(-1.20f,.12f,2.8f), new Vector3(.70f,.85f,.05f), new Color(.24f,.25f,.25f));
                var words = SpatialTheme.Text(root.transform,"Authored synthetic display",.16f,SpatialTheme.Ivory); words.text = "SYNTHETIC\nTRAIL MARKER"; words.rectTransform.sizeDelta = new Vector2(.62f,.28f); words.transform.position = new Vector3(-1.20f,.12f,2.76f);
                var room = root.AddComponent<RoomCamera>(); var scene = SessionScene.Create(root.transform,room,head);
                var console = ContextConsole.Create(root.transform,head); scene.MoveConsole(console,new Vector3(.42f,.08f,1));
                var caption = DialogueStrip.Create(root.transform,head); console.DockDialogue(caption);
                var app = root.AddComponent<BoopyApp>(); var handler = new FixtureTransport(); using var client = new ServiceClient(handler:handler);
                Set(app,"client",client); Set(app,"scene",scene); Set(app,"console",console); Set(app,"dialogue",caption); Set(app,"room",room); Set(app,"head",head);
                Set(app,"status",StatusLine.Create(root.transform,head,Visuals.Quad())); Set(app,"recoveryStore",new CaptureRecoveryStore(Path.Combine(privateDirectory,"pending-id")));
                target = new RenderTexture(1600,900,24); target.Create(); pixels = new Texture2D(1600,900,TextureFormat.RGB24,false); camera.targetTexture = target;
                var frame = 0;
                void Stage(string name)
                {
                    for (var index=0; index<12; index++)
                    {
                        foreach (var text in root.GetComponentsInChildren<TextMeshPro>()) text.ForceMeshUpdate();
                        if (scene.TryGetActiveAnchor(out var anchor)) console.AttendTo(anchor,true);
                        console.RefreshVisuals(1f/24f); caption.RefreshVisuals(1f/24f);
                        camera.Render(); RenderTexture.active = target; pixels.ReadPixels(new Rect(0,0,1600,900),0,0); pixels.Apply();
                        Save(pixels,Path.Combine(Output,"sequence",$"frame-{frame++:000}.png"));
                    }
                    Save(pixels,Path.Combine(Output,name+"-wide.png"));
                    var crop = new Texture2D(800,700,TextureFormat.RGB24,false);
                    try { crop.SetPixels(pixels.GetPixels(800,100,800,700)); crop.Apply(); Save(crop,Path.Combine(Output,name+"-close.png")); }
                    finally { UnityEngine.Object.DestroyImmediate(crop); }
                }
                console.ShowCapture(); Stage("01-idle");
                console.ShowListening(); caption.Show(DialogueStage.Listening,"Listening…\nLet go when you’re done."); Stage("02-listening");
                Set(app,"pending",Snapshot()); Set(app,"pendingEvidence",new EvidenceTurn(false));
                var send = (Task)typeof(BoopyApp).GetMethod("Send",Flags)!.Invoke(app,new object[] { SpeechValidation.SyntheticWav() })!;
                Require(!send.IsCompleted && handler.Starts==1,"Pending render is not an actual outstanding synthetic request."); Stage("03-pending");
                handler.Start.SetResult(Reply(handler.View)); send.GetAwaiter().GetResult();
                Require(caption.FullText==handler.View.Dialogue!.Text && scene.TryGetActiveAnchor(out _),"Returned reply/source was not applied."); Stage("04-answer");
                Require(console.SuggestedAction(ConsoleAction.FollowUpOne) != null, "Actual generated question is unavailable.");
                Set(app,"inputAllowed",true);
                ((Task)typeof(BoopyApp).GetMethod("FollowUp",Flags)!.Invoke(app,new object[] { ConsoleAction.FollowUpOne })!).GetAwaiter().GetResult();
                Require(handler.FollowUps == 1 && caption.FullText == "The synthetic record does not identify who placed it.", "Selected generated question did not use production follow-up.");
                Stage("05-followup");
                console.Activate(ConsoleAction.Options); Stage("06-context");
                console.Activate(ConsoleAction.Review); Stage("07-source");
                console.Activate(ConsoleAction.Review); console.Activate(ConsoleAction.Options); console.Activate(ConsoleAction.PrepareSave); Stage("08-prepare-muse");
                ((Task)typeof(BoopyApp).GetMethod("Commit",Flags)!.Invoke(app,Array.Empty<object>())!).GetAwaiter().GetResult(); scene.Clear(); Stage("09-local-receipt");
                File.WriteAllText(Path.Combine(Output,"README.txt"),"Synthetic production Unity render. Fixed camera/world/lighting throughout. Listening is a widget fixture, not microphone evidence. Pending is an actual unresolved fake HTTP task; answer/follow-up/commit are returned synthetic DTOs through production Send/FollowUp/Commit. Question buttons are synthetic model proposals bound to recorded source identity; selecting one creates a follow-up without microphone capture. Receipt renders the settled production Scene.Clear state (not a measured wrist/gather animation). No provider result, private capture, live audio or wearer timing claim. Source uses recorded synthetic pose/coarse depth and an approximate box, never segmentation. 108 sequence frames at nominal24fps advance production UI Refresh; phase durations are presentation fixtures, not measured request latency. Close images are identical-view crops, not changed camera poses.\n");
                Debug.Log("Boopy conversation experience renders: "+Output);
            }
            finally
            {
                SynchronizationContext.SetSynchronizationContext(context); RenderTexture.active=previous;
                if(pixels!=null) UnityEngine.Object.DestroyImmediate(pixels); if(target!=null) UnityEngine.Object.DestroyImmediate(target);
                UnityEngine.Object.DestroyImmediate(root); Directory.Delete(privateDirectory,true);
            }
        }
        private static void Save(Texture2D pixels,string path)=>File.WriteAllBytes(path,pixels.EncodeToPNG());
        private static void Prop(Transform root,string name,Vector3 position,Vector3 size,Color color)
        {
            var go=GameObject.CreatePrimitive(PrimitiveType.Cube); go.name=name; go.transform.SetParent(root,false); go.transform.position=position; go.transform.localScale=size;
            var material=new Material(Shader.Find("Standard")); material.color=color; go.GetComponent<MeshRenderer>().sharedMaterial=material; UnityEngine.Object.DestroyImmediate(go.GetComponent<Collider>());
        }
        private static Snapshot Snapshot()
        {
            var texture=new Texture2D(80,80);
            var colors=Enumerable.Repeat(new Color(.22f,.23f,.24f),80*80).ToArray();
            for(var y=29;y<53;y++) for(var x=27;x<40;x++) colors[y*80+x]=new Color(.54f,.53f,.50f);
            texture.SetPixels(colors); texture.Apply(); var bytes=texture.EncodeToJPG(); UnityEngine.Object.DestroyImmediate(texture);
            return new Snapshot(bytes,80,80,new DateTime(1970,1,1,12,0,0,DateTimeKind.Utc),new Pose(Vector3.zero,Quaternion.identity),new DepthGrid {Columns=1,Rows=1,Meters=new float?[] {2f}},new CameraInfo {FocalLength=new float[] {40,40},PrincipalPoint=new float[] {40,40},SensorResolution=new int[] {80,80}});
        }
        private sealed class FixtureTransport:HttpMessageHandler
        {
            public readonly TaskCompletionSource<HttpResponseMessage> Start=new TaskCompletionSource<HttpResponseMessage>(); public int Starts, FollowUps; public SessionView View=Fixture();
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellation)
            {
                if(request.Method==HttpMethod.Get) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent("{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}}")});
                if(request.RequestUri!.AbsolutePath=="/v1/sessions"){Starts++;return Start.Task;}
                if(request.RequestUri.AbsolutePath.EndsWith("/utterances"))
                {
                    var payload = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
                    Require(payload.Contains("question-origin") && payload.Contains("Who placed this marker?"), "Follow-up omitted selected question provenance.");
                    FollowUps++;
                    View.Utterances.Add(new UtteranceRef {Id="synthetic-followup",Text="Who placed this marker?"});
                    View.Dialogue = new DialogueView {Speaker="boopy",UtteranceId="synthetic-followup",At="1970-01-01T12:00:01Z",Text="The synthetic record does not identify who placed it."};
                    View.Dialogue.Actions.Add(new ContextualAction {Id="question-detail",Question="What detail would help identify it?",TargetItemId="synthetic-stone",ObservationId="synthetic-observation"});
                    return Task.FromResult(Reply(View));
                }
                Require(request.RequestUri.AbsolutePath.EndsWith("/commit"),"Unexpected synthetic transport mutation.");
                View.State="committed"; View.Committed=new Committed {PackageId="ctx_synthetic_render",Summary="Synthetic selected source and exact account"}; return Task.FromResult(Reply(View));
            }
        }
        private static SessionView Fixture()
        {
            var view=new SessionView {Id="synthetic-render-session",State="review",ReferentId="synthetic-stone",Model=new ModelRef {Provider="fixture",Id="synthetic"},Dialogue=new DialogueView {Speaker="boopy",UtteranceId="synthetic-question",At="1970-01-01T12:00:00Z",Text="It looks like a stone marker."}};
            view.Dialogue!.Actions.Add(new ContextualAction {Id="question-origin",Question="Who placed this marker?",TargetItemId="synthetic-stone",ObservationId="synthetic-observation"});
            view.Dialogue.Actions.Add(new ContextualAction {Id="question-read",Question="What does the nearby sign say?",ObservationId="synthetic-observation"});
            view.Utterances.Add(new UtteranceRef {Id="synthetic-question",Text="What is this marker?"}); view.Observations.Add(new ObservationRef {Id="synthetic-observation"});
            view.Items.Add(new Item {Id="synthetic-stone",Kind="object",Label="Stone marker",Statement="It may be a stone marker.",Note="This marked stone reminds me of our mountain walk.",Status="proposed",Confidence=.6f,Grounding=new Grounding {Kind="box",ObservationId="synthetic-observation",Box=new Box2 {X0=.34f,Y0=.42f,X1=.49f,Y1=.605f}}}); return view;
        }
        private static HttpResponseMessage Reply(SessionView view)=>new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(Wire.Write(view))};
        private static void Set(object target,string name,object? value)=>target.GetType().GetField(name,Flags)!.SetValue(target,value);
        private static void Require(bool condition,string message){if(!condition)throw new InvalidOperationException(message);}
    }
}
