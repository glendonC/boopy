#nullable enable
using System;
using System.IO;
using System.Collections.Generic;
using System.Linq;
using Boopy.Client;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>Renders production UI against a synthetic room; no headset, service, private media or keys.</summary>
    public static class SpatialPreview
    {
        [MenuItem("Boopy/Render Spatial UI Preview")]
        public static void Render()
        {
            try
            {
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                var root = new GameObject("Synthetic preview").transform;
                var camera = new GameObject("Preview eyes").AddComponent<Camera>();
                camera.transform.position = new Vector3(0f, 1.55f, 0f);
                camera.transform.rotation = Quaternion.identity;
                camera.fieldOfView = 58f;
                camera.nearClipPlane = 0.05f;
                camera.farClipPlane = 10f;
                camera.clearFlags = CameraClearFlags.SolidColor;
                camera.backgroundColor = new Color(0.69f, 0.72f, 0.73f);
                camera.allowHDR = false;
                camera.allowMSAA = false;
                HangulFont.Install();
                ModularUiValidation.Validate();
                var quad = Visuals.Quad();
                Surface(root, "Synthetic wall", new Vector3(0f, 1.55f, 2f), new Vector2(4f, 2.4f),
                    new Color(0.70f, 0.74f, 0.75f), quad);
                Surface(root, "Synthetic photo frame", new Vector3(-0.34f, 1.58f, 1.18f), new Vector2(0.49f, 0.34f),
                    new Color(0.14f, 0.16f, 0.18f), quad);
                var photo = Surface(root, "Synthetic dunes", new Vector3(-0.34f, 1.58f, 1.17f), new Vector2(0.46f, 0.31f),
                    Color.white, quad);
                var sand = new Texture2D(512, 320, TextureFormat.RGB24, false);
                for (var y = 0; y < sand.height; y++)
                for (var x = 0; x < sand.width; x++)
                {
                    var dune = 98f + 35f * Mathf.Sin(x * 0.009f) + 25f * Mathf.Sin(x * 0.024f + 2f);
                    var farDune = 142f + 24f * Mathf.Sin(x * 0.012f + 1f);
                    var color = y < dune ? new Color(0.70f, 0.46f, 0.24f)
                        : y < farDune ? new Color(0.88f, 0.67f, 0.41f)
                        : new Color(0.54f, 0.73f, 0.79f);
                    sand.SetPixel(x, y, color);
                }
                sand.Apply();
                photo.sharedMaterial = new Material(Visuals.Solid) { mainTexture = sand };
                var view = SyntheticSession();
                var photoShape = new[] {new Vector3(-.56f,1.72f,1.16f),new Vector3(-.55f,1.73f,1.16f),
                    new Vector3(-.13f,1.73f,1.16f),new Vector3(-.12f,1.72f,1.16f),
                    new Vector3(-.12f,1.44f,1.16f),new Vector3(-.13f,1.43f,1.16f),
                    new Vector3(-.55f,1.43f,1.16f),new Vector3(-.56f,1.44f,1.16f)};
                var noteShape = new[] {new Vector3(-.76f,1.40f,1.13f),new Vector3(-.57f,1.40f,1.13f),
                    new Vector3(-.57f,1.32f,1.13f),new Vector3(-.64f,1.32f,1.13f),
                    new Vector3(-.64f,1.19f,1.13f),new Vector3(-.76f,1.19f,1.13f)};
                var note = new Item {Id="synthetic-note",Kind="object",Label="Folded note",Status="proposed"};
                view.Items.Add(note);
                var photoOverlay = SyntheticOverlay(root, camera, view.Items[1], photoShape, true);
                var noteOverlay = SyntheticOverlay(root, camera, note, noteShape, true);
                photoOverlay.SetIdentityAccent(0); noteOverlay.SetIdentityAccent(1);
                var noteObject = new GameObject("Synthetic concave note"); noteObject.transform.SetParent(root, false);
                var noteMesh = new Mesh {name="Synthetic note fixture"};
                noteMesh.vertices = noteShape.Select(point=>point+Vector3.forward*.012f).ToArray();
                SurfaceGeometry.TryTriangulate(note.Grounding.Contour!.Select(point=>new System.Numerics.Vector2(point.X,point.Y)).ToArray(),out var noteTriangles);
                noteMesh.triangles=noteTriangles; noteMesh.RecalculateBounds();
                noteObject.AddComponent<MeshFilter>().sharedMesh=noteMesh;
                var noteRenderer=noteObject.AddComponent<MeshRenderer>(); noteRenderer.sharedMaterial=Visuals.Solid;
                var noteTint=new MaterialPropertyBlock(); noteTint.SetColor("_Color",new Color(.47f,.56f,.49f)); noteRenderer.SetPropertyBlock(noteTint);
                var console = ContextConsole.Create(root, camera.transform);
                console.SetReducedMotion(true);
                console.Place(new Vector3(0.31f, 1.51f, 1.0f));
                var directory = Path.Combine(Path.GetTempPath(), "boopy-spatial-preview");
                Directory.CreateDirectory(directory);
                Capture(camera, console, directory, "capture");
                Capture(camera, console, directory, "quiet");
                console.Render(view);
                Capture(camera, console, directory, "overview");
                console.Activate(ConsoleAction.PrepareSave);
                Capture(camera, console, directory, "save-preview");
                console.Activate(ConsoleAction.Back);
                console.Activate(ConsoleAction.Review);
                console.SetSelectedAccent(0);
                var sceneItem = view.Items[1];
                var label = Chip.Create(root, quad);
                label.SetReducedMotion(true);
                label.SetIdentityAccent(0);
                label.Show(sceneItem, false);
                label.Place(new Vector3(-0.40f, 1.85f, 1.1f), new Vector3(-0.34f, 1.62f, 1.17f));
                label.Face(camera.transform);
                var vocabulary = Chip.Create(root, quad);
                vocabulary.SetReducedMotion(true);
                vocabulary.Show(view.Items[2], false);
                vocabulary.Place(new Vector3(-0.35f, 1.26f, 1.0f), new Vector3(-0.34f, 1.47f, 1.17f));
                vocabulary.Face(camera.transform);
                var reticle = Reticle.Create("Synthetic captured point", root, camera.transform, 0.0018f, ReticleRole.Capture);
                reticle.Show(new Vector3(-0.34f, 1.58f, 1.16f), true);
                Capture(camera, console, directory, "review");
                console.Activate(ConsoleAction.ToggleDetails);
                Capture(camera, console, directory, "details");
                console.Activate(ConsoleAction.ToggleDetails);
                console.Activate(ConsoleAction.Review);
                console.Activate(ConsoleAction.Options);
                Capture(camera, console, directory, "options");
                console.Activate(ConsoleAction.Size);
                Capture(camera, console, directory, "large");
                console.Activate(ConsoleAction.Size);
                console.Activate(ConsoleAction.Options);
                view.Items[1].Label="Handwritten Korean notes about a desert journey, with several open questions";
                view.Items[1].Text=new System.Collections.Generic.List<string>
                {
                    "나는 사막에서 여행했어요. 모래 언덕이 아름다웠어요.",
                    "그 여행에서 무엇을 보았나요? 어디에서 사진을 찍었나요?",
                    "나는 한국어로 이 장면에 대해 이야기하고 싶어요.",
                    "아직 장소와 시간을 확인하지 않았어요. 질문을 남겨 주세요.",
                };
                console.Render(view);
                if (!console.ReaderOpen) console.Activate(ConsoleAction.Review);
                console.Activate(ConsoleAction.ToggleDetails);
                Capture(camera,console,directory,"long-source");
                console.NextPage();
                Capture(camera,console,directory,"long-source-next");
                console.Activate(ConsoleAction.ToggleDetails);
                console.ShowListening();
                Capture(camera, console, directory, "listening");
                console.ShowProcessing();
                console.SetBusy(true);
                Capture(camera, console, directory, "processing");
                view.State = "committed";
                view.Committed = new Committed
                {
                    PackageId = "ctx_synthetic_preview_001",
                    At = "1970-01-01T23:30:00.000Z",
                    Summary = "1 confirmed, 2 accepted, 1 known, 1 question",
                };
                console.Render(view);
                label.gameObject.SetActive(false);
                vocabulary.gameObject.SetActive(false);
                reticle.Hide();
                photoOverlay.gameObject.SetActive(false);
                noteOverlay.gameObject.SetActive(false);
                Capture(camera, console, directory, "saved");
                // Render the actual native companion and production shimmer over three seconds.
                // These are synthetic state previews, not simulated sensor/model progress.
                var motion = Path.Combine(directory, "motion");
                Directory.CreateDirectory(motion);
                console.SetReducedMotion(false);
                console.ShowProcessing();
                for (var frame = 0; frame < 60; frame++)
                {
                    console.RefreshVisuals(0.05f);
                    Capture(camera, console, directory, $"motion/frame-{frame:000}");
                }
                // Genuine returned contour fixtures reveal through the production renderer.
                // This does not simulate a mask arriving before interpretation completed.
                view.Committed = null; view.State = "review";
                console.Render(view);
                if (console.ReaderOpen) console.Activate(ConsoleAction.Review);
                var contourMotion = Path.Combine(directory,"contour-motion"); Directory.CreateDirectory(contourMotion);
                var tracedPhoto = SyntheticOverlay(root,camera,view.Items[1],photoShape,false);
                var tracedNote = SyntheticOverlay(root,camera,note,noteShape,false);
                for (var frame=0;frame<24;frame++)
                {
                    Capture(camera,console,directory,$"contour-motion/frame-{frame:000}");
                    tracedPhoto.RefreshVisuals(.05f); tracedNote.RefreshVisuals(.05f); console.RefreshVisuals(.05f);
                }
                Debug.Log("Boopy: synthetic UI previews rendered under " + directory);
            }
            catch (Exception error)
            {
                Debug.LogException(error);
                if (Application.isBatchMode) EditorApplication.Exit(1);
                else throw;
            }
        }

        private static GroundedOverlay SyntheticOverlay(Transform root, Camera eyes, Item item, Vector3[] shape, bool reduced)
        {
            const int width=1920,height=1080;
            var focal=height*.5f/Mathf.Tan(eyes.fieldOfView*Mathf.Deg2Rad*.5f);
            var camera=new CameraInfo {FocalLength=new[]{focal,focal},PrincipalPoint=new[]{width*.5f,height*.5f},SensorResolution=new[]{width,height}};
            var contour=shape.Select(point=>point-eyes.transform.position).Select(point=>new Point2 {
                X=.5f+point.x*focal/(point.z*width),Y=.5f-point.y*focal/(point.z*height)}).ToList();
            item.Grounding=new Grounding {Kind="box",ObservationId="synthetic-frame",Contour=contour,
                Box=new Box2 {X0=contour.Min(point=>point.X),Y0=contour.Min(point=>point.Y),X1=contour.Max(point=>point.X),Y1=contour.Max(point=>point.Y)},
                Spatial=new SpatialEvidence {Outcome="contour",Provider="synthetic",Model="synthetic-contour-fixture",Concept=item.Label,
                    FrameSha256=new string('0',64),UtteranceId="synthetic-utterance",Verification="proposed"}};
            var depth=new DepthGrid {Columns=16,Rows=12,Meters=new float?[16*12]};
            var planeDepth=shape[0].z-eyes.transform.position.z;
            var samples=new List<System.Numerics.Vector3>(); var index=0;
            foreach(var cell in Geometry.CellCenters(depth.Columns,depth.Rows))
            {
                SurfaceGeometry.CameraRay(cell,width,height,camera,out var ray);
                var meters=planeDepth/ray.Z; depth.Meters[index++]=meters;
                if(SurfaceGeometry.Contains(contour.Select(point=>new System.Numerics.Vector2(point.X,point.Y)).ToArray(),cell))
                    samples.Add(ray*meters);
            }
            var planar=SurfaceGeometry.TryFitPlane(samples,out var plane);
            var placed=new Vector3[contour.Count];
            for(var i=0;i<contour.Count;i++)
            {
                SurfaceGeometry.CameraRay(new System.Numerics.Vector2(contour[i].X,contour[i].Y),width,height,camera,out var ray);
                System.Numerics.Vector3 point;
                if(!planar || !plane.Intersect(System.Numerics.Vector3.Zero,ray,out point))
                {
                    var meters=Geometry.SampleDepth(depth,new System.Numerics.Vector2(contour[i].X,contour[i].Y));
                    if(meters==null)throw new InvalidOperationException("Synthetic captured depth missing.");
                    point=ray*meters.Value;
                }
                placed[i]=eyes.transform.position+new Vector3(point.X,point.Y,point.Z);
            }
            var overlay=GroundedOverlay.Create(root); overlay.SetReducedMotion(reduced);
            overlay.Show(item.Grounding,placed,true,item.Id=="photo");
            if(reduced)
            {
                var line=overlay.GetComponentInChildren<LineRenderer>();
                if(line.positionCount!=placed.Length+1)throw new InvalidOperationException("Reduced motion left an incomplete contour trace.");
                var fill=overlay.GetComponentInChildren<MeshRenderer>(); var before=new MaterialPropertyBlock(); fill.GetPropertyBlock(before);
                overlay.RefreshVisuals(2f);
                var after=new MaterialPropertyBlock(); fill.GetPropertyBlock(after);
                if(!Mathf.Approximately(before.GetColor("_Color").a,.055f)||before.GetColor("_Color")!=after.GetColor("_Color"))
                    throw new InvalidOperationException("Reduced motion changed the contour tint.");
            }
            return overlay;
        }

        private static MeshRenderer Surface(Transform parent, string name, Vector3 position, Vector2 size, Color color, Mesh quad)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);
            go.transform.position = position;
            go.transform.localScale = new Vector3(size.x, size.y, 1f);
            go.AddComponent<MeshFilter>().sharedMesh = quad;
            var renderer = go.AddComponent<MeshRenderer>();
            renderer.sharedMaterial = Visuals.Solid;
            var block = new MaterialPropertyBlock();
            block.SetColor("_Color", color);
            renderer.SetPropertyBlock(block);
            return renderer;
        }

        private static SessionView SyntheticSession()
        {
            var view = new SessionView
            {
                Id = "synthetic-preview", IntentId = "goal", ReferentId = "photo", Scope = "object",
                Model = new ModelRef { Provider = "ollama", Id = "synthetic-vision", LatencyMs = 10300f },
            };
            view.Utterances.Add(new UtteranceRef
            {
                Id = "synthetic-utterance", Text = "I want to practice talking about this trip in Korean.", Kind = "ask",
            });
            view.Items.Add(new Item { Id = "goal", Kind = "goal", Label = "Practice this trip in Korean", Status = "proposed", Confidence = 0.9f });
            view.Items.Add(new Item
            {
                Id = "photo", Kind = "object", Label = "Desert photograph", Statement = "A photograph shows a dune landscape.",
                Why = "The captured image contains curved sand ridges. The place is unknown.", Confidence = 0.78f,
                Grounding = new Grounding { Kind = "box", ObservationId = "synthetic-frame", Box = new Box2 { X0 = 0.1f, Y0 = 0.2f, X1 = 0.8f, Y1 = 0.7f } },
            });
            view.Items.Add(new Item { Id = "word", Kind = "vocabulary", Label = "사막", Gloss = "desert", Status = "known", Confidence = 0.9f });
            view.Items.Add(new Item { Id = "story", Kind = "topic", Label = "Tell the trip's story", Status = "confirmed", Confidence = 0.7f });
            view.Items.Add(new Item { Id = "place", Kind = "question", Label = "Where was this trip?", Statement = "The place is not established.", Confidence = null });
            return view;
        }

        private static void Capture(Camera camera, ContextConsole console, string directory, string name)
        {
            foreach (var text in UnityEngine.Object.FindObjectsByType<TextMeshPro>(FindObjectsSortMode.None)) text.ForceMeshUpdate(true, true);
            console.RefreshVisuals(0f);
            var texture = new RenderTexture(1920, 1080, 24, RenderTextureFormat.ARGB32);
            texture.Create();
            var previous = RenderTexture.active;
            camera.targetTexture = texture;
            camera.Render();
            RenderTexture.active = texture;
            var pixels = new Texture2D(texture.width, texture.height, TextureFormat.RGB24, false);
            pixels.ReadPixels(new Rect(0f, 0f, texture.width, texture.height), 0, 0);
            pixels.Apply();
            File.WriteAllBytes(Path.Combine(directory, name + ".png"), pixels.EncodeToPNG());
            camera.targetTexture = null;
            RenderTexture.active = previous;
            texture.Release();
            UnityEngine.Object.DestroyImmediate(texture);
            UnityEngine.Object.DestroyImmediate(pixels);
        }
    }
}
