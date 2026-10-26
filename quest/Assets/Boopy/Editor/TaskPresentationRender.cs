#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>
    /// Stills of the production task presentation in a synthetic room with a synthetic outlined
    /// subject: the task, after an answer, and a wrong item, at standard and large text. Synthetic
    /// views and transport through BoopyApp; not a wearer, timing or provider result.
    /// SpatialPreview shows no console for two reasons: it never creates or docks a dialogue strip,
    /// and its captures refresh the console with a zero time step right after every surface's
    /// reveal was reset to zero, so the console, its text and its controls stay transparent.
    /// These stills dock the strip and advance the reveal before each capture.
    /// </summary>
    public static class TaskPresentationRender
    {
        private const int Width = 1600, Height = 900;

        public static void Render()
        {
            var output = Path.Combine(Path.GetTempPath(), "boopy-task-preview");
            var context = SynchronizationContext.Current;
            try
            {
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                ScriptCoverage.Install();
                SynchronizationContext.SetSynchronizationContext(null);
                Directory.CreateDirectory(output);
                foreach (var large in new[] { false, true }) RenderSize(output, large);
                Owner(output);
                Debug.Log("Boopy task presentation stills: " + output);
            }
            catch (Exception error)
            {
                Debug.LogException(error);
                if (Application.isBatchMode) EditorApplication.Exit(1);
                else throw;
            }
            finally { SynchronizationContext.SetSynchronizationContext(context); }
        }

        private static void RenderSize(string output, bool large)
        {
            var size = large ? "large" : "standard";
            var previous = RenderTexture.active;
            var target = new RenderTexture(Width, Height, 24);
            var pixels = new Texture2D(Width, Height, TextureFormat.RGB24, false);
            using var f = new TaskPresentationValidation.Fixture(large);
            try
            {
                target.Create();
                var camera = Room(f, target);
                // The stone the synthetic capture grounded: its box lands here from the recorded pose and depth. Its face
                // sits just behind the subject's plane (one plane through the anchor, facing the capture), so the synthetic
                // slab never hides the outline, as passthrough never hides it on the headset; it is scaled by that depth so
                // it fills the box as seen, and the outline sits just outside it.
                Prop(f.Root.transform, "Synthetic stone marker", new Vector3(-.34f, -.05f, 2f) * 1.03f, new Vector3(.60f * 1.03f, .74f * 1.03f, .05f),
                    StoneColor);
                f.Scene.SetReducedMotion(true); f.Console.SetReducedMotion(true);

                f.Transport.Open.Enqueue(() => TaskPresentationValidation.Reply(HttpStatusCode.OK, TaskPresentationValidation.TaskView()));
                // The person has been talking, as on the headset, so the console is already on screen. The working
                // stills keep motion on so the shimmer shows; the other stills use reduced motion.
                f.Console.SetReducedMotion(false);
                f.Console.ShowListening(false); f.Strip.Show(DialogueStage.Listening, "Listening… Tap Finish when done.");
                Advance(f);
                // The thinking line while the first turn is on its way: its very first frame, then the next phrase.
                f.Transport.OnStart = () =>
                {
                    Write(f, camera, target, pixels, Path.Combine(output, "thinking-first-" + size + ".png"));
                    typeof(DialogueStrip).GetField("stageStartedAt", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(f.Strip, Time.unscaledTime - 12f);
                    Still(f, camera, target, pixels, Path.Combine(output, "thinking-next-" + size + ".png"));
                };
                f.Start();
                f.Transport.OnStart = null;
                f.Console.SetReducedMotion(true);
                Still(f, camera, target, pixels, Path.Combine(output, "task-" + size + ".png"));
                OutlineEdgesDrawn(f, camera, target, pixels, "task-" + size);

                var current = (InteractionPresentation)typeof(BoopyApp).GetField("task", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(f.App)!;
                f.Transport.Answers.Enqueue(() => TaskPresentationValidation.Reply(HttpStatusCode.OK,
                    TaskPresentationValidation.TaskView(2, TaskPresentationValidation.Attempts((TaskPresentationValidation.FirstAnswer, true)))));
                // The answer's working line while it is on its way: its very first frame, then after 12 s.
                f.Console.SetReducedMotion(false); Advance(f);
                f.Transport.OnAnswer = () =>
                {
                    Write(f, camera, target, pixels, Path.Combine(output, "saving-first-" + size + ".png"));
                    typeof(DialogueStrip).GetField("stageStartedAt", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(f.Strip, Time.unscaledTime - 12f);
                    Still(f, camera, target, pixels, Path.Combine(output, "saving-12s-" + size + ".png"));
                };
                ((Task)typeof(BoopyApp).GetMethod("SendAnswer", BindingFlags.Instance | BindingFlags.NonPublic)!
                    .Invoke(f.App, new object[] { current, SpeechValidation.SyntheticWav() })!).GetAwaiter().GetResult();
                f.Transport.OnAnswer = null;
                f.Console.SetReducedMotion(true);
                Still(f, camera, target, pixels, Path.Combine(output, "answer-" + size + ".png"));
                OutlineEdgesDrawn(f, camera, target, pixels, "answer-" + size);

                // A later turn on the outlined subject, mid-sweep: Boopy beside it, facing it, its cone on the subject.
                f.Console.SetReducedMotion(false); f.Scene.SetReducedMotion(false); Advance(f);
                f.Transport.OnUtter = () =>
                {
                    for (var frame = 0; frame < 120 && !(f.Scene.SubjectSweepProgress >= .45f); frame++) Frame(f, 1f / 60f);
                    Write(f, camera, target, pixels, Path.Combine(output, "sweep-thinking-" + size + ".png"));
                };
                typeof(BoopyApp).GetField("pending", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(f.App, TaskPresentationValidation.Snapshot());
                typeof(BoopyApp).GetField("pendingEvidence", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(f.App, new EvidenceTurn(false));
                ((Task)typeof(BoopyApp).GetMethod("Send", BindingFlags.Instance | BindingFlags.NonPublic)!
                    .Invoke(f.App, new object[] { SpeechValidation.SyntheticWav() })!).GetAwaiter().GetResult();
                f.Transport.OnUtter = null;
                f.Console.SetReducedMotion(true); f.Scene.SetReducedMotion(true);

                f.App.PresentTask(TaskPresentationValidation.TaskView(3, TaskPresentationValidation.Attempts((TaskPresentationValidation.FirstAnswer, true)),
                    "[{\"type\":\"status\",\"code\":\"wrong-item\"}]"));
                Still(f, camera, target, pixels, Path.Combine(output, "wrong-item-" + size + ".png"));
            }
            finally
            {
                RenderTexture.active = previous;
                UnityEngine.Object.DestroyImmediate(pixels);
                UnityEngine.Object.DestroyImmediate(target);
            }
        }

        private static readonly Color StoneColor = new Color(.54f, .53f, .50f);

        // A standing stone's silhouette in the synthetic box, box-relative with y down: a flat base, sides that
        // narrow a little, and a rounded top a little higher on the right. Synthetic, not a mask any model returned.
        internal static readonly Vector2[] Stone = StoneOutline();

        private static Vector2[] StoneOutline()
        {
            var points = new List<Vector2> { new Vector2(.03f, 1f), new Vector2(.07f, .70f) };
            for (var step = 0; step <= 16; step++)
            {
                var angle = Mathf.PI * (1f - step / 16f);
                points.Add(new Vector2(.5f + .4f * Mathf.Cos(angle), .4f - (.38f + .03f * step / 16f) * Mathf.Sin(angle)));
            }
            points.Add(new Vector2(.93f, .70f)); points.Add(new Vector2(.97f, 1f));
            return points.ToArray();
        }

        // The fixed eyes with a camera, a studio light, a floor and a back wall.
        private static Camera Room(TaskPresentationValidation.Fixture f, RenderTexture target)
        {
            var camera = f.Eyes.gameObject.AddComponent<Camera>();
            camera.fieldOfView = 58f; camera.nearClipPlane = .05f; camera.farClipPlane = 10f;
            camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = new Color(.12f, .13f, .14f);
            camera.allowHDR = false; camera.allowMSAA = false; camera.targetTexture = target;
            RenderSettings.ambientLight = new Color(.45f, .45f, .45f);
            var light = new GameObject("Fixed studio light").AddComponent<Light>(); light.transform.SetParent(f.Root.transform);
            light.type = LightType.Directional; light.intensity = 1f; light.transform.rotation = Quaternion.Euler(35f, -30f, 0f);
            Prop(f.Root.transform, "Synthetic floor", new Vector3(0f, -.65f, 2.5f), new Vector3(5f, .10f, 5f), new Color(.26f, .27f, .28f));
            Prop(f.Root.transform, "Synthetic back wall", new Vector3(0f, .6f, 3.4f), new Vector3(5f, 2.6f, .05f), new Color(.20f, .21f, .22f));
            return camera;
        }

        // One picture for the owner of the look the headset gets with segmentation on: the same synthetic turn, its
        // subject a stone-shaped synthetic mask (the contour path) with one name, 'object / unsure'. Two frames, the
        // eyes turned and the view narrowed as a person looks: Boopy mid-sweep with its cone on the subject, then the
        // subject, its chip, the line and Answer at rest. owner.png stacks them, working above rest.
        private static void Owner(string output)
        {
            var previous = RenderTexture.active;
            var target = new RenderTexture(Width, Height, 24);
            var pixels = new Texture2D(Width, Height, TextureFormat.RGB24, false);
            var sheet = new Texture2D(Width, Height * 2, TextureFormat.RGB24, false);
            using var f = new TaskPresentationValidation.Fixture(false);
            try
            {
                target.Create();
                var camera = Room(f, target);
                var subject = f.Transport.SessionView.Items[0];
                // One name and its kind on the chip: 'object / unsure'.
                subject.Kind = "object"; subject.Gloss = null;
                var grounding = subject.Grounding;
                var box = grounding.Box!;
                grounding.Contour = Stone.Select(point => new Point2 { X = box.X0 + point.x * (box.X1 - box.X0), Y = box.Y0 + point.y * (box.Y1 - box.Y0) }).ToList();
                grounding.Spatial = new SpatialEvidence
                {
                    Provider = "synthetic", Model = "synthetic", Concept = "stone marker", Confidence = .4f, Verification = "proposed",
                    Outcome = "contour", FrameSha256 = new string('c', 64), MaskSha256 = new string('d', 64),
                };
                var placed = f.Root.GetComponent<RoomCamera>().PlaceBoundary(grounding, TaskPresentationValidation.Snapshot(), out _);
                StoneProp(f.Root, f.Eyes.position, placed, grounding);
                f.Scene.SetReducedMotion(true); f.Console.SetReducedMotion(true);
                f.Transport.Open.Enqueue(() => TaskPresentationValidation.Reply(HttpStatusCode.OK, TaskPresentationValidation.TaskView()));
                f.Console.ShowListening(false); f.Strip.Show(DialogueStage.Listening, "Listening… Tap Finish when done.");
                Advance(f);
                f.Start();
                Advance(f);
                var overlay = f.Scene.GetComponentsInChildren<GroundedOverlay>().Single(candidate => candidate.gameObject.activeInHierarchy);
                if (overlay.Boundary.Count != Stone.Length)
                    throw new InvalidOperationException("The owner picture's subject is not drawn as its synthetic mask.");
                var chip = TaskPresentationValidation.ActiveChips(f).Single();
                var companion = (CompanionOrb)typeof(ContextConsole).GetField("companion", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(f.Console)!;
                // Framed on the subject, its chip, Boopy, the line with Answer and the shelf under it.
                Color32[] Shot(string name, bool outline) =>
                    Framed(f, camera, target, pixels, Path.Combine(output, name), outline, Parts(overlay, chip, companion, f.Console, f.Strip));
                var rest = Shot("owner-rest.png", true);

                // A later turn on the same subject: Boopy flies beside it and sweeps it with its cone.
                f.Console.SetReducedMotion(false); f.Scene.SetReducedMotion(false); Advance(f);
                var working = Array.Empty<Color32>();
                f.Transport.OnUtter = () =>
                {
                    for (var frame = 0; frame < 120 && !(f.Scene.SubjectSweepProgress >= .45f); frame++) Frame(f, 1f / 60f);
                    working = Shot("owner-working.png", false);
                };
                typeof(BoopyApp).GetField("pending", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(f.App, TaskPresentationValidation.Snapshot());
                typeof(BoopyApp).GetField("pendingEvidence", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(f.App, new EvidenceTurn(false));
                ((Task)typeof(BoopyApp).GetMethod("Send", BindingFlags.Instance | BindingFlags.NonPublic)!
                    .Invoke(f.App, new object[] { SpeechValidation.SyntheticWav() })!).GetAwaiter().GetResult();
                f.Transport.OnUtter = null;
                if (working.Length != Width * Height) throw new InvalidOperationException("The owner picture's working frame was not taken.");

                // Texture rows run bottom up: rest below, working above.
                sheet.SetPixels32(0, 0, Width, Height, rest);
                sheet.SetPixels32(0, Height, Width, Height, working);
                sheet.Apply();
                File.WriteAllBytes(Path.Combine(output, "owner.png"), sheet.EncodeToPNG());
            }
            finally
            {
                RenderTexture.active = previous;
                UnityEngine.Object.DestroyImmediate(sheet);
                UnityEngine.Object.DestroyImmediate(pixels);
                UnityEngine.Object.DestroyImmediate(target);
            }
        }

        private static Renderer[] Parts(params Component[] parts) =>
            parts.SelectMany(part => part.GetComponentsInChildren<Renderer>()).Where(part => part.enabled).ToArray();

        // The eyes turned toward the parts and the view narrowed to hold them with a little room, as a person looks
        // at them; then one capture, written to path, and the eyes put back.
        private static Color32[] Framed(TaskPresentationValidation.Fixture f, Camera camera, RenderTexture target, Texture2D pixels, string path,
            bool outline, Renderer[] parts)
        {
            var eye = f.Eyes.position;
            var points = parts.SelectMany(part => Corners(part.bounds)).ToArray();
            var rotation = f.Eyes.rotation; var field = camera.fieldOfView;
            try
            {
                var forward = points.Aggregate(Vector3.zero, (sum, point) => sum + (point - eye).normalized).normalized;
                Vector2 low = default, high = default;
                // Twice: the first pass finds the middle of the parts as seen, the second measures around it.
                for (var pass = 0; pass < 2; pass++)
                {
                    var right = Vector3.Cross(Vector3.up, forward).normalized; var up = Vector3.Cross(forward, right);
                    var seen = points.Select(point => { var d = point - eye; var z = Mathf.Max(.01f, Vector3.Dot(d, forward)); return new Vector2(Vector3.Dot(d, right) / z, Vector3.Dot(d, up) / z); }).ToArray();
                    low = new Vector2(seen.Min(p => p.x), seen.Min(p => p.y)); high = new Vector2(seen.Max(p => p.x), seen.Max(p => p.y));
                    var middle = (low + high) / 2f;
                    if (pass == 0) forward = (forward + right * middle.x + up * middle.y).normalized;
                }
                f.Eyes.rotation = Quaternion.LookRotation(forward, Vector3.up);
                var half = Mathf.Max(Mathf.Max(-low.y, high.y), Mathf.Max(-low.x, high.x) / ((float)Width / Height)) * 1.18f;
                camera.fieldOfView = Mathf.Clamp(2f * Mathf.Atan(half) * Mathf.Rad2Deg, 20f, 58f);
                var image = Capture(camera, target, pixels);
                File.WriteAllBytes(path, pixels.EncodeToPNG());
                if (outline) OutlineEdgesDrawn(f, camera, target, pixels, Path.GetFileNameWithoutExtension(path));
                return image;
            }
            finally { f.Eyes.rotation = rotation; camera.fieldOfView = field; }
        }

        private static IEnumerable<Vector3> Corners(Bounds bounds)
        {
            for (var i = 0; i < 8; i++)
                yield return bounds.center + Vector3.Scale(bounds.extents, new Vector3((i & 1) == 0 ? -1 : 1, (i & 2) == 0 ? -1 : 1, (i & 4) == 0 ? -1 : 1));
        }

        // The stone cut to the synthetic mask: each placed contour point pushed 3% farther along its ray from the
        // eyes, so its face matches the outline as seen and never hides it, with a little thickness behind it.
        private static void StoneProp(GameObject root, Vector3 eye, Vector3[] placed, Grounding grounding)
        {
            if (!Geometry.TryContour(grounding, out var mask) || !SurfaceGeometry.TryTriangulate(mask, out var cap) || placed.Length != mask.Length)
                throw new InvalidOperationException("The synthetic stone's mask does not triangulate.");
            var front = placed.Select(point => eye + (point - eye) * 1.03f).ToArray();
            var back = front.Select(point => point + (point - eye).normalized * .06f).ToArray();
            var vertices = new List<Vector3>(front);
            var triangles = new List<int>();
            // The face turns toward the eyes.
            var flip = Vector3.Dot(Vector3.Cross(front[cap[1]] - front[cap[0]], front[cap[2]] - front[cap[0]]), eye - front[cap[0]]) < 0f;
            for (var i = 0; i < cap.Length; i += 3)
                triangles.AddRange(flip ? new[] { cap[i], cap[i + 2], cap[i + 1] } : new[] { cap[i], cap[i + 1], cap[i + 2] });
            var middle = front.Aggregate(Vector3.zero, (sum, point) => sum + point) / front.Length;
            for (var i = 0; i < front.Length; i++)
            {
                var j = (i + 1) % front.Length;
                var at = vertices.Count;
                vertices.AddRange(new[] { front[i], front[j], back[j], back[i] });
                var outward = Vector3.Dot(Vector3.Cross(front[j] - front[i], back[j] - front[i]), (front[i] + front[j]) / 2f - middle) > 0f;
                triangles.AddRange(outward ? new[] { at, at + 1, at + 2, at, at + 2, at + 3 } : new[] { at, at + 2, at + 1, at, at + 3, at + 2 });
            }
            var mesh = new Mesh { name = "Synthetic stone" };
            mesh.SetVertices(vertices); mesh.SetTriangles(triangles, 0); mesh.RecalculateNormals(); mesh.RecalculateBounds();
            var go = new GameObject("Synthetic stone marker"); go.transform.SetParent(root.transform, false);
            go.AddComponent<MeshFilter>().sharedMesh = mesh;
            go.AddComponent<MeshRenderer>().sharedMaterial = new Material(Shader.Find("Standard")) { color = StoneColor };
        }

        // Advance the production reveal and the companion's attention, then capture one frame.
        private static void Still(TaskPresentationValidation.Fixture f, Camera camera, RenderTexture target, Texture2D pixels, string path)
        {
            Advance(f);
            Write(f, camera, target, pixels, path);
        }

        // The same frame twice: from the fixed eyes, and head-on, with the camera turned toward the console as a
        // person turns to look at it. A flat still of a panel this far to the side keystones its type into slants.
        private static void Write(TaskPresentationValidation.Fixture f, Camera camera, RenderTexture target, Texture2D pixels, string path)
        {
            Capture(camera, target, pixels);
            File.WriteAllBytes(path, pixels.EncodeToPNG());
            var saved = f.Eyes.rotation;
            var center = (f.Console.transform.position + f.Strip.transform.position) / 2f;
            f.Eyes.rotation = Quaternion.LookRotation(center - f.Eyes.position, Vector3.up);
            Capture(camera, target, pixels);
            File.WriteAllBytes(Path.Combine(Path.GetDirectoryName(path)!, Path.GetFileNameWithoutExtension(path) + "-headon.png"), pixels.EncodeToPNG());
            f.Eyes.rotation = saved;
        }

        // One second of production frames.
        private static void Advance(TaskPresentationValidation.Fixture f)
        {
            for (var frame = 0; frame < 24; frame++) Frame(f, 1f / 24f);
        }

        private static void Frame(TaskPresentationValidation.Fixture f, float delta)
        {
            foreach (var text in f.Root.GetComponentsInChildren<TextMeshPro>()) text.ForceMeshUpdate(true, true);
            foreach (var chip in TaskPresentationValidation.ActiveChips(f)) chip.Face(f.Eyes);
            foreach (var overlay in f.Scene.GetComponentsInChildren<GroundedOverlay>()) overlay.RefreshVisuals(delta);
            if (f.Scene.TryGetActiveAnchor(out var anchor)) f.Console.AttendTo(anchor, true);
            f.Console.RefreshVisuals(delta); f.Strip.RefreshVisuals(delta);
        }

        private static Color32[] Capture(Camera camera, RenderTexture target, Texture2D pixels)
        {
            camera.Render();
            RenderTexture.active = target;
            pixels.ReadPixels(new Rect(0, 0, Width, Height), 0, 0);
            pixels.Apply();
            return pixels.GetPixels32();
        }

        // With no anti-aliasing, a line thinner than a pixel can draw nothing where it falls between pixel
        // centers. Every edge of the subject's outline must change some pixels within 1.5 px of it, away from
        // the corners, against the same frame drawn without the outline.
        private static void OutlineEdgesDrawn(TaskPresentationValidation.Fixture f, Camera camera, RenderTexture target, Texture2D pixels, string still)
        {
            var line = f.Scene.GetComponentsInChildren<GroundedOverlay>().Single(overlay => overlay.gameObject.activeInHierarchy)
                .GetComponentsInChildren<LineRenderer>(true).Single(candidate => candidate.name == "Observed boundary");
            var drawn = Capture(camera, target, pixels);
            line.enabled = false;
            var bare = Capture(camera, target, pixels);
            line.enabled = true;
            var corners = Enumerable.Range(0, line.positionCount).Select(index => (Vector2)camera.WorldToScreenPoint(line.GetPosition(index))).ToArray();
            var counts = new List<int>();
            for (var edge = 0; edge < (line.loop ? corners.Length : corners.Length - 1); edge++)
            {
                var from = corners[edge];
                var to = corners[(edge + 1) % corners.Length];
                var changed = new HashSet<int>();
                var steps = Mathf.Max(1, Mathf.CeilToInt(Vector2.Distance(from, to) * 2f));
                for (var step = 0; step <= steps; step++)
                {
                    var along = (float)step / steps;
                    if (along < .1f || along > .9f) continue;
                    var point = Vector2.Lerp(from, to, along);
                    for (var x = Mathf.FloorToInt(point.x - 1.5f); x <= Mathf.CeilToInt(point.x + 1.5f); x++)
                        for (var y = Mathf.FloorToInt(point.y - 1.5f); y <= Mathf.CeilToInt(point.y + 1.5f); y++)
                        {
                            if (x < 0 || y < 0 || x >= Width || y >= Height) continue;
                            var center = new Vector2(x + .5f, y + .5f);
                            var nearest = Vector2.Lerp(from, to, Mathf.Clamp01(Vector2.Dot(center - from, to - from) / Mathf.Max(1e-6f, (to - from).sqrMagnitude)));
                            if (Vector2.Distance(center, nearest) > 1.5f) continue;
                            var index = y * Width + x;
                            if (drawn[index].r != bare[index].r || drawn[index].g != bare[index].g || drawn[index].b != bare[index].b) changed.Add(index);
                        }
                }
                counts.Add(changed.Count);
            }
            Debug.Log("Boopy task outline pixels per edge, " + still + ": [" + string.Join(", ", counts) + "]");
            if (counts.Count == 0 || counts.Any(count => count == 0))
                throw new InvalidOperationException(still + ": an outline edge draws no pixels: [" + string.Join(", ", counts) + "].");
        }

        private static void Prop(Transform root, string name, Vector3 position, Vector3 size, Color color)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            go.name = name; go.transform.SetParent(root, false); go.transform.position = position; go.transform.localScale = size;
            var material = new Material(Shader.Find("Standard")) { color = color };
            go.GetComponent<MeshRenderer>().sharedMaterial = material;
            // No collider: the props are scenery, not hit targets for the scene's chip raycasts.
            UnityEngine.Object.DestroyImmediate(go.GetComponent<Collider>());
        }
    }
}
