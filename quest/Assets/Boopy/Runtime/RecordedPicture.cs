#nullable enable
using System;
using Boopy.Client;
using TMPro;
using UnityEngine;
using UnityEngine.Video;
using N = System.Numerics;

namespace Boopy.Quest
{
    /// <summary>
    /// The recorded scene the Mac shows, exactly as it was captured and fixed in the world: placed once in front of the
    /// person at eye level and facing them when the headset is worn (and again on the system recenter), at the true
    /// scale its camera saw it, the scene's projection measured from the eye at that placement, whole, with no crop and
    /// no zoom. A clip plays its own video at its own frame rate, looping; its still shows until the video's first
    /// frame. The frame's outer edge dissolves into the same footage, heavily blurred and a little dimmed, mirrored on
    /// past its edges on a sphere around the person that lines up with the frame and fills every direction, so no edge,
    /// no black and no room shows. A projection the Mac did
    /// not measure is not guessed: the frame is then fitted whole into the headset's view. A 2D source has no depth, so
    /// the frame's plane is where its subjects lie. No words sit on it, and it is never mistaken for the room as it is
    /// now: one small media cue sits on the frame, in its lower-left a few degrees inside its edge (the upper-left when
    /// the subject's word is there). For a clip it is a player's thin bar filled to where the clip is, with the play
    /// triangle while the clip is stopped (two bars would be the privacy Pause); for a photo it is the one word
    /// "Recorded" in the same ink. Stills stay in memory only and the video streams from the Mac; nothing is on the
    /// headset's storage. A coarse grid of the held still's luminance stays so words on it can choose their ink.
    /// </summary>
    public sealed class RecordedPicture : MonoBehaviour
    {
        // The frame's plane is this far ahead of the eyes, past Boopy and its line.
        public const float Distance = 3f;
        // The view when the eyes give no projection (in the editor): about what a Quest 3 shows across both eyes and tall.
        public const float WideDegrees = 110f, TallDegrees = 96f;
        // The surround: a sphere this far around the eyes, the footage shrunk to about this many pixels on its long side
        // and stretched back, near the footage's own brightness. The frame dissolves into it over this share of its width
        // and height (about 10 degrees on a Quest clip), so the eye finds no edge.
        public const float SurroundRadius = 40f, SurroundShade = .85f, Feather = .13f;
        public const int BlurSide = 24;
        // Past this many degrees beyond the frame's edge the mirrored blur eases, by NearFade more, into a far field: the
        // same footage shrunk to about FarSide texels on its long side and smoothly interpolated, so no subject repeats as
        // a shape and the far view is a calm gradient of the scene's own colours.
        public const float NearDegrees = 8f, NearFade = 12f;
        public const int FarSide = 7;
        // The media cue: this long (a clip's bar) and this tall (a photo's word), in degrees from the eyes; it moves to
        // the frame's upper-left when the subject's word is within AvoidDegrees of it.
        public const float CueBarDegrees = 8f, MarkDegrees = 1f, AvoidDegrees = 15f;
        public const string Mark = "Recorded";

        private Transform? frame, around, beyond, cue;
        private MeshRenderer? surface, surround, far;
        private MeshFilter? sphere, farSphere;
        // The held still's relative luminance on a coarse grid, top row first, kept so words on it can choose their ink.
        private float[] luminance = Array.Empty<float>();
        private int columns, rows;
        private LineRenderer? track, played;
        private MeshRenderer? stopped;
        private TextMeshPro? mark;
        private Texture2D? texture;
        private byte[]? still, sourceStill;
        // The frame's edges as tangents from the eye at its placement.
        private float left, right, up, down;
        // The clip's video, the texture it plays into, and the blurred levels the surround shows.
        private VideoPlayer? player;
        private RenderTexture? video;
        private RenderTexture[] blur = Array.Empty<RenderTexture>();
        private bool videoShown;
        private float clipLength;

        /// <summary>The scene as the Mac shows it.</summary>
        public RecordedSceneView? Source { get; private set; }
        /// <summary>The still a turn is about: the Mac's, or the analyzed still nearest where a boop stopped the clip.</summary>
        public RecordedSceneView? Scene { get; private set; }
        /// <summary>A still is read and waits to be placed, or shows.</summary>
        public bool Loaded => Scene != null;
        public bool Placed { get; private set; }
        public bool Showing => Scene != null && Placed && gameObject.activeSelf;
        /// <summary>The clip's own video shows and is stopped, as a boop leaves it.</summary>
        public bool Paused => videoShown && player != null && !player.isPlaying;
        /// <summary>The clip's own video is playing: what shows is not the still the grid was measured from.</summary>
        public bool Playing => videoShown && player != null && player.isPlaying;

        /// <summary>How far along its clip the picture is, as the player bar shows it; null for a photo or no bar.</summary>
        public float? Held { get; private set; }

        /// <summary>
        /// Where on the still a word, an outline's label or the media cue can sit, in image coordinates (0 to 1, origin
        /// top-left): on the sharp frame, at least <see cref="EdgeDegrees"/> inside its edge, never on the blurred surround.
        /// </summary>
        public (float X0, float Y0, float X1, float Y1) Readable { get; private set; } = (0f, 0f, 1f, 1f);
        public const float EdgeDegrees = 8f;
        /// <summary>That sharp part as tangents from the eye at the placement: how far it reaches left, right, up and down.</summary>
        public (float Left, float Right, float Up, float Down) Sharp { get; private set; }
        /// <summary>Where the eye was when the picture was placed, and which way the picture faces it: the frame of <see cref="Sharp"/>.</summary>
        public Vector3 Eye => around != null ? around.position : transform.position;
        public Quaternion Facing => transform.rotation;

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
            // The frame is a quad scaled to the picture's size, its edge fading out; the media cue is its sibling, so it is
            // never stretched. Sprites/Default is always in the build and draws vertex alpha; the frame draws over the
            // surround and before the outlines and labels on it.
            (picture.frame, picture.surface) = Layer(go.transform, "Recorded picture", -10, FeatheredQuad());
            (picture.around, picture.surround) = Layer(go.transform, "Recorded surround", -20, new Mesh { name = "Recorded surround" });
            (picture.beyond, picture.far) = Layer(go.transform, "Recorded far field", -21, new Mesh { name = "Recorded far field" });
            picture.sphere = picture.around.GetComponent<MeshFilter>(); picture.farSphere = picture.beyond.GetComponent<MeshFilter>();
            picture.around.localPosition = new Vector3(0f, 0f, -Distance);
            picture.beyond.localPosition = new Vector3(0f, 0f, -Distance);
            picture.beyond.localScale = Vector3.one * 1.01f;
            var shade = new MaterialPropertyBlock(); shade.SetColor("_Color", new Color(SurroundShade, SurroundShade, SurroundShade, 1f));
            picture.surround.SetPropertyBlock(shade); picture.far.SetPropertyBlock(shade);
            // The media cue, on the frame: a clip's player bar (the track, the part played, and the play triangle of a
            // stopped player) or a photo's one word.
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
            picture.mark.transform.localScale = Vector3.one * (Em(MarkDegrees) / Mathf.Max(1e-5f, picture.mark.fontSize / 10f));
            picture.ShowBar(null, false);
            go.SetActive(false);
            return picture;
        }

        private static (Transform, MeshRenderer) Layer(Transform parent, string name, int order, Mesh mesh)
        {
            var host = new GameObject(name);
            host.transform.SetParent(parent, false);
            host.AddComponent<MeshFilter>().sharedMesh = mesh;
            var renderer = host.AddComponent<MeshRenderer>();
            renderer.sharedMaterial = new Material(Shader.Find("Sprites/Default")); renderer.sortingOrder = order;
            renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off; renderer.receiveShadows = false;
            return (host.transform, renderer);
        }

        /// <summary>
        /// Takes a still of the scene: a later one keeps the picture where it is and takes its own place on it. A clip's
        /// video stops; <see cref="Play"/> starts the new one. The picture shows once <see cref="Place"/> has put it in
        /// front of the person. False when the bytes do not decode, and nothing changes then.
        /// </summary>
        public bool Show(RecordedSceneView scene, byte[] jpeg, Transform head)
        {
            if (surface == null || !Decode(scene, jpeg, out var decoded)) return false;
            StopVideo();
            if (texture != null) Discard(texture);
            texture = decoded; still = sourceStill = jpeg; Scene = Source = scene;
            surface.sharedMaterial.mainTexture = texture;
            Blur(texture);
            Lay(scene, head);
            ShowBar(RecordedScenes.Progress(scene), false);
            gameObject.SetActive(Placed);
            if (Placed) Follow(head, null, float.PositiveInfinity);
            return true;
        }

        /// <summary>
        /// Puts the picture in front of <paramref name="head"/>, at eye level and facing it, and shows it: when the
        /// headset is first worn with a recording read, and again on the system recenter.
        /// </summary>
        public void Place(Transform head)
        {
            if (!Loaded) return;
            var forward = Vector3.ProjectOnPlane(head.forward, Vector3.up);
            if (forward.sqrMagnitude < 1e-4f) forward = Vector3.ProjectOnPlane(head.up, Vector3.up);
            forward.Normalize();
            transform.SetPositionAndRotation(head.position + forward * Distance, Quaternion.LookRotation(forward, Vector3.up));
            Placed = true;
            gameObject.SetActive(true);
            Follow(head, null, float.PositiveInfinity);
            // A clip read before the picture was placed starts preparing now: a hidden player cannot.
            if (player != null && video != null && !videoShown && !player.isPrepared && !player.isPlaying) player.Prepare();
        }

        /// <summary>
        /// Plays the shown clip's own video from <paramref name="url"/>, looping; its still stays until the first frame. A
        /// picture not yet placed starts the clip when it is.
        /// </summary>
        public void Play(Uri url, RecordedVideo clip)
        {
            if (frame == null || Source == null) return;
            StopVideo();
            clipLength = clip.DurationSeconds ?? 0f;
            video = new RenderTexture(clip.Width, clip.Height, 0, RenderTextureFormat.ARGB32) { name = "Recorded video", wrapMode = TextureWrapMode.Clamp };
            video.Create();
            if (player == null)
            {
                player = frame.gameObject.AddComponent<VideoPlayer>();
                player.playOnAwake = false;
                player.source = VideoSource.Url;
                player.renderMode = VideoRenderMode.RenderTexture;
                // The clip's sound would reach the microphone that hears the person, so it plays silent.
                player.audioOutputMode = VideoAudioOutputMode.None;
                player.isLooping = true;
                player.skipOnDrop = true;
                player.prepareCompleted += prepared =>
                {
                    Debug.Log($"Boopy: recorded video prepared {prepared.width}x{prepared.height} at {prepared.frameRate:0.##} fps, {prepared.length:0.##} s.");
                    prepared.Play();
                };
                player.errorReceived += (_, message) => Debug.LogWarning("Boopy: recorded video could not play: " + message);
            }
            player.targetTexture = video;
            player.url = url.ToString();
            if (gameObject.activeInHierarchy) player.Prepare();
        }

        /// <summary>Stops the clip where it is, for a boop; its time in the clip, or null when its video is not playing.</summary>
        public double? Pause()
        {
            if (player == null || !videoShown || !player.isPlaying) return null;
            player.Pause();
            return player.time;
        }

        /// <summary>
        /// Holds the analyzed still a stopped clip is about: the clip goes to its time, and its luminance and bytes are what
        /// a turn takes. False when the bytes do not decode.
        /// </summary>
        public bool Hold(RecordedSceneView held, byte[] jpeg)
        {
            if (!Loaded || !Decode(held, jpeg, out var decoded)) return false;
            Discard(decoded);
            still = jpeg; Scene = held;
            if (player != null && videoShown && held.SourceTimeSeconds is float at) player.time = at;
            return true;
        }

        /// <summary>Plays the stopped clip on from where it is; turns are about the Mac's still again.</summary>
        public void Resume()
        {
            if (player == null || !videoShown || player.isPlaying || Source == null) return;
            Scene = Source; still = sourceStill;
            player.Play();
        }

        private bool Decode(RecordedSceneView scene, byte[] jpeg, out Texture2D decoded)
        {
            decoded = new Texture2D(2, 2, TextureFormat.RGBA32, true) { name = "Recorded still", wrapMode = TextureWrapMode.Clamp };
            // The still shown may be sharper than the frame it stands for, never another shape; its size is read from it.
            if (!decoded.LoadImage(jpeg, false) || decoded.height == 0
                || Mathf.Abs((float)decoded.width / decoded.height - (float)scene.Width / scene.Height) > .01f)
            {
                Discard(decoded);
                return false;
            }
            Measure(decoded);
            // The pixels themselves go to the GPU only; the coarse grid stays.
            decoded.Apply(false, true);
            return true;
        }

        // The frame at the tangents its camera saw it from the eye at the placement; with no projection measured, fitted
        // whole into the headset's view, nothing cropped. The surround sphere around that eye maps each direction to the
        // same tangents, so inside the frame it shows the frame's own footage, and past it the footage's edge runs on.
        private void Lay(RecordedSceneView scene, Transform head)
        {
            if (frame == null || sphere == null || farSphere == null) return;
            var aspect = (float)scene.Width / scene.Height;
            if (scene.Projection is RecordedProjection seen) (left, right, up, down) = (seen.TanLeft, seen.TanRight, seen.TanUp, seen.TanDown);
            else
            {
                var view = HalfView(head.GetComponent<Camera>());
                var across = Mathf.Min(view.x, view.y * aspect);
                (left, right, up, down) = (across, across, across / aspect, across / aspect);
            }
            frame.localScale = new Vector3(Distance * (left + right), Distance * (up + down), 1f);
            frame.localPosition = new Vector3(Distance * (right - left) / 2f, Distance * (up - down) / 2f, 0f);
            sphere.sharedMesh = Surround(sphere.sharedMesh, left, right, up, down, true);
            farSphere.sharedMesh = Surround(farSphere.sharedMesh, left, right, up, down, false);
            float Inside(float tangent) => Mathf.Max(0f, Mathf.Tan(Mathf.Atan(tangent) - EdgeDegrees * Mathf.Deg2Rad));
            Sharp = (Inside(left), Inside(right), Inside(up), Inside(down));
            Readable = (Mathf.Clamp01((left - Inside(left)) / (left + right)), Mathf.Clamp01((up - Inside(up)) / (up + down)),
                Mathf.Clamp01((left + Inside(right)) / (left + right)), Mathf.Clamp01((up + Inside(down)) / (up + down)));
        }

        // A unit quad facing +Z whose outer edge dissolves to clear, for the frame: the whole image is on it, and across its
        // outer Feather on each side it fades smoothly (a smoothstep, in fine steps, the same along both axes, so no corner
        // or bevel shows) into the surround behind.
        private static Mesh FeatheredQuad()
        {
            const int steps = 6;
            var at = new System.Collections.Generic.List<float> { 0f };
            for (var k = 1; k <= steps; k++) at.Add(Feather * k / steps);
            for (var k = steps; k >= 1; k--) at.Add(1f - Feather * k / steps);
            at.Add(1f);
            float Fade(float t) { var edge = Mathf.Clamp01(Mathf.Min(t, 1f - t) / Feather); return edge * edge * (3f - 2f * edge); }
            var side = at.Count;
            var vertices = new Vector3[side * side]; var uv = new Vector2[vertices.Length]; var colors = new Color[vertices.Length];
            for (var row = 0; row < side; row++)
                for (var column = 0; column < side; column++)
                {
                    var i = row * side + column;
                    vertices[i] = new Vector3(at[column] - .5f, at[row] - .5f, 0f);
                    uv[i] = new Vector2(at[column], at[row]);
                    colors[i] = new Color(1f, 1f, 1f, Fade(at[column]) * Fade(at[row]));
                }
            var triangles = new int[(side - 1) * (side - 1) * 6];
            var t = 0;
            for (var row = 0; row < side - 1; row++)
                for (var column = 0; column < side - 1; column++)
                {
                    var i = row * side + column;
                    triangles[t++] = i; triangles[t++] = i + side; triangles[t++] = i + side + 1;
                    triangles[t++] = i; triangles[t++] = i + side + 1; triangles[t++] = i + 1;
                }
            return new Mesh { name = "Recorded picture", vertices = vertices, uv = uv, colors = colors, triangles = triangles };
        }

        // A sphere seen from inside, centred on the eye at the placement: each direction takes the image point at its angles
        // across and up, scaled so the frame's edges fall on the image's edges, and the blurred footage mirrors on past
        // them all the way round the person, so beside and behind the frame it is the footage's own light and colour. The
        // near one fades out from NearDegrees beyond the frame's edge over NearFade more, onto the far one behind it.
        private static Mesh Surround(Mesh mesh, float left, float right, float up, float down, bool near)
        {
            const int around = 64, high = 32;
            var (yawLeft, yawRight, pitchUp, pitchDown) = (Mathf.Atan(left), Mathf.Atan(right), Mathf.Atan(up), Mathf.Atan(down));
            var vertices = new Vector3[(around + 1) * (high + 1)]; var uv = new Vector2[vertices.Length]; var colors = new Color[vertices.Length];
            for (var j = 0; j <= high; j++)
                for (var i = 0; i <= around; i++)
                {
                    var pitch = Mathf.PI * (j / (float)high - .5f); var yaw = 2f * Mathf.PI * (i / (float)around - .5f);
                    var k = j * (around + 1) + i;
                    vertices[k] = new Vector3(Mathf.Cos(pitch) * Mathf.Sin(yaw), Mathf.Sin(pitch), Mathf.Cos(pitch) * Mathf.Cos(yaw)) * SurroundRadius;
                    uv[k] = new Vector2((yaw + yawLeft) / (yawLeft + yawRight), (pitch + pitchDown) / (pitchUp + pitchDown));
                    colors[k] = new Color(1f, 1f, 1f, near ? NearAlpha(yaw, pitch, yawLeft, yawRight, pitchUp, pitchDown) : 1f);
                }
            var triangles = new int[around * high * 6];
            var t = 0;
            for (var j = 0; j < high; j++)
                for (var i = 0; i < around; i++)
                {
                    var k = j * (around + 1) + i;
                    triangles[t++] = k; triangles[t++] = k + around + 1; triangles[t++] = k + around + 2;
                    triangles[t++] = k; triangles[t++] = k + around + 2; triangles[t++] = k + 1;
                }
            mesh.Clear();
            mesh.vertices = vertices; mesh.uv = uv; mesh.colors = colors; mesh.triangles = triangles;
            mesh.RecalculateBounds();
            return mesh;
        }

        /// <summary>How much of the near blur shows in a direction: whole within NearDegrees of the frame's edge (by angle), none past NearFade more.</summary>
        public static float NearAlpha(float yaw, float pitch, float yawLeft, float yawRight, float pitchUp, float pitchDown)
        {
            var across = Mathf.Max(0f, Mathf.Max(-yawLeft - yaw, yaw - yawRight)); var upward = Mathf.Max(0f, Mathf.Max(-pitchDown - pitch, pitch - pitchUp));
            var past = Mathf.Sqrt(across * across + upward * upward) * Mathf.Rad2Deg;
            var fade = Mathf.Clamp01((past - NearDegrees) / NearFade);
            return 1f - fade * fade * (3f - 2f * fade);
        }

        private void LateUpdate()
        {
            if (player == null || video == null || surface == null || !gameObject.activeSelf) return;
            // The still stays until the clip's first frame is in.
            if (!videoShown && player.isPlaying && player.frame >= 0)
            {
                videoShown = true; surface.sharedMaterial.mainTexture = video;
                Debug.Log($"Boopy: recorded video first frame shown at {player.time:0.00} s.");
            }
            if (!videoShown) return;
            Blur(video);
            var length = player.length > 0 ? player.length : clipLength;
            if (length > 0) ShowBar(Mathf.Clamp01((float)(player.time / length)), player.isPlaying);
        }

        // The surround's footage: halved again and again (each step averages four pixels) down to a few dozen pixels, then
        // stretched back over the surround, so it reads as the footage's light and colour with no detail.
        private void Blur(Texture source)
        {
            if (surround == null || source.width < 2 || source.height < 2) return;
            var first = new Vector2Int(Mathf.Max(1, source.width / 2), Mathf.Max(1, source.height / 2));
            if (blur.Length == 0 || blur[0].width != first.x || blur[0].height != first.y)
            {
                ReleaseBlur();
                var levels = new System.Collections.Generic.List<RenderTexture>();
                for (var size = first; ; size = new Vector2Int(Mathf.Max(1, size.x / 2), Mathf.Max(1, size.y / 2)))
                {
                    // Mirrored, so past the frame's edges the surround shows the footage folded back, never its edge smeared.
                    var level = new RenderTexture(size.x, size.y, 0, RenderTextureFormat.ARGB32) { name = "Recorded blur", filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Mirror };
                    level.Create(); levels.Add(level);
                    if (Mathf.Max(size.x, size.y) <= FarSide) break;
                }
                blur = levels.ToArray();
            }
            Graphics.Blit(source, blur[0]);
            for (var i = 1; i < blur.Length; i++) Graphics.Blit(blur[i - 1], blur[i]);
            // The near blur is the first level of at most BlurSide pixels; the far field the last, of at most FarSide.
            var nearLevel = Array.Find(blur, level => Mathf.Max(level.width, level.height) <= BlurSide) ?? blur[blur.Length - 1];
            surround.sharedMaterial.mainTexture = nearLevel;
            if (far != null) far.sharedMaterial.mainTexture = blur[blur.Length - 1];
        }

        private void ReleaseBlur()
        {
            foreach (var level in blur) { level.Release(); Discard(level); }
            blur = Array.Empty<RenderTexture>();
        }

        private void StopVideo()
        {
            if (player != null) { player.Stop(); player.targetTexture = null; }
            if (video != null) { video.Release(); Discard(video); video = null; }
            if (videoShown && surface != null) surface.sharedMaterial.mainTexture = texture;
            videoShown = false;
        }

        /// <summary>
        /// Keeps the media cue on the frame, in its lower-left a few degrees inside its edge, or its upper-left when
        /// <paramref name="avoid"/> (the subject's word) is near that corner; it eases there over <paramref name="elapsed"/>
        /// seconds, and infinity puts it there.
        /// </summary>
        public void Follow(Transform head, Vector3? avoid, float elapsed)
        {
            if (cue == null || frame == null || float.IsNaN(elapsed) || !Loaded) return;
            var plane = Plane;
            // The cue reaches this far left of its middle (the triangle past the bar) and this far right, up and down.
            var reachLeft = Em(CueBarDegrees) / 2f + SpatialTheme.Gap * Distance + Em(TriangleDegrees) * .87f;
            var reachRight = Em(CueBarDegrees) / 2f; var reachUp = Em(TriangleDegrees) / 2f;
            var x = Mathf.Min(Readable.X0 + reachLeft / plane.Width, Readable.X1 - reachRight / plane.Width);
            var toward = -N.Vector3.Normalize(N.Vector3.Cross(plane.Right, plane.Up));
            Vector3 Corner(float y) => Unity(plane.At(x, y, toward, .004f));
            var place = Corner(Readable.Y1 - reachUp / plane.Height);
            if (avoid is Vector3 word && Vector3.Angle(place - head.position, word - head.position) < AvoidDegrees) place = Corner(Readable.Y0 + reachUp / plane.Height);
            var ease = float.IsPositiveInfinity(elapsed) ? 1f : 1f - Mathf.Exp(-12f * Mathf.Max(0f, elapsed));
            cue.SetPositionAndRotation(Vector3.Lerp(cue.position, place, ease), frame.rotation);
            // Off the middle of the frame the cue is farther from the eye, so it grows to keep its size in degrees.
            if (around != null) cue.localScale = Vector3.one * (Vector3.Distance(around.position, cue.position) / Distance);
        }

        public void Hide()
        {
            StopVideo();
            gameObject.SetActive(false);
            if (surface != null) surface.sharedMaterial.mainTexture = null;
            if (surround != null) surround.sharedMaterial.mainTexture = null;
            if (far != null) far.sharedMaterial.mainTexture = null;
            ReleaseBlur();
            if (texture != null) Discard(texture);
            texture = null; still = sourceStill = null; Scene = Source = null; Held = null; luminance = Array.Empty<float>();
            Readable = (0f, 0f, 1f, 1f);
        }

        /// <summary>
        /// The view's half extents from the middle of the eyes, as tangents across and up or down: the larger side of
        /// both eyes' projections when the headset gives them, else about a Quest 3's view.
        /// </summary>
        public static Vector2 HalfView(Camera? eyes)
        {
            var fallback = new Vector2(Mathf.Tan(WideDegrees * Mathf.Deg2Rad / 2f), Mathf.Tan(TallDegrees * Mathf.Deg2Rad / 2f));
            if (eyes == null || !eyes.stereoEnabled) return fallback;
            var half = Vector2.zero;
            foreach (var eye in new[] { Camera.StereoscopicEye.Left, Camera.StereoscopicEye.Right })
            {
                var p = eyes.GetStereoProjectionMatrix(eye);
                if (Mathf.Abs(p.m00) < 1e-4f || Mathf.Abs(p.m11) < 1e-4f) return fallback;
                half.x = Mathf.Max(half.x, Mathf.Abs((p.m02 - 1f) / p.m00), Mathf.Abs((p.m02 + 1f) / p.m00));
                half.y = Mathf.Max(half.y, Mathf.Abs((p.m12 - 1f) / p.m11), Mathf.Abs((p.m12 + 1f) / p.m11));
            }
            // A projection that is not yet the headset's (before its first frame) is narrower than any headset's view.
            return half.x > .5f && half.y > .5f && !float.IsNaN(half.x + half.y) ? half : fallback;
        }

        private LineRenderer Bar(string name, Color color, int order)
        {
            var host = new GameObject(name);
            host.transform.SetParent(cue, false);
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
            if (luminance.Length == 0) return (0f, 1f);
            // Only the cells whose middles lie inside: from the first at or past each low edge to the last at or before each high.
            for (var row = Mathf.Max(0, Mathf.CeilToInt(y0 * rows - .5f)); row < rows && (row + .5f) / rows <= y1; row++)
                for (var column = Mathf.Max(0, Mathf.CeilToInt(x0 * columns - .5f)); column < columns && (column + .5f) / columns <= x1; column++)
                    inside.Add(luminance[row * columns + column]);
            if (inside.Count == 0) return (0f, 1f);
            inside.Sort();
            // Rounded outward, so a few cells (a short line's) keep their real darkest and brightest.
            return (inside[Mathf.FloorToInt(.05f * (inside.Count - 1))], inside[Mathf.CeilToInt(.95f * (inside.Count - 1))]);
        }

        /// <summary>The whole frame's tangents from the eye at the placement: left, right, up and down of its middle.</summary>
        public (float Left, float Right, float Up, float Down) Frame => (left, right, up, down);

        /// <summary>How busy the still is inside an image rectangle: the spread from its 5th to its 95th percentile luminance.</summary>
        public float Spread(float x0, float y0, float x1, float y1)
        {
            var (darkest, brightest) = LuminanceRange(x0, y0, x1, y1);
            return brightest - darkest;
        }

        // The play triangle of a stopped player, about 1.5 degrees tall from the eyes, sits just left of the bar's left end,
        // centered on the bar (DESIGN, on Chrome's player in one line); it is not a control, and a playing clip has none.
        public const float TriangleDegrees = 1.5f;
        private const float BarWidth = .003f;
        private void ShowBar(float? along, bool running)
        {
            Held = along;
            if (track == null || played == null || stopped == null || mark == null) return;
            var shown = along != null;
            track.gameObject.SetActive(shown); played.gameObject.SetActive(shown); stopped.gameObject.SetActive(shown && !running);
            // A photo's cue is its one word; a clip's is its bar.
            mark.gameObject.SetActive(!shown);
            if (along is not float at) return;
            var length = Em(CueBarDegrees);
            track.SetPosition(0, new Vector3(-length / 2f, 0f, 0f)); track.SetPosition(1, new Vector3(length / 2f, 0f, 0f));
            played.SetPosition(0, new Vector3(-length / 2f, 0f, -.001f)); played.SetPosition(1, new Vector3(-length / 2f + length * at, 0f, -.001f));
            // As tall as it is long, pointing right; its point ends one gap short of the bar.
            var tall = Em(TriangleDegrees);
            stopped.transform.localScale = new Vector3(tall * .87f, tall, 1f);
            stopped.transform.localPosition = new Vector3(-length / 2f - SpatialTheme.Gap * Distance - tall * .87f / 2f, 0f, 0f);
        }

        // An angle from the eyes as a length on the frame's plane.
        private static float Em(float degrees) => 2f * Distance * Mathf.Tan(degrees * Mathf.Deg2Rad / 2f);

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
            StopVideo();
            ReleaseBlur();
            if (texture != null) Discard(texture);
            if (surface != null) Discard(surface.sharedMaterial);
            if (surround != null) Discard(surround.sharedMaterial);
            if (far != null) Discard(far.sharedMaterial);
        }

        private static N.Vector3 Numerics(Vector3 value) => new N.Vector3(value.x, value.y, value.z);
        private static Vector3 Unity(N.Vector3 value) => new Vector3(value.X, value.Y, value.Z);

        // Editor checks run outside play mode, where only DestroyImmediate is allowed.
        private static void Discard(UnityEngine.Object gone)
        {
            if (Application.isPlaying) Destroy(gone);
            else DestroyImmediate(gone);
        }
    }
}
