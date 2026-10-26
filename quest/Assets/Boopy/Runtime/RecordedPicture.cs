#nullable enable
using Boopy.Client;
using UnityEngine;
using N = System.Numerics;

namespace Boopy.Quest
{
    /// <summary>
    /// The recorded scene the Mac shows, as one flat picture in the room: world-fixed, placed once in front of the person
    /// when it first appears, upright and facing them. A 2D source has no depth, so the picture's plane is where its
    /// subjects lie. No words sit on it. A clip's still has a player's thin bar along its bottom edge, its width, filled to
    /// where the still is in the clip, with the play triangle just left of the bar, as any player shows a stopped video (two
    /// bars would be the privacy Pause). A photo has nothing. Its still stays in memory only, never on the headset's storage;
    /// a coarse grid of its luminance stays with it so words on it can choose their ink.
    /// </summary>
    public sealed class RecordedPicture : MonoBehaviour
    {
        // Ahead, a little below the eyes, and at most this wide and tall: the still keeps its own aspect inside the box.
        public const float Distance = 1.8f, Drop = 0.15f, MaxWidth = 1.6f, MaxHeight = 1.0f;

        private Transform? frame;
        private MeshRenderer? surface;
        // The still's relative luminance on a coarse grid, top row first, kept so words on it can choose their ink.
        private float[] luminance = System.Array.Empty<float>();
        private int columns, rows;
        private LineRenderer? track, played;
        private MeshRenderer? stopped;
        private Texture2D? texture;
        private byte[]? still;

        public RecordedSceneView? Scene { get; private set; }
        public bool Showing => Scene != null && gameObject.activeSelf;

        /// <summary>How far along its clip the still is held, as the player bar shows it; null for a photo or no bar.</summary>
        public float? Held { get; private set; }

        /// <summary>The picture's rectangle in the room, as the person sees it.</summary>
        public PicturePlane Plane
        {
            get
            {
                var place = frame != null ? frame : transform;
                var size = place.lossyScale;
                return new PicturePlane(Numerics(place.position), Numerics(place.right), Numerics(place.up), size.x, size.y);
            }
        }

        public static RecordedPicture Create(Transform parent)
        {
            var go = new GameObject("Recorded scene");
            go.transform.SetParent(parent, false);
            var picture = go.AddComponent<RecordedPicture>();
            // The still is a quad scaled to the picture's size; the player bar is its sibling, so it is never stretched.
            var still = new GameObject("Recorded picture");
            still.transform.SetParent(go.transform, false);
            picture.frame = still.transform;
            still.AddComponent<MeshFilter>().sharedMesh = Visuals.Quad();
            picture.surface = still.AddComponent<MeshRenderer>();
            // Sprites/Default is always in the build; the picture draws before the outlines and labels on it.
            picture.surface.sharedMaterial = new Material(Shader.Find("Sprites/Default"));
            picture.surface.sortingOrder = -10;
            picture.surface.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            picture.surface.receiveShadows = false;
            // A clip's player bar: the track, the part played up to the held still, and the play triangle of a stopped player.
            var triangle = new GameObject("Play triangle"); triangle.transform.SetParent(go.transform, false);
            var mesh = new Mesh { name = "Play triangle", vertices = new[] { new Vector3(-.5f, -.5f, 0f), new Vector3(-.5f, .5f, 0f), new Vector3(.5f, 0f, 0f) },
                triangles = new[] { 0, 1, 2 } };
            triangle.AddComponent<MeshFilter>().sharedMesh = mesh;
            picture.stopped = triangle.AddComponent<MeshRenderer>(); picture.stopped.sharedMaterial = Visuals.Solid; picture.stopped.sortingOrder = 4;
            var frost = new MaterialPropertyBlock(); frost.SetColor("_Color", WordBlock.Frost); picture.stopped.SetPropertyBlock(frost);
            picture.track = picture.Bar("Player track", new Color(SpatialTheme.Smoke.r, SpatialTheme.Smoke.g, SpatialTheme.Smoke.b, .45f), 3);
            picture.played = picture.Bar("Player played", SpatialTheme.TextColor, 4);
            picture.ShowBar(null, 1f, 1f);
            go.SetActive(false);
            return picture;
        }

        /// <summary>
        /// Shows a still of the scene. The first still is placed in front of <paramref name="head"/>; a later one keeps the
        /// picture where it is and takes its own aspect. False when the bytes do not decode, and nothing changes then.
        /// </summary>
        public bool Show(RecordedSceneView scene, byte[] jpeg, Transform head)
        {
            if (surface == null) return false;
            var decoded = new Texture2D(2, 2, TextureFormat.RGBA32, true) { name = "Recorded still", wrapMode = TextureWrapMode.Clamp };
            if (!decoded.LoadImage(jpeg, false) || decoded.width != scene.Width || decoded.height != scene.Height)
            {
                Discard(decoded);
                return false;
            }
            Measure(decoded);
            // The pixels themselves go to the GPU only; the coarse grid stays.
            decoded.Apply(false, true);
            var first = !Showing;
            if (texture != null) Discard(texture);
            texture = decoded; still = jpeg; Scene = scene;
            surface.sharedMaterial.mainTexture = texture;
            var aspect = (float)scene.Width / scene.Height;
            var width = Mathf.Min(MaxWidth, MaxHeight * aspect);
            var height = width / aspect;
            frame!.localScale = new Vector3(width, height, 1f);
            ShowBar(RecordedScenes.Progress(scene), width, height);
            if (first)
            {
                var forward = Vector3.ProjectOnPlane(head.forward, Vector3.up);
                if (forward.sqrMagnitude < 1e-4f) forward = Vector3.ProjectOnPlane(head.up, Vector3.up);
                forward.Normalize();
                transform.SetPositionAndRotation(head.position + forward * Distance + Vector3.down * Drop, Quaternion.LookRotation(forward, Vector3.up));
            }
            gameObject.SetActive(true);
            return true;
        }

        public void Hide()
        {
            gameObject.SetActive(false);
            if (surface != null) surface.sharedMaterial.mainTexture = null;
            if (texture != null) Discard(texture);
            texture = null; still = null; Scene = null; Held = null; luminance = System.Array.Empty<float>();
        }

        private LineRenderer Bar(string name, Color color, int order)
        {
            var host = new GameObject(name);
            host.transform.SetParent(transform, false);
            var line = Visuals.Line(host, BarWidth * Distance, false, Visuals.Solid);
            line.useWorldSpace = false; line.positionCount = 2; line.sortingOrder = order; line.numCapVertices = 0;
            Visuals.Tint(line, color);
            return line;
        }

        private void Measure(Texture2D image)
        {
            columns = 96; rows = Mathf.Max(1, Mathf.RoundToInt(columns * (float)image.height / image.width));
            luminance = new float[columns * rows];
            for (var row = 0; row < rows; row++)
                for (var column = 0; column < columns; column++)
                    // Texture rows run from the bottom; the grid's from the top, as image points do.
                    luminance[row * columns + column] = WordBlock.Luminance(image.GetPixelBilinear((column + .5f) / columns, 1f - (row + .5f) / rows));
        }

        /// <summary>
        /// The darkest and brightest luminance (5th and 95th percentile) of the still inside an image rectangle (0 to 1,
        /// origin top-left), for words placed on it; (0, 1) when nothing is measured there.
        /// </summary>
        public (float Darkest, float Brightest) LuminanceRange(float x0, float y0, float x1, float y1)
        {
            var inside = new System.Collections.Generic.List<float>();
            for (var row = 0; row < rows; row++)
                for (var column = 0; column < columns; column++)
                {
                    var x = (column + .5f) / columns; var y = (row + .5f) / rows;
                    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) inside.Add(luminance[row * columns + column]);
                }
            if (inside.Count == 0) return (0f, 1f);
            inside.Sort();
            return (inside[(int)(.05f * (inside.Count - 1))], inside[(int)(.95f * (inside.Count - 1))]);
        }

        /// <summary>How busy the still is inside an image rectangle: the spread from its 5th to its 95th percentile luminance.</summary>
        public float Spread(float x0, float y0, float x1, float y1)
        {
            var (darkest, brightest) = LuminanceRange(x0, y0, x1, y1);
            return brightest - darkest;
        }

        // The bar runs the picture's width just under its bottom edge. The play triangle of a stopped player, about 1.5
        // degrees tall at the picture's distance, sits just left of the bar's left end, outside the picture's corner and
        // centered on the bar (DESIGN, on Chrome's player in one line); it is not a control.
        public const float Triangle = .047f;
        private const float BarWidth = .003f;
        private void ShowBar(float? held, float width, float height)
        {
            Held = held;
            if (track == null || played == null || stopped == null) return;
            var shown = held != null;
            track.gameObject.SetActive(shown); played.gameObject.SetActive(shown); stopped.gameObject.SetActive(shown);
            if (held is not float along) return;
            var y = -height / 2f - BarWidth * Distance;
            track.SetPosition(0, new Vector3(-width / 2f, y, -.003f)); track.SetPosition(1, new Vector3(width / 2f, y, -.003f));
            played.SetPosition(0, new Vector3(-width / 2f, y, -.004f)); played.SetPosition(1, new Vector3(-width / 2f + width * along, y, -.004f));
            // As tall as it is long, pointing right; its point ends one gap short of the bar.
            stopped.transform.localScale = new Vector3(Triangle * .87f, Triangle, 1f);
            stopped.transform.localPosition = new Vector3(-width / 2f - SpatialTheme.Gap * Distance - Triangle * .87f / 2f, y, -.003f);
        }

        /// <summary>Where a ray meets the picture: the room point and the still's image point (0 to 1, origin top-left).</summary>
        public bool TryHit(Ray ray, out Vector3 point, out Point2 image)
        {
            point = default; image = new Point2();
            if (!Showing || !Plane.TryImage(Numerics(ray.origin), Numerics(ray.direction), out var x, out var y, out var hit)) return false;
            point = new Vector3(hit.X, hit.Y, hit.Z);
            image = new Point2 { X = x, Y = y };
            return true;
        }

        /// <summary>The still a turn is about, placed on this picture; null when nothing shows.</summary>
        public Snapshot? Still() => Showing && still != null && Scene != null
            ? new Snapshot(still, Scene.Width, Scene.Height, Plane, new RecordedFrameRef { RecordingId = Scene.RecordingId, FrameId = Scene.FrameId })
            : null;

        private void OnDestroy()
        {
            if (texture != null) Discard(texture);
            if (surface != null) Discard(surface.sharedMaterial);
        }

        private static N.Vector3 Numerics(Vector3 value) => new N.Vector3(value.x, value.y, value.z);

        // Editor checks run outside play mode, where only DestroyImmediate is allowed.
        private static void Discard(Object gone)
        {
            if (Application.isPlaying) Destroy(gone);
            else DestroyImmediate(gone);
        }
    }
}
