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
    /// <summary>Production turn lifecycle with synthetic HTTP/audio/pose; no wearer or provider claim.</summary>
    public static class FirstTurnExperienceValidation
    {
        private const BindingFlags Flags = BindingFlags.Instance | BindingFlags.NonPublic;
        public static void Validate()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single); HangulFont.Install();
            var root = new GameObject("Synthetic first turn experience");
            var directory = Path.Combine(Path.GetTempPath(), "boopy-first-turn-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory);
            var hadVoicePreference = PlayerPrefs.HasKey("Boopy.Voice"); var savedVoicePreference = PlayerPrefs.GetInt("Boopy.Voice", 1);
            PlayerPrefs.DeleteKey("Boopy.Voice");
            var context = SynchronizationContext.Current; SynchronizationContext.SetSynchronizationContext(null);
            try
            {
                var head = new GameObject("Synthetic eyes").transform; head.SetParent(root.transform);
                OpeningGreetingGuards(root, head);
                OpeningOrientation(root, head);
                SyntheticWaitSequence(root, head);
                var room = root.AddComponent<RoomCamera>(); var scene = SessionScene.Create(root.transform, room, head);
                var console = ContextConsole.Create(root.transform, head); console.SetReducedMotion(true); scene.PlaceConsole(console);
                typeof(ContextConsole).GetMethod("LoadVoicePreference",Flags)!.Invoke(console,null);
                var caption = DialogueStrip.Create(root.transform, head); console.DockDialogue(caption);
                var playback = SpeechPlayback.Create(root.transform);
                var app = root.AddComponent<BoopyApp>();
                var view = View(); var handler = new DelayedTurn(view); using var client = new ServiceClient(handler: handler);
                Set(app, "client", client); Set(app, "scene", scene); Set(app, "room", room); Set(app, "head", head);
                Set(app, "console", console); Set(app, "dialogue", caption); Set(app, "speechPlayback", playback);
                Set(app, "status", StatusLine.Create(root.transform, head, Visuals.Quad()));
                Set(app, "recoveryStore", new CaptureRecoveryStore(Path.Combine(directory, "pending-id")));
                Set(app, "handoffRecoveryStore", new HandoffRecoveryStore(Path.Combine(directory, "preparation-identity")));
                Require(!console.VoiceEnabled, "Voice capability is invented before a response.");
                var anchor = typeof(SessionScene).GetMethod("AnchorOf", Flags)!;
                Require(anchor.Invoke(scene, new object[] { view.Items[0] }) == null, "Missing captured pose invented a source anchor.");
                var camera = new CameraInfo { FocalLength = new[] { 100f,100f }, PrincipalPoint = new[] { 64f,48f }, SensorResolution = new[] { 128,96 } };
                var snapshot = new Snapshot(SyntheticJpeg(),128,96,DateTime.Parse("1970-01-01T12:00:00Z"),new Pose(Vector3.zero,Quaternion.identity),new DepthGrid { Columns=1,Rows=1,Meters=new float?[] { 1f } },camera);
                Set(app,"pending",snapshot); Set(app,"pendingEvidence",new EvidenceTurn(false));
                var sending = (Task)typeof(BoopyApp).GetMethod("Send",Flags)!.Invoke(app,new object[] { SpeechValidation.SyntheticWav() })!;
                Require(!sending.IsCompleted && handler.Starts == 1 && handler.Speeches == 0, "First turn did not wait for an actual response before speech.");
                Require(caption.Stage == DialogueStage.Working && ThinkingPhrases.All.Contains(caption.FullText), "Delayed request lacks Boopy's thinking line.");
                handler.Start.SetResult(Json(view)); sending.GetAwaiter().GetResult();
                Require(caption.FullText == view.Dialogue!.Text && caption.Stage == DialogueStage.Response, "Actual returned journaled reply changed in caption.");
                Require(anchor.Invoke(scene,new object[] { view.Items[0] }) is Vector3 point && point.z > .8f && point.z < 1.2f, "Valid recorded source pose failed referent anchoring.");
                Require(console.VoiceEnabled, "Available first reply did not enable owner-requested default voice.");
                Require(scene.TryGetActiveAnchor(out var activeAnchor) && activeAnchor.z > .8f, "Presented referent lacks its recorded-source attention anchor.");
                Require(view.Items[0].Status == "proposed", "First reply implicitly confirmed model claim.");
                // Speech lifecycle interruption is covered by SpeechValidation; this validates first-result routing.
                Require(handler.Speeches == 1 && playback.HasClip, "First available returned reply was not routed to audio.");
                ((Task)typeof(BoopyApp).GetMethod("Commit",Flags)!.Invoke(app,Array.Empty<object>())!).GetAwaiter().GetResult();
                Require(handler.Commits == 1 && caption.Stage == DialogueStage.LocalSave && caption.FullText == "Prepared on your Mac. Not sent yet." && handler.Prepares == 1 && !playback.HasClip, "Local save lost receipt or retained prior speech.");
                console.Activate(ConsoleAction.Speech);
                Require(!console.VoiceEnabled, "Explicit mute did not disable voice.");
                typeof(ContextConsole).GetMethod("SaveVoicePreference",Flags)!.Invoke(console,null);
                var recreated = ContextConsole.Create(root.transform,head);
                typeof(ContextConsole).GetMethod("LoadVoicePreference",Flags)!.Invoke(recreated,null);
                recreated.Render(view);
                Require(!recreated.VoiceEnabled && handler.Speeches == 1, "Persisted explicit mute was lost on console recreation.");
                UnityEngine.Object.DestroyImmediate(recreated.gameObject);
                console.Render(view); Require(!console.VoiceEnabled, "New returned view silently overrides explicit mute.");
                console.Render(new SessionView { Id=view.Id,State="committed",SpeechOutputAvailable=true,Committed=new Committed {PackageId="ctx_syntheticfirst"} });
                console.Activate(ConsoleAction.Handoff);
                Require(console.GetComponentsInChildren<SpatialSurface>(true).Single(surface=>surface.name=="Evidence instrument").BodyText.Contains("ctx_syntheticfirst"), "Local receipt exposes the wrong export package.");
                using (var preparation = new CancellationTokenSource())
                {
                    Set(app,"capturePreparation",preparation); Set(app,"captureGeneration",7); Set(app,"captureReady",true); Set(app,"pendingEvidence",new EvidenceTurn(false));
                    typeof(BoopyApp).GetMethod("OnFocusLost",Flags)!.Invoke(app,null);
                    Require(preparation.IsCancellationRequested && (int)typeof(BoopyApp).GetField("captureGeneration",Flags)!.GetValue(app)! > 7 && !(bool)typeof(BoopyApp).GetField("captureReady",Flags)!.GetValue(app)! && typeof(BoopyApp).GetField("pendingEvidence",Flags)!.GetValue(app) == null,
                        "Focus loss leaves a deferred capture ready or capable of applying an old generation.");
                    typeof(BoopyApp).GetField("capturePreparation",Flags)!.SetValue(app,null);
                }
                Debug.Log("Boopy first-turn production lifecycle passed (synthetic HTTP/audio/source; audibility and wearer alignment unverified).");
            }
            finally { if(hadVoicePreference) PlayerPrefs.SetInt("Boopy.Voice",savedVoicePreference); else PlayerPrefs.DeleteKey("Boopy.Voice"); PlayerPrefs.Save(); SynchronizationContext.SetSynchronizationContext(context); UnityEngine.Object.DestroyImmediate(root); Directory.Delete(directory,true); }
        }
        private static void OpeningGreetingGuards(GameObject root, Transform eyes)
        {
            var console=ContextConsole.Create(root.transform,eyes);
            try
            {
                Require(!console.TryGreetOpening(),"Unverified connection triggered the opening greeting.");
                console.SetConnectionStatus("connected",false);
                var header=console.GetComponentsInChildren<SpatialSurface>(true).Single(surface=>surface.name=="Intent instrument");
                Set(header,"amount",.5f);
                Require(!console.TryGreetOpening(),"Greeting fired before the actual header settled.");
                Set(header,"amount",1f);
                foreach(var field in new[] {"captureRecovery","handoffRecordAvailable","handoffRecoveryOffered","handoffStorageFailed","dialogueVisible","controlsOnly","busy"})
                {
                    Set(console,field,true);Require(!console.TryGreetOpening(),"Opening greeting interrupted "+field);Set(console,field,false);
                }
                Set(console,"view",View());Require(!console.TryGreetOpening(),"Existing conversation repeated opening greeting.");Set(console,"view",null!);
                Set(console,"mode","processing");Require(!console.TryGreetOpening(),"Processing triggered opening greeting.");Set(console,"mode","capture");
                header.gameObject.SetActive(false);Require(!console.TryGreetOpening(),"Hidden header consumed the greeting.");header.gameObject.SetActive(true);
                console.gameObject.SetActive(false);Require(!console.TryGreetOpening(),"Disabled console consumed the greeting.");console.gameObject.SetActive(true);
                Require(console.TryGreetOpening(),"The genuinely connected visible opening failed to greet after blocked attempts.");
                Require(!console.TryGreetOpening(),"Opening greeting repeated on the next update.");
                console.SetConnectionStatus("checking",false);console.SetConnectionStatus("connected",false);
                console.ShowCapture();Set(header,"amount",1f);
                Require(!console.TryGreetOpening(),"Health/focus-style refresh replayed a consumed greeting.");
                console.Activate(ConsoleAction.Settings);console.Activate(ConsoleAction.Settings);Set(header,"amount",1f);
                Require(!console.TryGreetOpening(),"Closing Settings replayed a consumed greeting.");
            }
            finally {UnityEngine.Object.DestroyImmediate(console.gameObject);}
        }
        private static void OpeningOrientation(GameObject root, Transform eyes)
        {
            var console = ContextConsole.Create(root.transform, eyes);
            var camera = eyes.gameObject.AddComponent<Camera>();
            camera.fieldOfView = 64; camera.aspect = 1.6f; camera.nearClipPlane = .05f;
            camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = new Color(.15f,.17f,.19f);
            try
            {
                console.SetReducedMotion(true); console.SetConnectionStatus("connected", false);
                var header = console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Intent instrument");
                var expected = "Hi, I’m Boopy. Show me what you want kept.";
                Require(header.BodyText == expected, "Idle opening changed the single conversational greeting.");
                var title = header.GetComponentsInChildren<TextMeshPro>(true).Single(text => text.name == "Title");
                Require(title.text == "", "Connected opening adds a separate headline above the character’s utterance.");
                foreach (var large in new[] { false, true })
                {
                    if ((console.ComfortScale > 1f) != large) console.Activate(ConsoleAction.Size);
                    console.Place(new Vector3(0,-.08f,1.2f)); console.RefreshVisuals(1f);
                    foreach (var text in console.GetComponentsInChildren<TextMeshPro>())
                    {
                        text.ForceMeshUpdate(true,true);
                        Require(!text.isTextOverflowing, "Opening text overflow: " + text.name);
                        foreach (var glyph in text.textInfo.characterInfo.Take(text.textInfo.characterCount).Where(glyph => glyph.isVisible))
                        foreach (var corner in new[] { glyph.bottomLeft, glyph.topRight })
                        {
                            var point = camera.WorldToViewportPoint(text.transform.TransformPoint(corner));
                            Require(point.z > 0 && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1,
                                "Opening glyph leaves the synthetic viewport: " + text.name);
                        }
                    }
                    var target = new RenderTexture(1200,750,24); target.Create();
                    var pixels = new Texture2D(1200,750,TextureFormat.RGB24,false); var prior = RenderTexture.active;
                    try
                    {
                        camera.targetTexture=target; camera.Render(); RenderTexture.active=target;
                        pixels.ReadPixels(new Rect(0,0,1200,750),0,0); pixels.Apply();
                        var path=Path.Combine(Path.GetTempPath(), "boopy-purpose-opening-"+(large ? "large" : "standard")+".png");
                        File.WriteAllBytes(path,pixels.EncodeToPNG()); Debug.Log("Boopy purpose opening synthetic render: "+path);
                    }
                    finally { camera.targetTexture=null; RenderTexture.active=prior; UnityEngine.Object.DestroyImmediate(pixels); UnityEngine.Object.DestroyImmediate(target); }
                }
                console.Render(View());
                Require(header.BodyText == "Talk to continue." && title.text == "",
                    "Active conversation repeated the character’s first-turn greeting.");
                console.Activate(ConsoleAction.Options);
                var context = console.GetComponentsInChildren<SpatialSurface>(true).Single(surface=>surface.name=="Comfort options");
                Require(context.BodyText.Contains("Keep it on your Mac. Continue online when ready."),
                    "Opened Context lacks the concrete manual next step.");
            }
            finally { UnityEngine.Object.DestroyImmediate(console.gameObject); UnityEngine.Object.DestroyImmediate(camera); }
        }
        private static void SyntheticWaitSequence(GameObject parent, Transform eyes)
        {
            foreach (var large in new[] { false, true })
            foreach (var reduced in new[] { false, true })
            {
                var root = new GameObject("Synthetic actual-stage and voice-wait sequence"); root.transform.SetParent(parent.transform,false);
                var console = ContextConsole.Create(root.transform,eyes);
                var caption = DialogueStrip.Create(root.transform,eyes); console.DockDialogue(caption);
                var playback = SpeechPlayback.Create(root.transform);
                var app = root.AddComponent<BoopyApp>();
                var handler = new DelayedVoice(); using var client = new ServiceClient(handler:handler);
                var view = View(); view.Dialogue!.Text = "This recorded object may be a painting.";
                var camera = eyes.gameObject.AddComponent<Camera>();
                camera.fieldOfView=64; camera.aspect=1.6f; camera.nearClipPlane=.05f;
                camera.clearFlags=CameraClearFlags.SolidColor; camera.backgroundColor=new Color(.15f,.17f,.19f);
                try
                {
                    console.SetReducedMotion(reduced); if ((console.ComfortScale>1f)!=large) console.Activate(ConsoleAction.Size);
                    caption.SetComfort(console.ComfortScale,reduced);
                    Set(app,"console",console); Set(app,"dialogue",caption); Set(app,"client",client);
                    Set(app,"session",view); Set(app,"speechPlayback",playback); Set(app,"inputAllowed",true);
                    VoiceStatusStages(console,caption);
                    var variant=(large ? "large" : "standard")+"-"+(reduced ? "reduced" : "motion");
                    using (var request=new CancellationTokenSource())
                    {
                        Set(app,"captureRequest",request); Set(app,"busy",true);
                        console.ShowProcessing(); caption.ShowThinking(new ThinkingPhrases(5)); caption.SetCancelableWait(true);
                        var header=(SpatialSurface)typeof(ContextConsole).GetField("header",Flags)!.GetValue(console)!;
                        foreach (var stage in new[] {"transcribing","reading-text","interpreting","refining-geometry"})
                        {
                            var progress=(TurnProgress)Activator.CreateInstance(typeof(TurnProgress),Flags,null,new object[]{stage},null)!;
                            typeof(BoopyApp).GetMethod("ApplyTurnProgress",Flags)!.Invoke(app,new object?[]{request,view.Id,progress});
                            // The actual stage reaches the console's processing line; the strip keeps Boopy's thinking phrases.
                            Require(caption.Stage==DialogueStage.Working && ThinkingPhrases.All.Contains(caption.FullText) && header.BodyText==progress.Words,
                                "Synthetic actual-stage event replaced the thinking line or missed the processing line: "+stage);
                            RenderWait(console,caption,camera,"stage-"+stage+"-"+variant);
                        }
                        request.Cancel();
                        var stopped=caption.FullText;
                        var late=(TurnProgress)Activator.CreateInstance(typeof(TurnProgress),Flags,null,new object[]{"interpreting"},null)!;
                        typeof(BoopyApp).GetMethod("ApplyTurnProgress",Flags)!.Invoke(app,new object?[]{request,view.Id,late});
                        Require(caption.FullText==stopped,"Cancelled stage revived the caption.");
                        Set(app,"captureRequest",null); Set(app,"busy",false);
                    }
                    console.Render(view); caption.SetCancelableWait(false); caption.Show(DialogueStage.Response,view.Dialogue.Text);
                    var pending=(Task)typeof(BoopyApp).GetMethod("Speak",Flags)!.Invoke(app,new object[]{view})!;
                    var label=caption.GetComponentsInChildren<TextMeshPro>(true).Single(text=>text.name=="Actual speaker and state");
                    Require(!pending.IsCompleted && handler.SpeechCalls==1 && label.gameObject.activeSelf
                        && caption.SpeakerText=="Preparing voice…" && caption.FullText==view.Dialogue.Text && caption.Stage==DialogueStage.Response,
                        "Actual held speech request concealed the exact returned answer or lacked its wait label.");
                    Require(!(bool)typeof(BoopyApp).GetField("busy",Flags)!.GetValue(app)!,"Voice preparation blocked Talk.");
                    RenderWait(console,caption,camera,"voice-pending-"+variant);
                    var talk=console.GetComponentsInChildren<SpatialAction>(true).Single(action=>action.Action==ConsoleAction.Talk);
                    Require(talk.gameObject.activeInHierarchy && talk.GetComponent<BoxCollider>().enabled,
                        "Actual Talk control is unavailable during pending voice: "+variant);
                    Physics.SyncTransforms();
                    Require(console.CanRelease(ConsoleAction.Talk,new Ray(eyes.position,talk.transform.position-eyes.position)),
                        "Actual Talk hit target is obstructed during pending voice: "+variant);
                    typeof(BoopyApp).GetMethod("StopSpeech",Flags)!.Invoke(app,null);
                    Require(caption.SpeakerText=="Boopy" && !playback.HasClip && caption.FullText==view.Dialogue.Text,
                        "Stop failed to clear voice preparation while retaining the exact answer.");
                    handler.Reply.SetResult(Json(new SpeechOutputResponse {SessionId=view.Id,UtteranceId=view.Dialogue.UtteranceId,
                        ResponseAt=view.Dialogue.At,Speaker="boopy",MimeType="audio/wav",Wav=Convert.ToBase64String(SpeechValidation.SyntheticWav())}));
                    pending.GetAwaiter().GetResult();
                    Require(caption.SpeakerText=="Boopy" && !playback.HasClip && caption.FullText==view.Dialogue.Text && handler.SpeechCalls==1,
                        "Late cancelled voice revived playback/status or repeated synthesis.");
                }
                finally { handler.Reply.TrySetCanceled(); UnityEngine.Object.DestroyImmediate(root); UnityEngine.Object.DestroyImmediate(camera); }
            }
        }
        private static void VoiceStatusStages(ContextConsole console, DialogueStrip caption)
        {
            var text=string.Join(" ",Enumerable.Repeat("Synthetic recorded words remain exactly here.",12));
            foreach(var stage in new[] {DialogueStage.Response,DialogueStage.Clarification,DialogueStage.FreshView,DialogueStage.LocalSave})
            {
                caption.Show(stage,text);
                Require(caption.PageCount>1,"Voice stage fixture did not exercise pagination."); caption.NextPage();
                var visible=caption.VisibleText;var speaker=caption.SpeakerText;var count=caption.PageCount;
                console.SetVoicePreparing(true);
                Require(caption.SpeakerText.StartsWith("Preparing voice…",StringComparison.Ordinal)
                    && caption.FullText==text && caption.VisibleText==visible && caption.PageCount==count && caption.Stage==stage,
                    "Pending voice changed the exact caption/page or omitted status for "+stage);
                console.SetVoicePreparing(false);
                Require(caption.SpeakerText==speaker && caption.FullText==text && caption.VisibleText==visible && caption.PageCount==count,
                    "Ending voice wait failed to restore exact status/page for "+stage);
            }
            foreach(var stage in new[] {DialogueStage.Listening,DialogueStage.Working,DialogueStage.Error})
            {
                caption.Show(stage,"Synthetic non-voice state.");var speaker=caption.SpeakerText;
                caption.SetVoicePreparing(true);
                Require(caption.SpeakerText==speaker,"Voice wait was invented for "+stage);
                caption.SetVoicePreparing(false);
            }
        }
        private static void RenderWait(ContextConsole console, DialogueStrip caption, Camera camera, string name)
        {
            console.Place(new Vector3(0,-.08f,1.2f)); console.RefreshVisuals(1f); caption.RefreshVisuals(1f);
            var target=new RenderTexture(1200,750,24); target.Create(); var image=new Texture2D(1200,750,TextureFormat.RGB24,false);
            var prior=RenderTexture.active;
            try
            {
                camera.targetTexture=target; camera.aspect=1.6f;
                foreach(var text in console.GetComponentsInChildren<TextMeshPro>()) text.ForceMeshUpdate(true,true);
                camera.Render(); RenderTexture.active=target; image.ReadPixels(new Rect(0,0,1200,750),0,0); image.Apply();
                var path=Path.Combine(Path.GetTempPath(),"boopy-synthetic-wait-"+name+".png");File.WriteAllBytes(path,image.EncodeToPNG());
                Debug.Log("Boopy synthetic stage/voice wait render: "+path);
                var labels=console.GetComponentsInChildren<TextMeshPro>();
                var voice=labels.FirstOrDefault(text=>text.name=="Actual speaker and state" && text.text.StartsWith("Preparing voice",StringComparison.Ordinal));
                var answer=labels.FirstOrDefault(text=>text.name=="Actual response");
                if(voice!=null && answer!=null && voice.gameObject.activeInHierarchy)
                {
                    Debug.Log("Boopy synthetic voice status metrics: rect="+voice.rectTransform.sizeDelta+", preferred="+voice.GetPreferredValues(voice.text,voice.rectTransform.sizeDelta.x,Mathf.Infinity)+", font="+voice.fontSize);
                    Require(!WaitGlyphArea(voice,camera).Overlaps(WaitGlyphArea(answer,camera)),
                        "Voice preparation label overlaps the exact answer: "+name);
                }
                foreach(var text in console.GetComponentsInChildren<TextMeshPro>().Where(text=>text.GetComponent<MeshRenderer>().enabled))
                {
                    Require(!text.isTextOverflowing,"Synthetic pending text overflow: "+name+" / "+text.name);
                    foreach(var glyph in text.textInfo.characterInfo.Take(text.textInfo.characterCount).Where(glyph=>glyph.isVisible))
                    foreach(var corner in new[] {glyph.bottomLeft,glyph.topRight})
                    {
                        var point=camera.WorldToViewportPoint(text.transform.TransformPoint(corner));
                        Require(point.z>0 && point.x>=0 && point.x<=1 && point.y>=0 && point.y<=1,
                            "Synthetic pending glyph leaves viewport: "+name+" / "+text.name);
                    }
                }
            }
            finally { camera.targetTexture=null;RenderTexture.active=prior;UnityEngine.Object.DestroyImmediate(image);UnityEngine.Object.DestroyImmediate(target); }
        }
        private static Rect WaitGlyphArea(TextMeshPro text, Camera camera)
        {
            var points=text.textInfo.characterInfo.Take(text.textInfo.characterCount).Where(glyph=>glyph.isVisible)
                .SelectMany(glyph=>new[] {glyph.bottomLeft,glyph.topRight})
                .Select(point=>camera.WorldToViewportPoint(text.transform.TransformPoint(point))).ToArray();
            Require(points.Length>0,"Synthetic wait text has no visible glyph geometry: "+text.name);
            return Rect.MinMaxRect(points.Min(point=>point.x),points.Min(point=>point.y),points.Max(point=>point.x),points.Max(point=>point.y));
        }
        private sealed class DelayedVoice : HttpMessageHandler
        {
            public readonly TaskCompletionSource<HttpResponseMessage> Reply=new TaskCompletionSource<HttpResponseMessage>();
            public int SpeechCalls;
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancel)
            {
                if(request.Method==HttpMethod.Get) return Task.FromResult(Json(new {ok=true,service="boopy",interpreter=new {provider="fixture",model="synthetic"}}));
                Require(request.RequestUri!.AbsolutePath.EndsWith("/speech",StringComparison.Ordinal),"Synthetic voice fixture touched another mutation.");
                SpeechCalls++;return Reply.Task;
            }
        }
        private static byte[] SyntheticJpeg()
        {
            var image = new Texture2D(128,96,TextureFormat.RGB24,false);
            try { image.SetPixels(Enumerable.Repeat(new Color(.5f,.4f,.7f),128*96).ToArray()); image.Apply(); return image.EncodeToJPG(); }
            finally { UnityEngine.Object.DestroyImmediate(image); }
        }
        private static SessionView View()
        {
            var view = new SessionView { Id="synthetic-first",State="review",ReferentId="synthetic-item",SpeechOutputAvailable=true,Model=new ModelRef {Provider="fixture",Id="synthetic"},Dialogue=new DialogueView {Speaker="boopy",UtteranceId="synthetic-turn",At="1970-01-01T12:00:00Z",Text="This recorded object may be a painting."} };
            view.Utterances.Add(new UtteranceRef {Id="synthetic-turn",Text="What is this?",Kind="ask"}); view.Observations.Add(new ObservationRef {Id="synthetic-observation",CapturedAt="1970-01-01T12:00:00Z"});
            view.Items.Add(new Item {Id="synthetic-item",Kind="object",Label="Synthetic painting",Statement="A proposed painting.",Origin="model",Status="proposed",Confidence=.4f,Grounding=new Grounding {Kind="box",ObservationId="synthetic-observation",Box=new Box2 {X0=.4f,Y0=.4f,X1=.6f,Y1=.6f}}}); return view;
        }
        private sealed class DelayedTurn : HttpMessageHandler
        {
            public readonly TaskCompletionSource<HttpResponseMessage> Start = new TaskCompletionSource<HttpResponseMessage>();
            private readonly SessionView view; public int Starts,Speeches,Commits,Prepares;
            public DelayedTurn(SessionView view) { this.view=view; }
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellationToken)
            {
                if(request.RequestUri!.AbsolutePath.EndsWith("/handoff-preparations", StringComparison.Ordinal))
                {
                    Prepares++; var selection = Wire.Read<HandoffRequest>(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
                    Require(selection.PackageId == "ctx_syntheticfirst" && selection.Memory == null && selection.References == null, "First handoff broadened explicit package scope.");
                    return Task.FromResult(Json(HandoffPreparationValidation.Completed(selection,view.Id)));
                }
                if(request.Method==HttpMethod.Get) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) {Content=new StringContent("{\"ok\":true,\"service\":\"boopy\",\"interpreter\":{\"provider\":\"fixture\",\"model\":\"synthetic\"}}")});
                if(request.RequestUri!.AbsolutePath.EndsWith("/speech")) { Speeches++; return Task.FromResult(Json(new SpeechOutputResponse {SessionId=view.Id,UtteranceId=view.Dialogue!.UtteranceId,ResponseAt=view.Dialogue.At,Speaker="boopy",MimeType="audio/wav",Wav=Convert.ToBase64String(SpeechValidation.SyntheticWav())})); }
                if(request.RequestUri.AbsolutePath.EndsWith("/commit")) { Commits++; var saved=Wire.Read<SessionView>(Wire.Write(view));saved.State="committed";saved.Committed=new Committed {PackageId="ctx_syntheticfirst"};return Task.FromResult(Json(saved)); }
                Starts++; return Start.Task;
            }
        }
        private static HttpResponseMessage Json(object value)=>new HttpResponseMessage(HttpStatusCode.OK) {Content=new StringContent(Wire.Write(value), System.Text.Encoding.UTF8, "application/json")};
        private static void Set(object target,string name,object value)=>target.GetType().GetField(name,Flags)!.SetValue(target,value);
        private static void Require(bool value,string message) { if(!value) throw new InvalidOperationException(message); }
    }
}
