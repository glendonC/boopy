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
    }
}
