#nullable enable
using System;
using System.IO;
using System.Linq;
using Boopy.Client;
using TMPro;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>Synthetic source geometry and elapsed time; no camera, model, microphone or network.</summary>
    public static class LiveSceneHudValidation
    {
        private static readonly string Output = Path.Combine(Path.GetTempPath(), "boopy-scene-ambient-native03");
        public static void Validate()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var root = new GameObject("Synthetic live HUD validation");
            try
            {
                var head = new GameObject("Synthetic eyes").transform; head.SetParent(root.transform,false);
                var room = root.AddComponent<RoomCamera>(); var hud = LiveSceneHud.Create(root.transform,head,room);
                var born = Time.unscaledTime;
                Require(hud.GetComponentsInChildren<CompanionOrb>(true).Length == 0, "Live masks created duplicate companion bodies.");
                Require(hud.GetComponentsInChildren<SpatialAction>(true).Length == 0, "Live masks created standalone scene controls.");
                Require(hud.GetComponentsInChildren<TextMeshPro>(true).Length == 0, "Ambient perception created labels or a separate status surface.");
                Require(hud.Status == "Looking around" && hud.FirstTarget == null, "Idle live state invents a source target.");
                var result = Fixture(); var snapshot = Snapshot(); Show(hud, result, snapshot, born + 1f);
                hud.Refresh(1f / 60f, born + 1f);
                Require(hud.VisibleObjects == 2 && hud.Status == "Live view" && hud.FirstTarget.HasValue, "Actual source proposals are unavailable to the shared companion.");
                var points = room.PlaceBoundary(result.Objects[0].GroundingFor(result), snapshot, out _);
                var expected = points.Aggregate(Vector3.zero, (sum, point) => sum + point) / points.Length;
                Require(hud.FirstTarget.Value == expected, "Companion attention is not bound to the placed captured boundary.");
                // Detector category churn must not create ambient captions or rewrite source data.
                foreach (var guess in new[] { "window", "picture", "rectangle" })
                {
                    result.Objects[0].Label = guess;
                    Show(hud, result, snapshot, born + 1f);
                    Require(hud.GetComponentsInChildren<TextMeshPro>(true).Length == 0, "Changing detector guesses created background labels.");
                    Require(hud.VisibleObjects == 2 && hud.FirstTarget == expected, "Removing labels lost the current captured outlines or attention.");
                    Require(result.Objects[0].Label == guess, "Presentation erased the original detector proposal.");
                }
                // Ambient observations remain steady and neutral, even when their captured points change.
                var ambient = hud.GetComponentsInChildren<GroundedOverlay>().ToArray();
                foreach (var overlay in ambient)
                {
                    var line = overlay.GetComponentInChildren<LineRenderer>();
                    var positions = new Vector3[line.positionCount]; line.GetPositions(positions);
                    Require(line.loop && line.positionCount == 4 && Mathf.Approximately(line.widthMultiplier,.0018f * 1.8f),
                        "Ambient contour retraces or loses its bounded thin apparent width at the captured distance.");
                    overlay.RefreshVisuals(.27f);
                    var after = new Vector3[line.positionCount]; line.GetPositions(after);
                    Require(positions.SequenceEqual(after), "Ambient geometry animates while its source is unchanged.");
                    Require(!overlay.GetComponentsInChildren<MeshRenderer>().Any(renderer=>renderer.enabled),
                        "Ambient observation retains a breathing filled surface.");
                }
                // Explicit conversation evidence retains its intentional trace and captured-depth fill.
                var deliberate = GroundedOverlay.Create(root.transform);
                deliberate.Show(result.Objects[0].GroundingFor(result), new[] {new Vector3(0,0,1),new Vector3(1,0,1),new Vector3(1,1,1),new Vector3(0,1,1)},true,true);
                Require(deliberate.GetComponentsInChildren<MeshRenderer>().Any(renderer=>renderer.enabled),
                    "Quiet ambient styling removed deliberate captured-depth evidence.");
                UnityEngine.Object.DestroyImmediate(deliberate.gameObject);
                var target = hud.FirstTarget;
                head.position = new Vector3(.2f, 0, 0); head.rotation = Quaternion.Euler(0, 30, 0);
                hud.Refresh(1f / 60f, born + 2f);
                Require(hud.FirstTarget == target && hud.VisibleObjects == 2, "Head motion moved captured source geometry.");
                hud.Refresh(1f / 60f, born + 5f);
                Require(hud.VisibleObjects == 0 && hud.FirstTarget == null && hud.Status == "Waiting for a fresh view", "Expired masks or attention remain current.");
                // Receipt at +5s cannot reset an older source's lifetime to the receipt time.
                Show(hud, result, snapshot, born + 2f); hud.Refresh(1f / 60f, born + 5.01f);
                Require(hud.VisibleObjects == 0 && hud.FirstTarget == null, "Delayed receipt renewed expired source geometry.");
                hud.SetActive(true, true); Show(hud, result, snapshot, born + 6f); hud.Refresh(1f / 60f, born + 6f);
                var still = hud.FirstTarget; hud.Refresh(.5f, born + 6.5f);
                Require(hud.FirstTarget == still && hud.VisibleObjects == 2, "Reduced motion moved or removed actual source masks.");
                hud.SetPaused(true); hud.Refresh(.1f, born + 6.6f);
                Require(hud.VisibleObjects == 0 && hud.FirstTarget == null && hud.Status == "Scene paused", "Pause retains source geometry or attention.");
                Show(hud, result, snapshot, born + 6.7f);
                Require(hud.VisibleObjects == 0 && hud.FirstTarget == null, "Paused scene accepts new source proposals.");
                hud.SetPaused(false); Require(hud.Status == "Looking around", "Resume retained the paused state.");
                Show(hud, result, snapshot, born + 7f); hud.Unavailable();
                Require(hud.VisibleObjects == 0 && hud.FirstTarget == null && hud.Status == "Scene recognition unavailable", "Unavailable perception retained a source or concealed failure.");
                hud.SetProcessing(true); hud.Refresh(.1f, born + 7.1f);
                Require(hud.Status == "Looking around", "Actual processing does not expose its current state.");
                hud.SetProcessing(false); Show(hud, result, snapshot, born + 7.2f);
                hud.SetActive(false, true);
                Require(hud.VisibleObjects == 0 && hud.FirstTarget == null && hud.Status == "Scene paused" &&
                    !hud.GetComponentsInChildren<GroundedOverlay>(true).Any(outline => outline.gameObject.activeInHierarchy) &&
                    !hud.GetComponentsInChildren<TextMeshPro>(true).Any(text => text.gameObject.activeInHierarchy), "Disabling live masks leaves geometry, labels or attention visible.");
                Show(hud, result, snapshot, born + 8f); Require(hud.VisibleObjects == 0, "Disabled live masks accept a late reply.");
                hud.SetActive(true, true); var empty = Fixture(); empty.Objects.Clear(); Show(hud, empty, snapshot, born + 8.1f);
                Require(hud.Status == "Looking around" && hud.FirstTarget == null && hud.VisibleObjects == 0, "Empty scene proposals fabricate an attention target.");
                Debug.Log("Boopy live HUD validation passed; synthetic proposed sources and time, no device comfort claim.");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }
        public static void Render()=>RenderFrames(240,false);
        public static void RenderPreview()=>RenderFrames(2,true);
        private static void RenderFrames(int frames,bool paused)
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single); ScriptCoverage.Install();
            Directory.CreateDirectory(Output); Directory.CreateDirectory(Path.Combine(Output,"sequence"));
            var root=new GameObject("Synthetic production HUD motion");
            var head=new GameObject("Fixed synthetic viewer").transform;head.SetParent(root.transform,false);
            var camera=head.gameObject.AddComponent<Camera>();camera.fieldOfView=58;camera.nearClipPlane=.05f;camera.farClipPlane=10;camera.clearFlags=CameraClearFlags.SolidColor;camera.backgroundColor=new Color(.12f,.13f,.15f);camera.allowHDR=false;camera.allowMSAA=false;
            var light=new GameObject("Synthetic studio light").AddComponent<Light>();light.transform.SetParent(root.transform,false);light.type=LightType.Directional;light.intensity=1;light.transform.rotation=Quaternion.Euler(30,-30,0);RenderSettings.ambientLight=new Color(.45f,.45f,.45f);
            foreach(var geometry in new[]{new Vector3(-.63f,.054f,1.82f),new Vector3(0,.054f,1.82f)})
            {
                var prop=GameObject.CreatePrimitive(PrimitiveType.Cube);prop.transform.SetParent(root.transform,false);prop.transform.position=geometry;prop.transform.localScale=new Vector3(geometry.x<-.3f?.54f:.36f,.972f,.04f);UnityEngine.Object.DestroyImmediate(prop.GetComponent<Collider>());
                var material=new Material(Shader.Find("Standard"));material.color=geometry.x<-.3f?new Color(.48f,.49f,.51f):new Color(.30f,.34f,.37f);prop.GetComponent<MeshRenderer>().sharedMaterial=material;
            }
            var room=root.AddComponent<RoomCamera>();var hud=LiveSceneHud.Create(root.transform,head,room);
            var console=ContextConsole.Create(root.transform,head);console.Place(new Vector3(.42f,.08f,1.2f));
            var dialogue=DialogueStrip.Create(root.transform,head);console.DockDialogue(dialogue);
            var marker=SpatialTheme.Text(root.transform,"Synthetic evidence label",SpatialTheme.Utility,SpatialTheme.Cyan);marker.text="SYNTHETIC · PRODUCTION MOTION";marker.rectTransform.sizeDelta=new Vector2(.60f,.035f);marker.transform.position=new Vector3(-.3f,.44f,1.4f);
            var target=new RenderTexture(1440,900,24);target.Create();var pixels=new Texture2D(1440,900,TextureFormat.RGB24,false);var prior=RenderTexture.active;camera.targetTexture=target;
            var result=Fixture();var snapshot=Snapshot();var born=Time.unscaledTime;
            try
            {
                if(paused){hud.SetPaused(true);console.RefreshVisuals(1f);}
                for(var frame=0;frame<frames;frame++)
                {
                    var age=frame/24f;
                    if(paused && frame==1)hud.SetPaused(false);
                    if(frame==24 || frame==72 || frame==120 || frame==168 || frame==216)Show(hud, result,snapshot,born+age);
                    if(frame==48){hud.SetActive(false,false);hud.SetProcessing(true);console.ShowProcessing();dialogue.Show(DialogueStage.Working,"Thinking…");dialogue.SetCancelableWait(true);}
                    if(frame==120)
                    {
                        hud.SetActive(true,false);hud.SetProcessing(false);var view=new SessionView{Id="synthetic-motion",State="review",Model=new ModelRef{Provider="fixture",Id="synthetic"},Dialogue=new DialogueView{UtteranceId="synthetic-turn",At="synthetic-at",Text="These may be a marker and a display."}};
                        view.Utterances.Add(new UtteranceRef{Id="synthetic-turn",Text="What do you see?"});view.Observations.Add(new ObservationRef{Id="synthetic-frame"});view.Items.Add(new Item{Id="synthetic-marker",Kind="object",Label="Marker",Statement="Synthetic proposed marker.",Status="proposed",Grounding=new Grounding{Kind="scene"}});
                        view.Dialogue.Actions.Add(new ContextualAction{Id="synthetic-question",Question="What does the display say?",ObservationId="synthetic-frame"});console.Render(view);dialogue.SetCancelableWait(false);dialogue.Show(DialogueStage.Response,view.Dialogue.Text);
                    }
                    hud.Refresh(1f/24f,born+age);console.RefreshVisuals(1f/24f);dialogue.RefreshVisuals(1f/24f);
                    foreach(var outline in hud.GetComponentsInChildren<GroundedOverlay>())outline.RefreshVisuals(1f/24f);
                    foreach(var text in root.GetComponentsInChildren<TextMeshPro>())text.ForceMeshUpdate();
                    camera.Render();RenderTexture.active=target;pixels.ReadPixels(new Rect(0,0,1440,900),0,0);pixels.Apply();
                    if(!paused)File.WriteAllBytes(Path.Combine(Output,"sequence",$"frame-{frame:000}.png"),pixels.EncodeToPNG());
                    if(paused)
                    {
                        File.WriteAllBytes(Path.Combine(Output,frame==0?"scene-paused-preview.png":"scene-active-preview.png"),pixels.EncodeToPNG());
                        var crop=new Texture2D(720,700,TextureFormat.RGB24,false);
                        try {crop.SetPixels(pixels.GetPixels(720,100,720,700));crop.Apply();File.WriteAllBytes(Path.Combine(Output,frame==0?"controls-paused-close.png":"controls-active-close.png"),crop.EncodeToPNG());}
                        finally {UnityEngine.Object.DestroyImmediate(crop);}
                    }
                    if(frame==23 || frame==47 || frame==84 || frame==119 || frame==144 || frame==239)File.WriteAllBytes(Path.Combine(Output,$"stage-{frame:000}.png"),pixels.EncodeToPNG());
                }
                if(!paused)File.WriteAllText(Path.Combine(Output,"README.txt"),"Synthetic production Unity components. Ten seconds/240 frames at nominal24fps. Fixed synthetic eyes, model-proposal contour DTOs and captured pose/depth fixture. No live model, wearer image, microphone, provider timing or audible playback. Working phase is explicitly simulated actual UI state; no backend work or percentage is implied. Live layer renders proposed source outlines without background detector labels. One shared console companion owns attention; no standalone live controls/status/avatars. Buttons render before hover. Device stereo comfort and source accuracy remain unverified.\n");
                Debug.Log("Boopy HUD motion synthetic render: "+Output);
            }
            finally{camera.targetTexture=null;RenderTexture.active=prior;UnityEngine.Object.DestroyImmediate(pixels);UnityEngine.Object.DestroyImmediate(target);UnityEngine.Object.DestroyImmediate(root);}
        }
        private static SceneObservation Fixture()
        {
            var result=new SceneObservation{Verification="proposed",StreamId="11111111-1111-4111-8111-111111111111",FrameId="22222222-2222-4222-8222-222222222222",Provider="fixture",Model="synthetic",FrameSha256="4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a",EventId="synthetic-event"};
            foreach(var pair in new[]{("Marker",.25f,.40f), ("Display",.45f,.55f)})
            {var box=new Box2{X0=pair.Item2,Y0=.35f,X1=pair.Item3,Y1=.62f};result.Objects.Add(new SceneObject{Label=pair.Item1,Confidence=.4f,MaskConfidence=.4f,MaskPixels=100,MaskSha256=new string('b',64),Box=box,Contour=new System.Collections.Generic.List<Point2>{new Point2{X=box.X0,Y=box.Y0},new Point2{X=box.X1,Y=box.Y0},new Point2{X=box.X1,Y=box.Y1},new Point2{X=box.X0,Y=box.Y1}}});}
            return result;
        }
        private static void Show(LiveSceneHud hud, SceneObservation result, Snapshot snapshot, float sourceTime)
        {
            var captured = new Snapshot(snapshot.Jpeg, snapshot.Width, snapshot.Height, snapshot.CapturedAt,
                snapshot.Pose, snapshot.Depth, snapshot.Camera, sourceTime);
            var request = new SceneObservationRequest { StreamId = result.StreamId, FrameId = result.FrameId,
                Sequence = result.Sequence, Frame = captured.ToFrame() };
            result.CapturedAt = request.Frame.CapturedAt;
            hud.Show(result, request, captured, sourceTime);
        }
        private static Snapshot Snapshot()=>new Snapshot(new byte[]{1},80,80,new DateTime(1970,1,1,12,0,0,DateTimeKind.Utc),new Pose(Vector3.zero,Quaternion.identity),new DepthGrid{Columns=1,Rows=1,Meters=new float?[]{1.8f}},new CameraInfo{Pose=new Pose3{Position=new float[3],Rotation=new[]{0f,0f,0f,1f}},FocalLength=new float[]{40,40},PrincipalPoint=new float[]{40,40},SensorResolution=new int[]{80,80}});
        private static void Require(bool value,string message){if(!value)throw new InvalidOperationException(message);}
    }
}
