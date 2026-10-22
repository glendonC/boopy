#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using Boopy.Client;
using TMPro;
using UnityEditor.SceneManagement;
using UnityEngine;
using N = System.Numerics;

namespace Boopy.Quest.Editor
{
    /// <summary>Actual native presentation and admission paths with synthetic source evidence only.</summary>
    public static class LiveSceneMechanicsValidation
    {
        private static readonly LabelRect Center = new LabelRect(-.12f, -.09f, .12f, .09f);
        private static readonly LabelRect Bounds = new LabelRect(-.9f, -.65f, .9f, .65f);
        private static readonly LabelRect[] Empty = Array.Empty<LabelRect>();
        private const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;

        public static void ValidateAll()
        {
            Validate();
            LiveSceneHudValidation.Validate();
            ConnectionValidation.Validate();
            SceneDensityValidation.Validate();
            ConsoleFootprintValidation.Validate();
            Debug.Log("Boopy native03 affected validation group passed.");
        }

        public static void ValidateAndRender() { ValidateAll(); Render(); }

        public static void FinalEvidence() { ValidateAll(); ValidateVisibility(); RenderComposition(); }

        public static void ValidateVisibility()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var root = new GameObject("Synthetic AA0 distance and coplanar visibility");
            var head = new GameObject("Fixed synthetic eye").transform; head.SetParent(root.transform, false);
            var camera = head.gameObject.AddComponent<Camera>(); camera.fieldOfView = 64f; camera.aspect = 1.6f;
            camera.nearClipPlane = .05f; camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(.34f, .36f, .33f); camera.allowMSAA = false; camera.allowHDR = false;
            var target = new RenderTexture(1600, 1000, 24) { antiAliasing = 1 }; target.Create();
            var pixels = new Texture2D(1600, 1000, TextureFormat.RGB24, false); var prior = RenderTexture.active;
            var output = Path.Combine(Path.GetTempPath(), "boopy-scene-native03-distance-aa0"); Directory.CreateDirectory(output);
            try
            {
                var room = root.AddComponent<RoomCamera>(); var hud = LiveSceneHud.Create(root.transform, head, room);
                camera.targetTexture = target; var caseIndex = 0;
                foreach (var distance in new[] { .6f, 1.8f, 4.5f })
                foreach (var scale in new[] { 1f, 1.2f })
                foreach (var separation in new[] { 0f, .02f })
                {
                    var fixture = Fixture(40f, 40 + caseIndex, distance);
                    var props = new GameObject("Authored coplanar or separated source props"); props.transform.SetParent(root.transform, false);
                    var meshes = new List<Mesh>(); var materials = new List<Material>();
                    try
                    {
                        foreach (var item in fixture.Result.Objects)
                        {
                            Geometry.TryContour(item.GroundingFor(fixture.Result), out var contour);
                            SurfaceGeometry.TryTriangulate(contour, out var triangles);
                            var boundary = room.PlaceBoundary(item.GroundingFor(fixture.Result), fixture.Snapshot, out _);
                            var mesh = new Mesh { vertices = boundary.Select(point => point + Vector3.forward * separation).ToArray(),
                                triangles = triangles.Concat(triangles.Reverse()).ToArray() }; mesh.RecalculateBounds(); meshes.Add(mesh);
                            var prop = new GameObject("Authored silhouette"); prop.transform.SetParent(props.transform, false);
                            prop.AddComponent<MeshFilter>().sharedMesh = mesh;
                            var material = new Material(Visuals.Solid) { color = new Color(.55f, .50f, .37f) }; materials.Add(material);
                            prop.AddComponent<MeshRenderer>().sharedMaterial = material;
                        }
                        hud.SetActive(true, true); Require(hud.Show(fixture.Result, fixture.Request, fixture.Snapshot, 41f), "Distance admission failed.");
                        hud.SetAttentionRays(ToObject(room, fixture, 0, head.position), null);
                        hud.RefreshAttention(41f, Empty, Center, scale);
                        Require(VisibleLabels(hud).Count() == 1, "Near/far standard/large did not present one measured label.");
                        CheckPlacement(VisibleLabels(hud).Single(), head, room, fixture, Empty);
                        foreach (var line in hud.GetComponentsInChildren<GroundedOverlay>().Select(overlay => overlay.GetComponentInChildren<LineRenderer>()))
                        {
                            var before = new Vector3[line.positionCount]; line.GetPositions(before);
                            head.position = new Vector3(.1f, 0f, 0f); hud.Refresh(0f, 41.1f);
                            var after = new Vector3[line.positionCount]; line.GetPositions(after);
                            var farthest = before.Max(point => Vector3.Distance(point, head.position));
                            Require(before.SequenceEqual(after) && line.widthMultiplier >= .0018f * farthest - .000001f
                                && line.widthMultiplier <= .0026f * farthest + .000001f, "Viewer-relative width moved captured vertices or escaped its angular bound.");
                            head.position = Vector3.zero; hud.Refresh(0f, 41.1f);
                        }
                        ReadPixels(camera, target, pixels);
                        File.WriteAllBytes(Path.Combine(output, "case-" + caseIndex + "-attended.png"), pixels.EncodeToPNG());
                        hud.RefreshAttention(41.2f, new[] { Bounds }, Center, scale);
                        Require(hud.VisibleObjects == 2 && !VisibleLabels(hud).Any(), "Quiet visibility fixture lost source or retained label.");
                        var quiet = ReadPixels(camera, target, pixels);
                        File.WriteAllBytes(Path.Combine(output, "case-" + caseIndex + "-quiet.png"), pixels.EncodeToPNG());
                        hud.RefreshAttention(43.001f, new[] { Bounds }, Center, scale);
                        var expired = ReadPixels(camera, target, pixels); var changed = 0;
                        for (var i = 0; i < quiet.Length; i++) if (!quiet[i].Equals(expired[i])) changed++;
                        Require(hud.VisibleObjects == 0 && changed >= 128, "Near/far/coplanar quiet source has no visible AA0 evidence distinct from expiry.");
                        File.WriteAllBytes(Path.Combine(output, "case-" + caseIndex + "-expired.png"), pixels.EncodeToPNG());
                        Debug.Log($"Boopy AA0 case {caseIndex}: sourceDistance={distance}, textScale={scale}, propSeparation={separation}, changedPixels={changed}; captured vertices unchanged.");
                    }
                    finally
                    {
                        UnityEngine.Object.DestroyImmediate(props);
                        foreach (var mesh in meshes) UnityEngine.Object.DestroyImmediate(mesh);
                        foreach (var material in materials) UnityEngine.Object.DestroyImmediate(material);
                    }
                    caseIndex++;
                }
                Debug.Log("Boopy AA0 near/standard/far standard/large coplanar/separated visibility passed12cases: " + output);
            }
            finally
            {
                camera.targetTexture = null; RenderTexture.active = prior;
                UnityEngine.Object.DestroyImmediate(pixels); UnityEngine.Object.DestroyImmediate(target); UnityEngine.Object.DestroyImmediate(root);
            }
        }

        private static Color32[] ReadPixels(Camera camera, RenderTexture target, Texture2D pixels)
        {
            camera.Render(); RenderTexture.active = target;
            pixels.ReadPixels(new Rect(0, 0, target.width, target.height), 0, 0); pixels.Apply(); return pixels.GetPixels32();
        }

        public static void RenderComposition()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var root = new GameObject("Synthetic recognizable source composition");
            var head = new GameObject("Fixed synthetic viewer").transform; head.SetParent(root.transform, false);
            var camera = head.gameObject.AddComponent<Camera>(); camera.fieldOfView = 52f; camera.aspect = 1.6f;
            camera.nearClipPlane = .05f; camera.farClipPlane = 10f; camera.allowMSAA = false; camera.allowHDR = false;
            camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = new Color(.70f, .71f, .68f);
            var target = new RenderTexture(1600, 1000, 24) { antiAliasing = 1 }; target.Create();
            var pixels = new Texture2D(1600, 1000, TextureFormat.RGB24, false); var prior = RenderTexture.active;
            var materials = new List<Material>(); var meshes = new List<Mesh>();
            var output = Path.Combine(Path.GetTempPath(), "boopy-scene-native03-composition-aa0"); Directory.CreateDirectory(output);
            try
            {
                Renderer Shape(string name, PrimitiveType type, Vector3 at, Vector3 size, Color color)
                {
                    var go = GameObject.CreatePrimitive(type); go.name = name; go.transform.SetParent(root.transform, false);
                    go.transform.localPosition = at; go.transform.localScale = size;
                    UnityEngine.Object.DestroyImmediate(go.GetComponent<Collider>());
                    var material = new Material(Shader.Find("Standard")) { color = color }; material.SetFloat("_Glossiness", .12f); materials.Add(material);
                    var renderer = go.GetComponent<Renderer>(); renderer.sharedMaterial = material; return renderer;
                }
                Shape("Authored desk", PrimitiveType.Cube, new Vector3(0f, -.43f, 2.4f), new Vector3(3.2f, .1f, 2.2f), new Color(.57f, .47f, .34f));
                Shape("Authored tabletop", PrimitiveType.Cube, new Vector3(0f, -.375f, 2.4f), new Vector3(3.2f, .012f, 2.2f), new Color(.64f, .55f, .41f));
                Shape("Authored window", PrimitiveType.Cube, new Vector3(-1.8f, .8f, 3.9f), new Vector3(1.1f, 1.65f, .025f), new Color(.84f, .87f, .81f));
                var mugColor = new Color(.76f, .73f, .66f);
                var mug = new List<Renderer> {
                    Shape("Synthetic ceramic mug", PrimitiveType.Cylinder, new Vector3(-.65f, -.23f, 1.80f), new Vector3(.29f, .145f, .29f), mugColor),
                    Shape("Synthetic mug opening", PrimitiveType.Cylinder, new Vector3(-.65f, -.083f, 1.80f), new Vector3(.252f, .003f, .252f), new Color(.22f, .19f, .15f)) };
                var handle = new GameObject("Synthetic mug handle"); handle.transform.SetParent(root.transform, false); handle.transform.position = new Vector3(-.485f, -.225f, 1.8f);
                var vertices = new List<Vector3>(); var indices = new List<int>(); const int rings = 40, tubes = 12;
                for (var i = 0; i <= rings; i++) for (var j = 0; j <= tubes; j++)
                {
                    var a = i * Mathf.PI * 2f / rings; var b = j * Mathf.PI * 2f / tubes;
                    vertices.Add(new Vector3((.067f + .018f * Mathf.Cos(b)) * Mathf.Cos(a), (.075f + .018f * Mathf.Cos(b)) * Mathf.Sin(a), .018f * Mathf.Sin(b)));
                    if (i < rings && j < tubes) { var p = i * (tubes + 1) + j; var q = p + tubes + 1; indices.AddRange(new[] { p, q, p + 1, p + 1, q, q + 1 }); }
                }
                var handleMesh = new Mesh { vertices = vertices.ToArray(), triangles = indices.ToArray() }; handleMesh.RecalculateNormals(); handleMesh.RecalculateBounds(); meshes.Add(handleMesh);
                handle.AddComponent<MeshFilter>().sharedMesh = handleMesh; var handleRenderer = handle.AddComponent<MeshRenderer>();
                var handleMaterial = new Material(Shader.Find("Standard")) { color = mugColor }; materials.Add(handleMaterial); handleRenderer.sharedMaterial = handleMaterial; mug.Add(handleRenderer);
                var book = new List<Renderer> {
                    Shape("Synthetic book pages", PrimitiveType.Cube, new Vector3(.60f, -.35f, 1.90f), new Vector3(.42f, .045f, .30f), new Color(.84f, .83f, .76f)),
                    Shape("Synthetic book top", PrimitiveType.Cube, new Vector3(.60f, -.322f, 1.90f), new Vector3(.44f, .014f, .32f), new Color(.24f, .31f, .27f)),
                    Shape("Synthetic book bottom", PrimitiveType.Cube, new Vector3(.60f, -.377f, 1.90f), new Vector3(.44f, .009f, .32f), new Color(.24f, .31f, .27f)) };
                var light = new GameObject("Synthetic room light").AddComponent<Light>(); light.transform.SetParent(root.transform, false);
                light.type = LightType.Directional; light.intensity = 1.1f; light.transform.rotation = Quaternion.Euler(30f, -30f, 0f); RenderSettings.ambientLight = new Color(.6f, .6f, .6f);
                var fixture = CompositionFixture(camera, mug, book);
                var room = root.AddComponent<RoomCamera>(); var hud = LiveSceneHud.Create(root.transform, head, room);
                var scene = SessionScene.Create(root.transform, room, head);
                var controls = ContextConsole.Create(root.transform, head); controls.SetReducedMotion(true); controls.ShowControlsOnly(new Vector3(0f, -.45f, 1.1f));
                var companion = CompanionOrb.Create(root.transform); companion.transform.position = new Vector3(-.52f, .18f, 1.25f); companion.transform.localScale = Vector3.one * 2f;
                companion.SetFrozen(true); companion.SetAttention(companion.transform.InverseTransformPoint(new Vector3(-.65f, -.23f, 1.8f))); companion.Refresh(0f, true);
                camera.targetTexture = target;
                foreach (var state in new[] { "standard", "large", "crowded", "expiry" })
                {
                    hud.SetActive(true, true); Require(hud.Show(fixture.Result, fixture.Request, fixture.Snapshot, 61f), "Recognizable composition source admission failed.");
                    if ((controls.ComfortScale > 1f) != (state == "large")) controls.Activate(ConsoleAction.Size);
                    controls.RefreshVisuals(1f); var occupied = new List<LabelRect>(); scene.AppendPresentationKeepouts(occupied, controls);
                    var viewer = new HeadPose(ToNumerics(head.position), ToNumerics(head.forward));
                    AppendRendererBounds(companion.GetComponentsInChildren<Renderer>(), viewer, occupied);
                    foreach (var action in controls.GetComponentsInChildren<SpatialAction>())
                    foreach (var collider in action.GetComponents<Collider>())
                    {
                        var controlAreas = new List<LabelRect>(); AppendWorldBounds(collider.bounds, viewer, controlAreas);
                        foreach (var prop in new[] { mug, book })
                        {
                            var propAreas = new List<LabelRect>(); AppendRendererBounds(prop, viewer, propAreas);
                            Require(controlAreas.All(control => ProjectedKeepout.IsClear(control, propAreas, .02f)), "Global controls touch a recognizable source prop.");
                        }
                    }
                    if (state == "crowded") occupied.Add(Bounds);
                    hud.SetAttentionRays(ToObject(room, fixture, 0, head.position), null); hud.RefreshAttention(61f, occupied, Center, controls.ComfortScale);
                    if (state == "crowded") Require(hud.VisibleObjects == 2 && !VisibleLabels(hud).Any(), "Crowded composition failed to withhold label.");
                    else Require(VisibleLabels(hud).Count() == 1, "Recognizable composition did not show one native proposed name.");
                    foreach (var label in VisibleLabels(hud)) CheckPlacement(label, head, room, fixture, occupied);
                    if (state == "expiry")
                    {
                        var label = VisibleLabels(hud).Single(); hud.SetAttentionRays(new Ray(head.position, label.Home - head.position), null);
                        hud.RefreshAttention(61.1f, occupied, Center, controls.ComfortScale); Require(hud.HasPresentationFocus, "Composition expiry lacked original label hold.");
                        hud.RefreshAttention(63.001f, occupied, Center, controls.ComfortScale);
                        Require(hud.VisibleObjects == 0 && !VisibleLabels(hud).Any() && !hud.HasPresentationFocus, "Composition expired source remained visible.");
                        companion.ReturnHome(); companion.Refresh(0f, true);
                    }
                    foreach (var text in root.GetComponentsInChildren<TextMeshPro>())
                    {
                        text.ForceMeshUpdate(true, true); Require(!text.isTextOverflowing, "Composition text overflowed.");
                        foreach (var glyph in text.textInfo.characterInfo.Take(text.textInfo.characterCount).Where(glyph => glyph.isVisible))
                        foreach (var corner in new[] { glyph.bottomLeft, glyph.topRight })
                        {
                            var at = camera.WorldToViewportPoint(text.transform.TransformPoint(corner));
                            Require(at.z > 0f && at.x >= 0f && at.x <= 1f && at.y >= 0f && at.y <= 1f, "Composition words leave the rendered view.");
                        }
                    }
                    ReadPixels(camera, target, pixels); File.WriteAllBytes(Path.Combine(output, state + ".png"), pixels.EncodeToPNG());
                }
                File.WriteAllText(Path.Combine(output, "README.txt"), "AA0 actual native HUD/Chip/global controls with recognizable authored mug/book and actual existing companion attention API. Authored render silhouettes and explicit synthetic plane-depth fixture, no detector or world capture. No hand-pointing API exists; no pointing/motion/stereo/comfort/device proof. No actions, confirmation or save.\n");
                Debug.Log("Boopy recognizable native AA0 composition renders: " + output);
            }
            finally
            {
                camera.targetTexture = null; RenderTexture.active = prior;
                UnityEngine.Object.DestroyImmediate(pixels); UnityEngine.Object.DestroyImmediate(target); UnityEngine.Object.DestroyImmediate(root);
                foreach (var material in materials) UnityEngine.Object.DestroyImmediate(material); foreach (var mesh in meshes) UnityEngine.Object.DestroyImmediate(mesh);
            }
        }

        private static void AppendRendererBounds(IEnumerable<Renderer> renderers, HeadPose viewer, List<LabelRect> areas)
        { foreach (var renderer in renderers) if (renderer.gameObject.activeInHierarchy) AppendWorldBounds(renderer.bounds, viewer, areas); }
        private static void AppendWorldBounds(UnityEngine.Bounds bounds, HeadPose viewer, List<LabelRect> areas)
        {
            var points = new List<N.Vector3>();
            for (var i = 0; i < 8; i++) points.Add(ToNumerics(new Vector3((i & 1) == 0 ? bounds.min.x : bounds.max.x,
                (i & 2) == 0 ? bounds.min.y : bounds.max.y, (i & 4) == 0 ? bounds.min.z : bounds.max.z)));
            if (ProjectedKeepout.TryEnvelope(points, viewer, out var area)) areas.Add(area);
        }

        private static Synthetic CompositionFixture(Camera camera, List<Renderer> mug, List<Renderer> book)
        {
            const int width = 800, height = 500; var focal = height / (2f * Mathf.Tan(camera.fieldOfView * Mathf.Deg2Rad / 2f));
            var depth = new DepthGrid { Columns = 32, Rows = 20, Meters = new float?[640] }; var n = 0;
            foreach (var cell in Geometry.CellCenters(depth.Columns, depth.Rows))
            { var ray = camera.ViewportPointToRay(new Vector3(cell.X, 1f - cell.Y, 0f)); depth.Meters[n++] = 1.55f / ray.direction.z; }
            var snapshot = new Snapshot(new byte[] { 1 }, width, height, new DateTime(1970, 1, 1, 6, 0, 0, DateTimeKind.Utc),
                new Pose(Vector3.zero, Quaternion.identity), depth, new CameraInfo { Pose = new Pose3 { Rotation = new[] { 0f, 0f, 0f, 1f } },
                    FocalLength = new[] { focal, focal }, PrincipalPoint = new[] { width / 2f, height / 2f }, SensorResolution = new[] { width, height } }, 60f);
            var request = new SceneObservationRequest { StreamId = "11111111-1111-4111-8111-111111111111", FrameId = Guid.NewGuid().ToString(), Sequence = 60, Frame = snapshot.ToFrame() };
            var result = new SceneObservation { StreamId = request.StreamId, FrameId = request.FrameId, Sequence = 60, CapturedAt = request.Frame.CapturedAt,
                FrameSha256 = "4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a", EventId = "synthetic-composition-event", Provider = "authored-fixture", Model = "synthetic-silhouette", Verification = "proposed" };
            result.Objects.Add(AuthoredMask(camera, mug, "Mug", width, height)); result.Objects.Add(AuthoredMask(camera, book, "Book", width, height));
            return new Synthetic { Snapshot = snapshot, Request = request, Result = result };
        }

        private static SceneObject AuthoredMask(Camera camera, List<Renderer> shapes, string label, int width, int height)
        {
            var target = new RenderTexture(width, height, 24) { antiAliasing = 1 }; target.Create();
            var pixels = new Texture2D(width, height, TextureFormat.RGB24, false); var white = new Material(Shader.Find("Unlit/Color")) { color = Color.white };
            var oldTarget = camera.targetTexture; var oldActive = RenderTexture.active; var oldMask = camera.cullingMask; var oldBackground = camera.backgroundColor;
            var materials = shapes.Select(shape => shape.sharedMaterial).ToArray(); var layers = shapes.Select(shape => shape.gameObject.layer).ToArray(); Color32[] mask;
            try
            {
                foreach (var shape in shapes) { shape.gameObject.layer = 30; shape.sharedMaterial = white; }
                camera.cullingMask = 1 << 30; camera.backgroundColor = Color.black; camera.targetTexture = target;
                mask = ReadPixels(camera, target, pixels);
            }
            finally
            {
                for (var i = 0; i < shapes.Count; i++) { shapes[i].sharedMaterial = materials[i]; shapes[i].gameObject.layer = layers[i]; }
                camera.targetTexture = oldTarget; camera.cullingMask = oldMask; camera.backgroundColor = oldBackground; RenderTexture.active = oldActive;
                UnityEngine.Object.DestroyImmediate(target); UnityEngine.Object.DestroyImmediate(pixels); UnityEngine.Object.DestroyImmediate(white);
            }
            bool Inside(Vector2Int point) => point.x >= 0 && point.y >= 0 && point.x < width && point.y < height && mask[point.y * width + point.x].r > 127;
            var start = new Vector2Int(-1, -1);
            for (var y = 0; y < height && start.x < 0; y++) for (var x = 0; x < width; x++) if (Inside(new Vector2Int(x, y))) { start = new Vector2Int(x, y); break; }
            Require(start.x >= 0, "Authored synthetic mask was empty.");
            var around = new[] { new Vector2Int(1, 0), new Vector2Int(1, -1), new Vector2Int(0, -1), new Vector2Int(-1, -1), new Vector2Int(-1, 0), new Vector2Int(-1, 1), new Vector2Int(0, 1), new Vector2Int(1, 1) };
            var current = start; var previous = start + Vector2Int.left; var boundary = new List<Vector2Int>();
            for (var step = 0; step < 16000; step++)
            {
                boundary.Add(current); var at = Array.IndexOf(around, previous - current); Require(at >= 0, "Authored boundary lost adjacency."); var found = false;
                for (var offset = 1; offset <= 8; offset++)
                { var next = current + around[(at + offset) % 8]; if (!Inside(next)) continue; previous = current + around[(at + offset - 1) % 8]; current = next; found = true; break; }
                Require(found, "Authored synthetic contour is isolated."); if (current == start && step > 8) break;
            }
            Require(current == start && boundary.Count > 8, "Authored synthetic contour did not close.");
            var contour = new List<Point2>(); var stride = Mathf.CeilToInt(boundary.Count / 192f);
            for (var i = 0; i < boundary.Count; i += stride) contour.Add(new Point2 { X = (boundary[i].x + .5f) / width, Y = 1f - (boundary[i].y + .5f) / height });
            var bytes = mask.Select(pixel => pixel.r).ToArray(); using var sha = System.Security.Cryptography.SHA256.Create();
            return new SceneObject { Label = label, Confidence = .4f, MaskConfidence = 1f, MaskPixels = bytes.Count(value => value > 127),
                MaskSha256 = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(), Contour = contour,
                Box = new Box2 { X0 = contour.Min(point => point.X), Y0 = contour.Min(point => point.Y), X1 = contour.Max(point => point.X), Y1 = contour.Max(point => point.Y) } };
        }

        public static void Render()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var root = new GameObject("Synthetic source-bound native rendering");
            var output = Path.Combine(Path.GetTempPath(), "boopy-scene-native03-v3-aa0"); Directory.CreateDirectory(output);
            var head = new GameObject("Fixed synthetic viewer").transform; head.SetParent(root.transform, false);
            var camera = head.gameObject.AddComponent<Camera>(); camera.fieldOfView = 64f; camera.aspect = 1.6f;
            camera.nearClipPlane = .05f; camera.farClipPlane = 10f; camera.allowHDR = false; camera.allowMSAA = false;
            camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = new Color(.34f, .36f, .33f);
            var target = new RenderTexture(1600, 1000, 24) { antiAliasing = 1 }; target.Create();
            var pixels = new Texture2D(1600, 1000, TextureFormat.RGB24, false); var prior = RenderTexture.active;
            var materials = new List<Material>();
            var meshes = new List<Mesh>();
            try
            {
                var room = root.AddComponent<RoomCamera>(); var hud = LiveSceneHud.Create(root.transform, head, room);
                var fixture = Fixture(30f, 30); fixture.Result.Objects[0].Label = "Marker"; fixture.Result.Objects[1].Label = "Display";
                var scene = SessionScene.Create(root.transform, room, head);
                var controls = ContextConsole.Create(root.transform, head); controls.SetReducedMotion(true);
                controls.ShowControlsOnly(new Vector3(.58f, -.42f, 1.2f));
                var light = new GameObject("Synthetic studio light").AddComponent<Light>(); light.transform.SetParent(root.transform, false);
                light.type = LightType.Directional; light.intensity = 1.1f; light.transform.rotation = Quaternion.Euler(30f, -30f, 0f);
                RenderSettings.ambientLight = new Color(.65f, .65f, .65f);
                foreach (var item in fixture.Result.Objects)
                {
                    var boundary = room.PlaceBoundary(item.GroundingFor(fixture.Result), fixture.Snapshot, out _);
                    Require(Geometry.TryContour(item.GroundingFor(fixture.Result), out var contour)
                        && SurfaceGeometry.TryTriangulate(contour, out _), "Synthetic prop contour did not triangulate.");
                    SurfaceGeometry.TryTriangulate(contour, out var triangles);
                    var prop = new GameObject("Synthetic source silhouette"); prop.transform.SetParent(root.transform, false);
                    var mesh = new Mesh { name = "Authored source silhouette" };
                    mesh.vertices = boundary.Select(point => point + Vector3.forward * .012f).ToArray();
                    mesh.triangles = triangles.Concat(triangles.Reverse()).ToArray(); mesh.RecalculateBounds(); meshes.Add(mesh);
                    prop.AddComponent<MeshFilter>().sharedMesh = mesh;
                    var material = new Material(Visuals.Solid); material.color = item.Label == "Marker"
                        ? new Color(.71f, .65f, .48f) : new Color(.25f, .31f, .29f);
                    materials.Add(material); prop.AddComponent<MeshRenderer>().sharedMaterial = material;
                }
                camera.targetTexture = target;
                Color32[]? crowdedPixels = null;
                foreach (var state in new[] { "standard", "large", "crowded", "expiry" })
                {
                    hud.SetActive(true, true); Require(hud.Show(fixture.Result, fixture.Request, fixture.Snapshot, 31f), "Render admission failed.");
                    if ((controls.ComfortScale > 1f) != (state == "large")) controls.Activate(ConsoleAction.Size);
                    controls.RefreshVisuals(1f);
                    var occupied = new List<LabelRect>(); scene.AppendPresentationKeepouts(occupied, controls);
                    if (state == "crowded") occupied.Add(Bounds);
                    hud.SetAttentionRays(ToObject(room, fixture, 0, head.position), null);
                    hud.RefreshAttention(31f, occupied, Center, controls.ComfortScale);
                    foreach (var visible in VisibleLabels(hud)) { visible.Face(head); CheckPlacement(visible, head, room, fixture, occupied); }
                    if (state == "crowded") Require(hud.VisibleObjects == 2 && !VisibleLabels(hud).Any(), "Crowded render did not retain quiet contours and withhold the label.");
                    else Require(VisibleLabels(hud).Count() == 1, "Render did not exercise one actual native attended label.");
                    if (state == "expiry")
                    {
                        var visible = VisibleLabels(hud).Single(); hud.SetAttentionRays(new Ray(head.position, visible.Home - head.position), null);
                        hud.RefreshAttention(31.1f, occupied, Center, controls.ComfortScale);
                        Require(hud.HasPresentationFocus, "Expiry render did not first enter own-label hold.");
                        hud.RefreshAttention(33.001f, occupied, Center, controls.ComfortScale);
                        Require(hud.VisibleObjects == 0 && !VisibleLabels(hud).Any() && !hud.HasPresentationFocus, "Expiry render retained source evidence.");
                    }
                    foreach (var text in root.GetComponentsInChildren<TextMeshPro>()) text.ForceMeshUpdate(true, true);
                    camera.Render(); RenderTexture.active = target; pixels.ReadPixels(new Rect(0, 0, 1600, 1000), 0, 0); pixels.Apply();
                    File.WriteAllBytes(Path.Combine(output, state + ".png"), pixels.EncodeToPNG());
                    if (state == "crowded") crowdedPixels = pixels.GetPixels32();
                    if (state == "expiry")
                    {
                        var expiredPixels = pixels.GetPixels32(); var changed = 0;
                        for (var i = 0; crowdedPixels != null && i < crowdedPixels.Length; i++)
                            if (!crowdedPixels[i].Equals(expiredPixels[i])) changed++;
                        Debug.Log("Boopy AA0 quiet-source versus expiry changed pixels: " + changed);
                        Require(changed >= 128, "Quiet current contours have no bounded visible AA0 pixel evidence distinct from expiry.");
                    }
                }
                File.WriteAllText(Path.Combine(output, "README.txt"), "Synthetic captured request/pose/depth, authored source silhouettes and contours, actual native HUD/Chip/global controls. Standard and large show one attended proposed name; crowded withholds label; expiry removes evidence during own-label hold. No model call, world text, action bridge, installation, motion/stereo/comfort or headset performance proof.\n");
                Debug.Log("Boopy native03 synthetic renders: " + output);
            }
            finally
            {
                camera.targetTexture = null; RenderTexture.active = prior;
                UnityEngine.Object.DestroyImmediate(pixels); UnityEngine.Object.DestroyImmediate(target);
                UnityEngine.Object.DestroyImmediate(root); foreach (var material in materials) UnityEngine.Object.DestroyImmediate(material);
                foreach (var mesh in meshes) UnityEngine.Object.DestroyImmediate(mesh);
            }
        }

        public static void Validate()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var root = new GameObject("Synthetic native live mechanics");
            try
            {
                var head = new GameObject("Synthetic eyes").transform; head.SetParent(root.transform, false);
                var room = root.AddComponent<RoomCamera>();
                var hud = LiveSceneHud.Create(root.transform, head, room);
                var fixture = Fixture(10f, 7);
                Require(hud.Show(fixture.Result, fixture.Request, fixture.Snapshot, 11f), "Valid captured source was rejected.");
                Require(!VisibleLabels(hud).Any(), "Unattended source created a label.");
                hud.SetAttentionRays(ToObject(room, fixture, 0, head.position), null);
                hud.RefreshAttention(11f, Empty, Center, 1f);
                var chip = VisibleLabels(hud).SingleOrDefault();
                Require(chip != null && hud.CurrentTarget?.ObjectIndex == 0, "Actual attended contour has no proposed native label.");
                Require(chip!.ItemId == "" && !chip.GetComponentsInChildren<Collider>(true).Any(c => c.enabled),
                    "Live presentation fabricated an item identity or entered the correction hit path.");
                var words = chip.GetComponentsInChildren<TextMeshPro>().Where(text => text.gameObject.activeInHierarchy).ToArray();
                Require(words.Length == 1 && words[0].text == "Synthetic left?" && words[0].font == BoopyTypography.Medium,
                    "Live label does not use the concise proposed name and Plex presentation.");
                Require(hud.GetComponentsInChildren<SpatialAction>(true).Length == 0, "Unsupported live actions appeared.");
                Require(fixture.Result.Verification == "proposed" && fixture.Result.Objects[0].Confidence == .4f,
                    "Attention confirmed or rewrote detector evidence.");
                Require(chip.Anchor.HasValue && OnBoundary(chip.Anchor.Value,
                    room.PlaceBoundary(fixture.Result.Objects[0].GroundingFor(fixture.Result), fixture.Snapshot, out _)),
                    "Leader does not end on its own actual placed outline.");
                CheckPlacement(chip, head, room, fixture, Empty);
                ValidateNeighbors(root, head, room, hud, fixture);
                var wrong = Fixture(10f, 7);
                Require(!hud.Show(fixture.Result, wrong.Request, fixture.Snapshot, 11f), "Request identity mismatch was admitted.");
                Require(!hud.Show(fixture.Result, fixture.Request, Fixture(10.1f, 7).Snapshot, 11f), "Snapshot capture time mismatch was admitted.");
                var wrongPixels = new Snapshot(new byte[] { 2 }, fixture.Snapshot.Width, fixture.Snapshot.Height,
                    fixture.Snapshot.CapturedAt, fixture.Snapshot.Pose, fixture.Snapshot.Depth, fixture.Snapshot.Camera, 10f);
                Require(!hud.Show(fixture.Result, fixture.Request, wrongPixels, 11f), "Snapshot/request pixel mismatch was admitted.");
                var wrongPose = new Snapshot(fixture.Snapshot.Jpeg, fixture.Snapshot.Width, fixture.Snapshot.Height,
                    fixture.Snapshot.CapturedAt, new Pose(new Vector3(.5f, 0f, 0f), Quaternion.identity), fixture.Snapshot.Depth, fixture.Snapshot.Camera, 10f);
                Require(!hud.Show(fixture.Result, fixture.Request, wrongPose, 11f), "Snapshot placement pose disagreed with request camera pose but was admitted.");
                Require(hud.Show(fixture.Result, fixture.Request, fixture.Snapshot, 11f), "Original source could not resume after negative admissions.");
                hud.SetAttentionRays(ToObject(room, fixture, 0, head.position), null);
                hud.RefreshAttention(11f, Empty, Center, 1f);
                chip = VisibleLabels(hud).Single();
                foreach (var overlay in hud.GetComponentsInChildren<GroundedOverlay>())
                    Require(!overlay.GetComponentsInChildren<MeshRenderer>().Any(renderer => renderer.enabled),
                        "Ambient attention created a filled or breathing surface.");

                // Reading the label retains only its original target and source lifetime.
                var original = hud.CurrentTarget;
                hud.SetAttentionRays(new Ray(head.position, chip.Home - head.position), null);
                hud.RefreshAttention(11.2f, Empty, Center, 1f);
                Require(hud.HasPresentationFocus && ReferenceEquals(hud.CurrentTarget, original),
                    "Targeting its own label immediately lost its source or selected a new object.");
                hud.RefreshAttention(13f, Empty, Center, 1f);
                Require(hud.HasPresentationFocus && VisibleLabels(hud).Count() == 1, "Inclusive source lifetime changed.");
                hud.RefreshAttention(13.001f, Empty, Center, 1f);
                Require(!hud.HasPresentationFocus && hud.CurrentTarget == null && !VisibleLabels(hud).Any() && hud.VisibleObjects == 0,
                    "Own-label focus renewed source time or kept expired evidence visible.");

                Require(hud.Show(fixture.Result, fixture.Request, fixture.Snapshot, 11f), "Fresh synthetic source did not resume.");
                hud.SetAttentionRays(ToObject(room, fixture, 0, head.position), new Ray(head.position, Vector3.up));
                hud.RefreshAttention(11f, Empty, Center, 1f);
                Require(hud.CurrentTarget == null && !VisibleLabels(hud).Any(), "Active hand miss fell back to a head target.");
                hud.SetAttentionRays(ToObject(room, fixture, 0, head.position), ToObject(room, fixture, 1, head.position));
                hud.RefreshAttention(11f, Empty, Center, 1f);
                Require(hud.CurrentTarget?.ObjectIndex == 1 && hud.CurrentTarget.FromPointer, "Current active hand did not win.");

                // A new admission clears old attention before any independent new contour hit.
                var replacement = Fixture(10.5f, 8);
                replacement.Result.Objects[0].Label = "Synthetic unusually long proposed category with shape";
                Require(hud.Show(replacement.Result, replacement.Request, replacement.Snapshot, 11f), "Replacement was not admitted.");
                Require(hud.CurrentTarget == null && !hud.HasPresentationFocus && !VisibleLabels(hud).Any(),
                    "Replacement inherited selection, label or focus from another source.");
                hud.SetAttentionRays(ToObject(room, replacement, 0, head.position), null);
                hud.RefreshAttention(11f, new[] { Bounds }, Center, 1f);
                Require(hud.VisibleObjects == 2 && !VisibleLabels(hud).Any() && !hud.HasPresentationFocus,
                    "No-space layout covered protected content or cleared still-current quiet contours.");
                foreach (var scale in new[] { 1f, 1.2f })
                {
                    hud.RefreshAttention(11f, Empty, Center, scale);
                    chip = VisibleLabels(hud).SingleOrDefault();
                    Require(chip != null, "Measured standard/large label could not fit the synthetic clear view.");
                    CheckPlacement(chip!, head, room, replacement, Empty);
                }
                var placed = hud.GetComponentsInChildren<GroundedOverlay>().Select(overlay =>
                {
                    var line = overlay.GetComponentInChildren<LineRenderer>();
                    var positions = new Vector3[line.positionCount]; line.GetPositions(positions); return positions;
                }).ToArray();
                head.position = new Vector3(.12f, .03f, 0f);
                hud.SetAttentionRays(ToObject(room, replacement, 0, head.position), null);
                hud.RefreshAttention(11.2f, Empty, Center, 1.2f);
                var moved = hud.GetComponentsInChildren<GroundedOverlay>();
                for (var i = 0; i < moved.Length; i++)
                {
                    var line = moved[i].GetComponentInChildren<LineRenderer>();
                    var positions = new Vector3[line.positionCount]; line.GetPositions(positions);
                    Require(positions.SequenceEqual(placed[i]), "Head movement relocated captured source geometry.");
                }
                foreach (var visible in VisibleLabels(hud)) CheckPlacement(visible, head, room, replacement, Empty);
                hud.SetActive(true, true);
                hud.RefreshAttention(11.3f, Empty, Center, 1f);
                var reduced = VisibleLabels(hud).Single(); var home = reduced.Home;
                hud.Refresh(.5f, 11.8f); hud.RefreshAttention(11.8f, Empty, Center, 1f);
                Require(reduced.Home == home, "Reduced motion displaced an unchanged safe label.");
                hud.SetPaused(true);
                Require(hud.CurrentTarget == null && !hud.HasPresentationFocus && !VisibleLabels(hud).Any(), "Pause retained live presentation.");
                hud.SetPaused(false);
                Require(!hud.Show(fixture.Result, fixture.Request, fixture.Snapshot, 14f), "Delayed receipt renewed old source age.");
                var ambiguous = Fixture(14f, 9);
                ambiguous.Result.Objects[1].Box = ambiguous.Result.Objects[0].Box;
                ambiguous.Result.Objects[1].Contour = ambiguous.Result.Objects[0].Contour;
                Require(hud.Show(ambiguous.Result, ambiguous.Request, ambiguous.Snapshot, 14.1f), "Valid ambiguous evidence was discarded.");
                hud.SetAttentionRays(ToObject(room, ambiguous, 0, head.position), null);
                hud.RefreshAttention(14.1f, Empty, Center, 1f);
                Require(hud.CurrentTarget == null && !VisibleLabels(hud).Any(), "Overlapping captured surfaces fabricated an attended object.");
                var reordered = Fixture(14f, 10); reordered.Result.Objects.Reverse();
                Require(hud.Show(reordered.Result, reordered.Request, reordered.Snapshot, 14.1f), "Reordered source could not be admitted.");
                hud.SetAttentionRays(ToObject(room, reordered, 0, head.position), null);
                hud.RefreshAttention(14.1f, Empty, Center, 1f);
                Require(hud.CurrentTarget?.ObjectIndex == 0 && VisibleLabels(hud).Single().GetComponentsInChildren<TextMeshPro>()
                    .Single(text => text.gameObject.activeInHierarchy).text == "Synthetic right?", "Display sorting changed original proposal identity.");
                ValidateCaller(root, head, room, hud);
                Debug.Log("Boopy native live mechanics passed; synthetic source/rays/time, no design acceptance or headset claim.");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }

        private static void ValidateCaller(GameObject root, Transform head, RoomCamera room, LiveSceneHud hud)
        {
            head.position = Vector3.zero; head.rotation = Quaternion.identity;
            var console = ContextConsole.Create(root.transform, head); console.Place(new Vector3(.6f, -.3f, 1.2f));
            var scene = SessionScene.Create(root.transform, room, head);
            var app = root.AddComponent<BoopyApp>();
            Set(app, "head", head); Set(app, "room", room); Set(app, "console", console);
            Set(app, "scene", scene); Set(app, "liveHud", hud); Set(app, "inputAllowed", true);
            Set(app, "connectionLiveSceneAvailable", true); Set(app, "liveScenePaused", false);
            var original = Fixture(20f, 20); var replacement = Fixture(20.5f, 21);
            hud.SetActive(true, true);
            using var accepted = new CancellationTokenSource();
            Require((bool)Call(app, "ApplyLiveSceneResult", original.Result, original.Request, original.Snapshot, accepted, 21f)!,
                "Actual asynchronous admission path did not show a valid synthetic source.");
            hud.SetAttentionRays(ToObject(room, original, 0, head.position), null);
            hud.RefreshAttention(21f, Empty, Center, 1f);
            var chip = VisibleLabels(hud).Single();
            hud.SetAttentionRays(new Ray(head.position, chip.Home - head.position), null);
            hud.RefreshAttention(21.1f, Empty, Center, 1f);
            Require(hud.HasPresentationFocus, "Caller fixture did not enter own-label focus.");
            using var inFlight = new CancellationTokenSource(); Set(app, "liveRequest", inFlight);
            Call(app, "UpdateLiveScene", 21.2f);
            Require(inFlight.IsCancellationRequested && hud.CurrentTarget?.EventId == original.Result.EventId && VisibleLabels(hud).Any(),
                "Own-label capture hold cleared its current label or failed to cancel ambient work.");
            using var uncanceledReply = new CancellationTokenSource();
            Require(!(bool)Call(app, "ApplyLiveSceneResult", replacement.Result, replacement.Request, replacement.Snapshot, uncanceledReply, 21.3f)!,
                "In-flight replacement was applied while reading the original source label.");
            Require(hud.CurrentTarget?.EventId == original.Result.EventId, "Dropped reply changed held source identity.");
            hud.SetAttentionRays(ToObject(room, original, 0, head.position), null);
            hud.RefreshAttention(21.4f, Empty, Center, 1f);
            using var afterExit = new CancellationTokenSource(); Set(app, "liveRequest", afterExit);
            Call(app, "UpdateLiveScene", 21.4f);
            Require(!hud.HasPresentationFocus && !afterExit.IsCancellationRequested
                && (bool)app.GetType().GetProperty("AmbientCaptureAllowed", Private)!.GetValue(app)!,
                "Leaving the label did not release the actual capture-only gate.");
            chip = VisibleLabels(hud).Single();
            hud.SetAttentionRays(new Ray(head.position, chip.Home - head.position), null);
            hud.RefreshAttention(21.5f, Empty, Center, 1f);
            hud.RefreshAttention(23.001f, Empty, Center, 1f); Set(app, "liveRequest", null);
            Call(app, "UpdateLiveScene", 23.001f);
            Require(!hud.HasPresentationFocus && hud.CurrentTarget == null && !VisibleLabels(hud).Any()
                && (bool)app.GetType().GetProperty("AmbientCaptureAllowed", Private)!.GetValue(app)!,
                "Expiry did not release the real capture gate, or restored a stale label.");
            Require((bool)Call(app, "ApplyLiveSceneResult", replacement.Result, replacement.Request, replacement.Snapshot, uncanceledReply, 23.001f)!,
                "Fresh replacement could not enter after hold expiry.");
            hud.SetAttentionRays(ToObject(room, replacement, 0, head.position), null);
            hud.RefreshAttention(23.001f, Empty, Center, 1f);
            Set(console, "focused", ConsoleAction.Talk);
            using var suppressed = new CancellationTokenSource(); Set(app, "liveRequest", suppressed);
            Call(app, "UpdateLiveScene", 23.1f);
            Require(suppressed.IsCancellationRequested && hud.VisibleObjects == 0 && hud.CurrentTarget == null && !VisibleLabels(hud).Any(),
                "Unrelated control focus did not clear the entire ambient presentation.");
            Require(!(bool)Call(app, "ApplyLiveSceneResult", replacement.Result, replacement.Request, replacement.Snapshot, uncanceledReply, 23.1f)!,
                "Late result restored a suppressed source.");
            Set(console, "focused", ConsoleAction.None); Set(app, "liveRequest", null);
        }

        private static void ValidateNeighbors(GameObject root, Transform head, RoomCamera room, LiveSceneHud hud, Synthetic fixture)
        {
            var controls = ContextConsole.Create(root.transform, head);
            var scene = SessionScene.Create(root.transform, room, head);
            try
            {
                scene.Remember("synthetic-neighbor-observation", fixture.Snapshot);
                scene.PlaceConsole(controls);
                var view = new SessionView { Id = "synthetic-neighbor-session", State = "review", ReferentId = "synthetic-neighbor-item" };
                view.Items.Add(new Item { Id = "synthetic-neighbor-item", Kind = "object", Status = "proposed", Label = "Neighbor proposal",
                    Grounding = new Grounding { Kind = "box", ObservationId = "synthetic-neighbor-observation",
                        Box = new Box2 { X0 = .4f, Y0 = .12f, X1 = .55f, Y1 = .2f } } });
                scene.Render(view);
                foreach (var scale in new[] { 1f, 1.2f })
                {
                    if ((controls.ComfortScale > 1f) != (scale > 1f)) controls.Activate(ConsoleAction.Size);
                    controls.RefreshVisuals(1f);
                    foreach (var neighbor in scene.GetComponentsInChildren<Chip>()) neighbor.Face(head);
                    var occupied = new List<LabelRect>(); scene.AppendPresentationKeepouts(occupied, controls);
                    Require(occupied.Count >= 4, "Real controls, conversation label and captured object envelopes were not collected.");
                    hud.RefreshAttention(11f, occupied, Center, scale);
                    foreach (var live in VisibleLabels(hud)) CheckPlacement(live, head, room, fixture, occupied);
                }
            }
            finally { UnityEngine.Object.DestroyImmediate(scene.gameObject); UnityEngine.Object.DestroyImmediate(controls.gameObject); }
        }

        private static IEnumerable<Chip> VisibleLabels(LiveSceneHud hud) =>
            hud.GetComponentsInChildren<Chip>(true).Where(chip => chip.gameObject.activeInHierarchy);

        private static void CheckPlacement(Chip chip, Transform head, RoomCamera room, Synthetic fixture, IReadOnlyList<LabelRect> occupied)
        {
            chip.Face(head);
            foreach (var text in chip.GetComponentsInChildren<TextMeshPro>())
            {
                text.ForceMeshUpdate(true, true);
                Require(!text.isTextOverflowing, "Native proposed name overflowed its measured text rectangle.");
            }
            var half = chip.LayoutSize * .5f;
            var corners = new[] { new Vector3(-half.x, -half.y, 0f), new Vector3(half.x, -half.y, 0f),
                new Vector3(half.x, half.y, 0f), new Vector3(-half.x, half.y, 0f) };
            var world = corners.Select(point => chip.transform.TransformPoint(point)).Select(ToNumerics).ToArray();
            var viewer = new HeadPose(ToNumerics(head.position), ToNumerics(head.forward));
            Require(ProjectedKeepout.TryEnvelope(world, viewer, out var footprint) && Bounds.Contains(footprint)
                && !footprint.Intersects(Center, .02f) && ProjectedKeepout.IsClear(footprint, occupied, .02f),
                "Actual measured label intersects center, controls, another label or view bounds.");
            foreach (var item in fixture.Result.Objects)
            foreach (var grounding in new[] { item.GroundingFor(fixture.Result), new Grounding { Kind = "box", Box = item.Box } })
            {
                var boundary = room.PlaceBoundary(grounding, fixture.Snapshot, out _).Select(ToNumerics).ToArray();
                Require(!ProjectedKeepout.TryEnvelope(boundary, viewer, out var area) || !footprint.Intersects(area, .02f),
                    "Actual label footprint covers a captured contour or original box.");
            }
        }

        private sealed class Synthetic
        {
            public SceneObservation Result = null!;
            public SceneObservationRequest Request = null!;
            public Snapshot Snapshot = null!;
        }
        private static Synthetic Fixture(float sourceTime, int sequence, float distance = 1.8f)
        {
            var snapshot = new Snapshot(new byte[] { 1 }, 80, 80,
                new DateTime(1970, 1, 1, 12, 0, 0, DateTimeKind.Utc).AddSeconds(sourceTime),
                new Pose(Vector3.zero, Quaternion.identity), new DepthGrid { Columns = 1, Rows = 1, Meters = new float?[] { distance } },
                new CameraInfo { Pose = new Pose3 { Position = new float[3], Rotation = new[] { 0f, 0f, 0f, 1f } },
                    FocalLength = new[] { 40f, 40f }, PrincipalPoint = new[] { 40f, 40f }, SensorResolution = new[] { 80, 80 } }, sourceTime);
            var request = new SceneObservationRequest {
                StreamId = "11111111-1111-4111-8111-111111111111", FrameId = Guid.NewGuid().ToString(), Sequence = sequence, Frame = snapshot.ToFrame()
            };
            var result = new SceneObservation {
                StreamId = request.StreamId, FrameId = request.FrameId, Sequence = sequence, CapturedAt = request.Frame.CapturedAt,
                FrameSha256 = "4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a",
                EventId = "synthetic-event-" + sequence, Provider = "fixture", Model = "synthetic", Verification = "proposed"
            };
            foreach (var left in new[] { .15f, .65f })
            {
                var box = new Box2 { X0 = left, Y0 = .35f, X1 = left + .2f, Y1 = .65f };
                result.Objects.Add(new SceneObject {
                    Label = left < .5f ? "Synthetic left" : "Synthetic right", Confidence = .4f, MaskConfidence = .8f,
                    MaskPixels = 500, MaskSha256 = new string(left < .5f ? 'b' : 'c', 64), Box = box,
                    Contour = Geometry.Corners(box).Select(point => new Point2 { X = point.X, Y = point.Y }).ToList()
                });
            }
            return new Synthetic { Result = result, Request = request, Snapshot = snapshot };
        }
        private static Ray ToObject(RoomCamera room, Synthetic fixture, int index, Vector3 origin)
        {
            var points = room.PlaceBoundary(fixture.Result.Objects[index].GroundingFor(fixture.Result), fixture.Snapshot, out _);
            var center = points.Aggregate(Vector3.zero, (sum, point) => sum + point) / points.Length;
            return new Ray(origin, center - origin);
        }
        private static bool OnBoundary(Vector3 anchor, IReadOnlyList<Vector3> points)
        {
            for (var i = 0; i < points.Count; i++)
            {
                var a = points[i]; var edge = points[(i + 1) % points.Count] - a;
                var amount = edge.sqrMagnitude > 0 ? Mathf.Clamp01(Vector3.Dot(anchor - a, edge) / edge.sqrMagnitude) : 0f;
                if ((anchor - a - edge * amount).sqrMagnitude <= 1e-8f) return true;
            }
            return false;
        }
        private static N.Vector3 ToNumerics(Vector3 point) => new N.Vector3(point.x, point.y, point.z);
        private static object? Call(object target, string method, params object[] args) => target.GetType().GetMethod(method, Private)!.Invoke(target, args);
        private static void Set(object target, string field, object? value) => target.GetType().GetField(field, Private)!.SetValue(target, value);
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
