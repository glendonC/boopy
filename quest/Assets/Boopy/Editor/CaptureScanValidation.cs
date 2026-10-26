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
    /// <summary>Actual production capture cue and UI against a disclosed fictional desert illustration. No camera/provider calls.</summary>
    public static class CaptureScanValidation
    {
        public static void Validate()
        {
            var root=new GameObject("Synthetic captured-view aperture checks");
            try
            {
                var cue=CaptureScanCue.Create(root.transform);var source=Source(new Pose(new Vector3(.2f,.1f,.3f),Quaternion.Euler(0,12,0)));
                Require(cue.Begin(source,false),"Fresh calibrated capture did not acknowledge acquisition.");
                var line=cue.GetComponentsInChildren<LineRenderer>().Single(value=>value.name=="Porcelain capture stroke 0");
                SurfaceGeometry.CameraRay(new System.Numerics.Vector2(.04f,.04f),source.Width,source.Height,source.Camera,out var ray);
                var expected=source.Pose.position+source.Pose.rotation*(new Vector3(ray.X,ray.Y,ray.Z)/ray.Z);
                Require(Vector3.Distance(line.GetPosition(1),expected)<.00001f,"Aperture is not projected from actual captured pose/intrinsics.");
                var first=line.GetPosition(1);root.transform.position=Vector3.right;
                Require(line.GetPosition(1)==first,"Head/parent movement restamped the captured view.");
                var sweep=cue.GetComponentsInChildren<LineRenderer>().Single(value=>value.name=="Porcelain capture stroke 4");
                var start=sweep.GetPosition(0);cue.Refresh(.3f,true);
                Require(sweep.GetPosition(0)!=start && cue.Visible,"Single actual-capture sweep did not advance.");
                cue.Refresh(.6f,true);Require(!cue.Visible,"Capture cue continued beyond its finite lifetime.");
                cue.Refresh(4f,true);Require(!cue.Visible,"Expired cue replayed without another capture.");
                foreach(var reason in new[]{"cancel","focus loss","protected source"})
                {
                    Require(cue.Begin(source,false),"Guard fixture did not begin capture cue.");cue.Refresh(.1f,false);
                    Require(!cue.Visible && cue.GetComponentsInChildren<LineRenderer>().All(value=>!value.enabled),reason+" retained acquisition marks.");
                    cue.Refresh(.1f,true);Require(!cue.Visible,reason+" replayed an old acquisition.");
                }
                cue.Begin(source,true);var quiet=line.GetPositionsCopy();cue.Refresh(.4f,true);
                Require(quiet.SequenceEqual(line.GetPositionsCopy()) && !sweep.enabled,"Reduced capture contains a sweep or moving brackets.");
                cue.Refresh(.5f,true);Require(!cue.Visible,"Reduced cue did not expire.");
                var unknown=new Snapshot(new byte[]{1},1280,800,DateTime.UtcNow,Pose.identity,new DepthGrid(),source.Camera);
                Require(!cue.Begin(unknown,false),"Unknown source time invented a registered scan.");
                var invalid=Source(new Pose(Vector3.zero,new Quaternion(0,0,0,0)));
                Require(!cue.Begin(invalid,false),"Invalid captured pose invented registration.");
                var stale=Source(Pose.identity,Time.unscaledTime-4f);Require(!cue.Begin(stale,false),"Stale source renewed its activity.");
                Require(cue.GetComponentsInChildren<Collider>(true).Length==0 && cue.GetComponentsInChildren<TextMeshPro>(true).Length==0,
                    "Capture acknowledgment introduced targets or competing status copy.");
                ValidateSpeechContrast(root);
                Debug.Log("Boopy actual-capture aperture passed: calibrated source rays, finite lifecycle, reduced and cancellation/protection guards.");
            }
            finally {UnityEngine.Object.DestroyImmediate(root);}
        }
        public static void ValidateAndRender(){Validate();Render();}
        private static void ValidateSpeechContrast(GameObject root)
        {
            var head=new GameObject("Synthetic contrast viewer").transform;head.SetParent(root.transform,false);
            var console=ContextConsole.Create(root.transform,head);var strip=DialogueStrip.Create(root.transform,head);console.DockDialogue(strip);
            const string words="I see dunes and camels. What caught your eye?";
            foreach(var large in new[]{false,true})
            foreach(var reduced in new[]{false,true})
            {
                if((console.ComfortScale>1f)!=large)console.Activate(ConsoleAction.Size);
                console.SetReducedMotion(reduced);strip.Show(DialogueStage.Response,words);console.RefreshVisuals(1f);strip.RefreshVisuals(1f);
                Require(strip.FullText==words && strip.PageCount==1,"Short personal reply was changed or paginated.");
                var plate=strip.GetComponentsInChildren<Transform>().Single(value=>value.name=="Speech contrast backing");
                var renderer=plate.GetComponent<MeshRenderer>();var tint=new MaterialPropertyBlock();renderer.GetPropertyBlock(tint);
                var shade=tint.GetColor("_Color");
                Require(renderer.enabled && shade.a>=.8f && shade.r<.1f && shade.g<.1f && shade.b<.1f,
                    "Speech lacks a dark local contrast substrate.");
                foreach(var text in strip.GetComponentsInChildren<TextMeshPro>())
                {
                    text.ForceMeshUpdate(true,true);
                    foreach(var glyph in text.textInfo.characterInfo.Take(text.textInfo.characterCount).Where(value=>value.isVisible))
                    foreach(var corner in new[]{glyph.bottomLeft,glyph.topRight})
                    {
                        var local=plate.InverseTransformPoint(text.transform.TransformPoint(corner));
                        Require(Mathf.Abs(local.x)<=.501f && Mathf.Abs(local.y)<=.501f,"Speech backing does not contain visible glyphs.");
                    }
                }
                var page=strip.VisibleText;strip.SetVoicePreparing(true);strip.RefreshVisuals(1f);
                Require(strip.FullText==words && strip.VisibleText==page,"Voice status/backing changed exact reply or page.");
                strip.Hide();Require(!renderer.gameObject.activeInHierarchy,"Dismissed speech left a floating contrast panel.");
            }
        }
        public static void Render()=>RenderPreview(false);
        public static void RenderLandscapeReference()=>RenderPreview(true);
        private static void RenderPreview(bool landscape)
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);ScriptCoverage.Install();
            var output=Path.Combine(Path.GetTempPath(),landscape?"boopy-desert-landscape-reference-sequence":"boopy-desert-capture-sequence");Directory.CreateDirectory(output);
            var root=new GameObject("Disclosed synthetic desert HUD");
            var eyes=new GameObject("Synthetic viewer").transform;eyes.SetParent(root.transform,false);
            var camera=eyes.gameObject.AddComponent<Camera>();camera.fieldOfView=64;camera.aspect=1.6f;camera.nearClipPlane=.05f;
            camera.clearFlags=CameraClearFlags.SolidColor;camera.backgroundColor=new Color(.13f,.15f,.19f);camera.allowHDR=false;camera.allowMSAA=false;
            var texture=new Texture2D(2,2);var sourcePath=landscape
                ? Environment.GetEnvironmentVariable("BOOPY_PREVIEW_LANDSCAPE_PATH")??throw new InvalidOperationException("An explicit local public landscape reference is required.")
                : Path.GetFullPath(Path.Combine(Application.dataPath,"../../service/fixtures/images/desert-photo.jpg"));
            Require(Path.IsPathRooted(sourcePath),"Landscape reference must be an explicit absolute local path.");
            Require(texture.LoadImage(File.ReadAllBytes(sourcePath)),"Existing fictional desert fixture failed to load.");
            var backdrop=GameObject.CreatePrimitive(PrimitiveType.Quad);backdrop.name="Fictional desert illustration crop, not Sahara footage";backdrop.transform.SetParent(root.transform,false);
            UnityEngine.Object.DestroyImmediate(backdrop.GetComponent<Collider>());backdrop.transform.position=new Vector3(0,0,4);
            var h=8f*Mathf.Tan(32f*Mathf.Deg2Rad);backdrop.transform.localScale=new Vector3(h*1.6f,h,1);
            var material=new Material(Shader.Find("Unlit/Texture"));material.mainTexture=texture;
            // Crop only the existing authored picture, excluding its fictional wall/frame.
            if(!landscape){material.mainTextureScale=new Vector2(600f/1280f,420f/960f);material.mainTextureOffset=new Vector2(300f/1280f,240f/960f);}
            else
            {
                var aspect=(float)texture.width/texture.height;
                var scale=aspect>=1.6f?new Vector2(1.6f/aspect,1f):new Vector2(1f,aspect/1.6f);
                material.mainTextureScale=scale;material.mainTextureOffset=(Vector2.one-scale)/2f;
            }
            backdrop.GetComponent<MeshRenderer>().sharedMaterial=material;
            var label=SpatialTheme.Text(root.transform,"Synthetic scene disclosure",SpatialTheme.Utility,Color.white);label.text=landscape?"STAGED PHOTO REFERENCE · AUTHORED RESPONSE":"STAGED DESERT · AUTHORED PROPOSALS";
            label.rectTransform.sizeDelta=new Vector2(1.3f,.045f);label.alignment=TextAlignmentOptions.Center;label.transform.position=new Vector3(0,.51f,1.2f);
            var disclosurePlate=GameObject.CreatePrimitive(PrimitiveType.Quad);disclosurePlate.name="Artifact disclosure contrast";disclosurePlate.transform.SetParent(root.transform,false);
            UnityEngine.Object.DestroyImmediate(disclosurePlate.GetComponent<Collider>());disclosurePlate.transform.position=new Vector3(0,.51f,1.202f);disclosurePlate.transform.localScale=new Vector3(Mathf.Min(1.3f,label.GetPreferredValues(label.text).x+.04f),.048f,1f);
            var disclosureRenderer=disclosurePlate.GetComponent<MeshRenderer>();disclosureRenderer.sharedMaterial=Visuals.Solid;disclosureRenderer.sortingOrder=2;
            var disclosureTint=new MaterialPropertyBlock();disclosureTint.SetColor("_Color",new Color(.055f,.065f,.085f,.9f));disclosureRenderer.SetPropertyBlock(disclosureTint);
            var target=new RenderTexture(1600,1000,24);target.Create();var image=new Texture2D(1600,1000,TextureFormat.RGB24,false);var prior=RenderTexture.active;
            try
            {
                camera.targetTexture=target;
                foreach(var variant in new[]{"standard","large","reduced","protected","cancelled"})
                {
                    var presentation=new GameObject("Independent "+variant+" presentation");presentation.transform.SetParent(root.transform,false);
                    var console=ContextConsole.Create(presentation.transform,eyes);console.Place(new Vector3(.40f,-.30f,1.3f));
                    var dialogue=DialogueStrip.Create(presentation.transform,eyes);console.DockDialogue(dialogue);console.SetConnectionStatus("connected",true);
                    console.SetLiveSceneCapability(true);var cue=CaptureScanCue.Create(presentation.transform);
                    var overlay=GroundedOverlay.Create(presentation.transform);overlay.gameObject.SetActive(false);
                    try
                    {
                    var source=Source(Pose.identity);
                    if((console.ComfortScale>1f)!=(variant=="large"))console.Activate(ConsoleAction.Size);
                    console.SetReducedMotion(variant=="reduced");console.ShowListening();dialogue.Show(DialogueStage.Listening,"I’m taking in this view.");
                    overlay.gameObject.SetActive(false);cue.Begin(source,variant=="reduced");
                    var folder=Path.Combine(output,variant);Directory.CreateDirectory(folder);
                    for(var frame=0;frame<48;frame++)
                    {
                        if(frame==4 && (variant=="protected" || variant=="cancelled"))cue.Refresh(0f,false);
                        if(frame==4 && variant=="cancelled"){console.ShowCapture();dialogue.Show(DialogueStage.Response,"I stopped waiting. Your current conversation is unchanged.");}
                        if(frame==12 && variant!="cancelled"){console.ShowProcessing();dialogue.Show(DialogueStage.Working,"I’m working on your answer…");}
                        if(frame==24 && variant!="cancelled")
                        {
                            cue.Hide();var view=View(landscape);console.Render(view);dialogue.Show(DialogueStage.Response,view.Dialogue!.Text);
                            if(!landscape && variant!="protected" && variant!="cancelled")ShowProposal(overlay,source);
                        }
                        if(variant=="protected"){cue.Hide();console.ShowControlsOnly(console.transform.position);dialogue.SetFallback(true);}
                        else dialogue.SetFallback(false);
                        cue.Refresh(1f/12f,variant!="protected" && variant!="cancelled");
                        console.RefreshVisuals(1f/12f);dialogue.RefreshVisuals(1f/12f);overlay.RefreshVisuals(1f/12f);
                        if(variant=="cancelled" && frame>=4)
                        {
                            Require(dialogue.gameObject.activeInHierarchy && dialogue.FullText=="I stopped waiting. Your current conversation is unchanged."
                                && dialogue.GetComponentsInChildren<TextMeshPro>().Any(text=>text.name=="Actual response" && text.alpha>0f && text.GetComponent<MeshRenderer>().enabled),
                                "Cancelled fixture hid/replaced its exact stopped-wait caption.");
                            Require(!cue.Visible && !overlay.gameObject.activeSelf,"Cancelled fixture revived acquisition or proposed geometry.");
                        }
                        foreach(var text in root.GetComponentsInChildren<TextMeshPro>()){text.ForceMeshUpdate(true,true);Require(!text.isTextOverflowing,"Synthetic desert HUD text overflows: "+text.name);}
                        var glyphs=label.textInfo.characterInfo.Take(label.textInfo.characterCount).Where(glyph=>glyph.isVisible).ToArray();
                        Require(glyphs.Length>0 && glyphs.All(glyph=>{
                            var bottom=camera.WorldToViewportPoint(label.transform.TransformPoint(glyph.bottomLeft));var top=camera.WorldToViewportPoint(label.transform.TransformPoint(glyph.topRight));
                            return bottom.z>0 && bottom.x>=0 && top.x<=1 && bottom.y>=0 && top.y<=1;
                        }),"Staged artifact disclosure is not readable/in frame.");
                        Require(glyphs.Where(glyph=>char.IsLetterOrDigit(glyph.character)).All(glyph=>{
                            var bottom=camera.WorldToViewportPoint(label.transform.TransformPoint(glyph.bottomLeft));var top=camera.WorldToViewportPoint(label.transform.TransformPoint(glyph.topRight));
                            return (top.y-bottom.y)*1000f>=8f;
                        }),"Staged artifact disclosure letter height is too small.");
                        camera.Render();RenderTexture.active=target;image.ReadPixels(new Rect(0,0,1600,1000),0,0);image.Apply();
                        File.WriteAllBytes(Path.Combine(folder,$"frame-{frame:000}.png"),image.EncodeToPNG());
                    }
                    }
                    finally {UnityEngine.Object.DestroyImmediate(presentation);}
                }
                File.WriteAllText(Path.Combine(output,"README.txt"),"STAGED: existing authored desert illustration cropped as a virtual backdrop, not real Sahara or wearer footage. Actual production CaptureScanCue/ContextConsole/DialogueStrip/CompanionOrb/GroundedOverlay; authored proposed camel box and words, no model inference or provider timing. Nominal12fps per variant: capture0–11, real UI pending12–23, authored proposed answer24–47. Single aperture is capture acknowledgment, not object recognition/depth/progress. Source rays use synthetic captured intrinsics/pose; optical-plane UI makes no depth claim. Normal/large/reduced/protected/cancel variants are synthetic control inputs; no actual protection accuracy or wearer comfort is measured.\n");
                if(landscape)
                {
                    var attribution=Path.Combine(Path.GetDirectoryName(sourcePath)!,"ATTRIBUTION.txt");
                    Require(File.Exists(attribution),"Public photo reference requires its retained attribution.");
                    File.WriteAllText(Path.Combine(output,"README.txt"),"STAGED PUBLIC PHOTO REFERENCE, not wearer capture or model recognition. Existing production HUD/capture acknowledgment; authored words, no camel box/mask/depth claim, no actual provider timing. No inference/network/device operation. Reference photo retained outside Git; CC BY-SA attribution and license follow.\n\n"+File.ReadAllText(attribution));
                }
                Debug.Log("Boopy staged desert production HUD renders: "+output);
            }
            finally {camera.targetTexture=null;RenderTexture.active=prior;UnityEngine.Object.DestroyImmediate(image);UnityEngine.Object.DestroyImmediate(target);UnityEngine.Object.DestroyImmediate(material);UnityEngine.Object.DestroyImmediate(texture);UnityEngine.Object.DestroyImmediate(root);}
        }
        private static void ShowProposal(GroundedOverlay overlay,Snapshot source)
        {
            var grounding=new Grounding{Kind="box",Box=new Box2{X0=.19f,Y0=.61f,X1=.38f,Y1=.85f}};
            var points=Geometry.Outline(grounding).Select(point=>{SurfaceGeometry.CameraRay(point,source.Width,source.Height,source.Camera,out var ray);return new Vector3(ray.X,ray.Y,ray.Z)/ray.Z*1.4f;}).ToArray();
            overlay.gameObject.SetActive(true);overlay.Show(grounding,points,false,true);
        }
        private static SessionView View(bool landscape=false)
        {
            var view=new SessionView{Id="synthetic-desert",State="review",Model=new ModelRef{Provider="fixture",Id="authored-proposal"},Dialogue=new DialogueView{Speaker="boopy",UtteranceId="synthetic-turn",At="synthetic-time",Text="I see dunes and camels. What caught your eye?"}};
            if(landscape)view.Dialogue.Text="I see sweeping dunes. What caught your eye?";
            view.Utterances.Add(new UtteranceRef{Id="synthetic-turn",Text="What do you see?",Kind="ask"});
            view.Items.Add(new Item{Id="synthetic-subject",Kind="object",Label=landscape?"Dunes":"Camel",Statement=landscape?"Authored proposed dune context in a public photo reference.":"This may be a camel in the authored picture.",Status="proposed",Origin="model",Confidence=.5f,Grounding=new Grounding{Kind="scene"}});return view;
        }
        private static Snapshot Source(Pose pose,float? time=null)
        {
            var focal=800f/(2f*Mathf.Tan(32f*Mathf.Deg2Rad));
            return new Snapshot(new byte[]{255,216,255,217},1280,800,DateTime.UtcNow,pose,new DepthGrid{Columns=1,Rows=1,Meters=new float?[]{null}},
                new CameraInfo{FocalLength=new[]{focal,focal},PrincipalPoint=new[]{640f,400f},SensorResolution=new[]{1280,800}},time??Time.unscaledTime);
        }
        private static Vector3[] GetPositionsCopy(this LineRenderer line){var values=new Vector3[line.positionCount];line.GetPositions(values);return values;}
        private static void Require(bool value,string message){if(!value)throw new InvalidOperationException(message);}
    }
}
