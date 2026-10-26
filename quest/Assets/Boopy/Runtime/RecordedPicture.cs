#nullable enable
using Boopy.Client;
using TMPro;
using UnityEngine;
using N = System.Numerics;

namespace Boopy.Quest
{
    /// <summary>
    /// The recorded scene the Mac shows, filling the person's view as the room would: world-fixed, placed once in front of
    /// the person at eye level when it first appears, upright and facing them, tall enough to cover the headset's view
    /// from top to bottom and as wide as its own aspect makes it, with the room hidden behind it in every direction, so
    /// the person looks around the recording as if they were there. A 2D source has no depth, so the picture's plane is
    /// where its subjects lie. No words sit on it. Because it fills the view it is never mistaken for the room as it is now:
    /// one small media cue stays in the lower-left of the view the whole time (the upper-left when the subject's word is
    /// there). For a clip it is a player's thin bar filled to where the still is in the clip, with the play triangle just
    /// left of it, as any player shows a stopped video (two bars would be the privacy Pause); for a photo it is the one
    /// word "Recorded" in the same ink. Its still stays in memory only, never on the headset's storage; a coarse grid of its
    /// luminance stays with it so words on it can choose their ink.
    /// </summary>
    public sealed class RecordedPicture : MonoBehaviour
    {
        // Ahead at eye level, past Boopy and its line, and this many degrees tall from the eyes (the headset shows about 96):
        // the still keeps its own aspect, so a portrait still fits the height and a wide one runs past the sides.
        public const float Distance = 3f, ViewDegrees = 100f;
        public static float Height => 2f * Distance * Mathf.Tan(ViewDegrees * Mathf.Deg2Rad / 2f);
        // The room cover's half size: past the picture's corners, which are the farthest part of it from the eyes.
        private const float CoverHalf = 8f;
        // The media cue: this far from the eyes, this far left of and below where they look, this long (a clip's bar) and
        // this tall (a photo's word); it moves to the upper-left when the subject's word is within AvoidDegrees of it.
        public const float CueDistance = 1.1f, CueYaw = 22f, CuePitch = 20f, CueBarDegrees = 8f, MarkDegrees = 1f, AvoidDegrees = 15f;
        public const string Mark = "Recorded";

        private Transform? frame;
        private MeshRenderer? surface;
        // The still's relative luminance on a coarse grid, top row first, kept so words on it can choose their ink.
        private float[] luminance = System.Array.Empty<float>();
        private int columns, rows;
        private Transform? cue;
        private LineRenderer? track, played;
        private MeshRenderer? stopped;
        private TextMeshPro? mark;
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
            // The room cover: a dark box around the eyes, drawn first, so the passthrough room never shows around the still.
            var cover = new GameObject("Room cover");
            cover.transform.SetParent(go.transform, false);
            cover.transform.localPosition = new Vector3(0f, 0f, -Distance);
            cover.transform.localScale = Vector3.one * (2f * CoverHalf);
            cover.AddComponent<MeshFilter>().sharedMesh = Box();
            var covering = cover.AddComponent<MeshRenderer>(); covering.sharedMaterial = Visuals.Solid; covering.sortingOrder = -20;
            covering.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off; covering.receiveShadows = false;
            var black = new MaterialPropertyBlock(); black.SetColor("_Color", Color.black); covering.SetPropertyBlock(black);
            // The media cue, which follows the view: a clip's player bar (the track, the part played up to the held still, and
            // the play triangle of a stopped player) or a photo's one word.
            var cue = new GameObject("Media cue"); cue.transform.SetParent(go.transform, false);
            picture.cue = cue.transform;
            var triangle = new GameObject("Play triangle"); triangle.transform.SetParent(cue.transform, false);
            var mesh = new Mesh { name = "Play triangle", vertices = new[] { new Vector3(-.5f, -.5f, 0f), new Vector3(-.5f, .5f, 0f), new Vector3(.5f, 0f, 0f) },
                triangles = new[] { 0, 1, 2 } };
            triangle.AddComponent<MeshFilter>().sharedMesh = mesh;
            picture.stopped = triangle.AddComponent<MeshRenderer>(); picture.stopped.sharedMaterial = Visuals.Solid; picture.stopped.sortingOrder = 4;
            var frost = new MaterialPropertyBlock(); frost.SetColor("_Color", WordBlock.Frost); picture.stopped.SetPropertyBlock(frost);
            picture.track = picture.Bar("Player track", new Color(SpatialTheme.Smoke.r, SpatialTheme.Smoke.g, SpatialTheme.Smoke.b, .45f), 3);
            picture.played = picture.Bar("Player played", SpatialTheme.TextColor, 4);
            picture.mark = SpatialTheme.Text(cue.transform, "Recorded mark", SpatialTheme.Utility, SpatialTheme.TextColor);
            picture.mark.text = Mark;
            picture.mark.alignment = TextAlignmentOptions.Center;
            picture.mark.textWrappingMode = TextWrappingModes.NoWrap;
            picture.mark.rectTransform.sizeDelta = new Vector2(4f, .1f);
            picture.mark.transform.localScale = Vector3.one * (Em(MarkDegrees, CueDistance) / Mathf.Max(1e-5f, picture.mark.fontSize / 10f));
            picture.ShowBar(null);
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
            var height = Height;
            var width = height * aspect;
            frame!.localScale = new Vector3(width, height, 1f);
            ShowBar(RecordedScenes.Progress(scene));
            if (first)
            {
                var forward = Vector3.ProjectOnPlane(head.forward, Vector3.up);
                if (forward.sqrMagnitude < 1e-4f) forward = Vector3.ProjectOnPlane(head.up, Vector3.up);
                forward.Normalize();
                transform.SetPositionAndRotation(head.position + forward * Distance, Quaternion.LookRotation(forward, Vector3.up));
                Follow(head, null, float.PositiveInfinity);
            }
            gameObject.SetActive(true);
            return true;
        }

        /// <summary>
        /// Keeps the media cue in the lower-left of the view, or the upper-left when <paramref name="avoid"/> (the subject's
        /// word) is near that corner; it eases there over <paramref name="elapsed"/> seconds, and infinity puts it there.
        /// </summary>
        public void Follow(Transform head, Vector3? avoid, float elapsed)
        {
            if (cue == null || float.IsNaN(elapsed)) return;
            var toward = head.rotation * Quaternion.Euler(CuePitch, -CueYaw, 0f) * Vector3.forward;
            if (avoid is Vector3 word && Vector3.Angle(toward, word - head.position) < AvoidDegrees)
                toward = head.rotation * Quaternion.Euler(-CuePitch, -CueYaw, 0f) * Vector3.forward;
            var place = head.position + toward * CueDistance;
            var facing = Quaternion.LookRotation(toward, head.up);
            var ease = float.IsPositiveInfinity(elapsed) ? 1f : 1f - Mathf.Exp(-12f * Mathf.Max(0f, elapsed));
            cue.SetPositionAndRotation(Vector3.Lerp(cue.position, place, ease), Quaternion.Slerp(cue.rotation, facing, ease));
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
            host.transform.SetParent(cue, false);
            var line = Visuals.Line(host, BarWidth * CueDistance, false, Visuals.Solid);
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

        // The play triangle of a stopped player, about 1.5 degrees tall from the eyes, sits just left of the bar's left end,
        // centered on the bar (DESIGN, on Chrome's player in one line); it is not a control.
        public const float TriangleDegrees = 1.5f;
        private const float BarWidth = .003f;
        private void ShowBar(float? held)
        {
            Held = held;
            if (track == null || played == null || stopped == null || mark == null) return;
            var shown = held != null;
            track.gameObject.SetActive(shown); played.gameObject.SetActive(shown); stopped.gameObject.SetActive(shown);
            // A photo's cue is its one word; a clip's is its bar.
            mark.gameObject.SetActive(!shown);
            if (held is not float along) return;
            var length = Em(CueBarDegrees, CueDistance);
            track.SetPosition(0, new Vector3(-length / 2f, 0f, 0f)); track.SetPosition(1, new Vector3(length / 2f, 0f, 0f));
            played.SetPosition(0, new Vector3(-length / 2f, 0f, -.001f)); played.SetPosition(1, new Vector3(-length / 2f + length * along, 0f, -.001f));
            // As tall as it is long, pointing right; its point ends one gap short of the bar.
            var tall = Em(TriangleDegrees, CueDistance);
            stopped.transform.localScale = new Vector3(tall * .87f, tall, 1f);
            stopped.transform.localPosition = new Vector3(-length / 2f - SpatialTheme.Gap * CueDistance - tall * .87f / 2f, 0f, 0f);
        }

        private static float Em(float degrees, float distance) => 2f * distance * Mathf.Tan(degrees * Mathf.Deg2Rad / 2f);

        // A unit box, seen from inside (the material draws both faces).
        private static Mesh Box()
        {
            var corners = new Vector3[8];
            for (var i = 0; i < 8; i++) corners[i] = new Vector3((i & 1) - .5f, ((i >> 1) & 1) - .5f, ((i >> 2) & 1) - .5f);
            return new Mesh
            {
                name = "Room cover",
                vertices = corners,
                triangles = new[] { 0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3 },
            };
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
