#nullable enable
using System;
using System.Collections.Generic;
using System.Numerics;
using System.Text.RegularExpressions;

namespace Boopy.Client
{
    /// <summary>
    /// The recorded scene the Mac shows: one still of the person's own recording, chosen on the Mac. It is never live,
    /// now or in the room; its capture time is unknown or unverified. The headset only reads it.
    /// </summary>
    public sealed class RecordedSceneView
    {
        public string RecordingId { get; set; } = "";
        public string FrameId { get; set; } = "";
        /// <summary>"photo" or "video".</summary>
        public string Kind { get; set; } = "";
        /// <summary>The upright still's size in pixels.</summary>
        public int Width { get; set; }
        public int Height { get; set; }
        /// <summary>Where the still sits in its clip, and the clip's length; null for a photo.</summary>
        public float? SourceTimeSeconds { get; set; }
        public float? DurationSeconds { get; set; }
        public RecordedCaptureTime CapturedAt { get; set; } = new RecordedCaptureTime();
        public string FrameSha256 { get; set; } = "";
        /// <summary>Every sampled still of the recording, in order; empty for a photo.</summary>
        public List<RecordedFrameInfo> Frames { get; set; } = new List<RecordedFrameInfo>();
        /// <summary>A clip's own video, to play as it was recorded; null for a photo or a clip the Mac serves none of.</summary>
        public RecordedVideo? Video { get; set; }
        /// <summary>How the source's camera saw the frame; null when it was not measured.</summary>
        public RecordedProjection? Projection { get; set; }
    }

    /// <summary>
    /// A clip's video on the Mac, as it was captured: the service path it is served at (with byte ranges), its digest, its
    /// upright size, and its length and frame rate when known. The scene's frame times are times in it.
    /// </summary>
    public sealed class RecordedVideo
    {
        public string Url { get; set; } = "";
        public string Sha256 { get; set; } = "";
        public int Width { get; set; }
        public int Height { get; set; }
        public float? DurationSeconds { get; set; }
        public float? FrameRate { get; set; }
    }

    /// <summary>
    /// The frame as its camera saw it, a rectilinear view: the tangents of the angles from the camera's forward axis to the
    /// frame's left, right, top and bottom edges, so the headset can put the frame back at exactly those angles.
    /// </summary>
    public sealed class RecordedProjection
    {
        public float TanLeft { get; set; }
        public float TanRight { get; set; }
        public float TanUp { get; set; }
        public float TanDown { get; set; }
        /// <summary>"lens-tag" or "measured-device-profile"; with a profile's name, and whether its centre was measured.</summary>
        public string Source { get; set; } = "";
        public string? Profile { get; set; }
        public string Centring { get; set; } = "";
    }

    /// <summary>When the recording was made, as its file says: a value only when known, and never trusted.</summary>
    public sealed class RecordedCaptureTime
    {
        public string? Value { get; set; }
        /// <summary>"unknown" or "unverified".</summary>
        public string Trust { get; set; } = "unknown";
    }

    public sealed class RecordedFrameInfo
    {
        public string FrameId { get; set; } = "";
        public float Seconds { get; set; }
        public string FrameSha256 { get; set; } = "";
    }

    public sealed class RecordedSceneEnvelope
    {
        public RecordedSceneView? Scene { get; set; }
    }

    /// <summary>
    /// The outlines a local outline run proposed on the shown recording, by frame (docs/recorded.md): each frame's own and
    /// never another's, and only proposed.
    /// </summary>
    public sealed class RecordedOutlines
    {
        public List<RecordedOutlineSample> Samples { get; set; } = new List<RecordedOutlineSample>();

        /// <summary>The well-formed objects outlined on one frame; none for a frame the run left without outlines.</summary>
        public IReadOnlyList<RecordedOutlineObject> On(string frameId)
        {
            var objects = new List<RecordedOutlineObject>();
            foreach (var sample in Samples)
                if (sample.FrameId == frameId && sample.Verification == "proposed")
                    foreach (var outlined in sample.Objects)
                        if (outlined.Extent() != null) objects.Add(outlined);
            return objects;
        }
    }

    public sealed class RecordedOutlineSample
    {
        public string FrameId { get; set; } = "";
        public float? Seconds { get; set; }
        public string Verification { get; set; } = "";
        public List<RecordedOutlineObject> Objects { get; set; } = new List<RecordedOutlineObject>();
    }

    /// <summary>One object a run outlined on a frame: its label and box, and its contour when it has one.</summary>
    public sealed class RecordedOutlineObject
    {
        public string Label { get; set; } = "";
        public float Confidence { get; set; }
        public string Origin { get; set; } = "";
        public Box2? Box { get; set; }
        public List<Point2>? Contour { get; set; }

        /// <summary>The extent of its contour (three points or more), else of its box, in image coordinates; null when neither lies in the frame.</summary>
        public Box2? Extent()
        {
            static bool In(float value) => !float.IsNaN(value) && value >= 0f && value <= 1f;
            if (Contour != null && Contour.Count >= 3 && Contour.TrueForAll(point => point != null && In(point.X) && In(point.Y)))
            {
                var extent = new Box2 { X0 = 1f, Y0 = 1f, X1 = 0f, Y1 = 0f };
                foreach (var point in Contour)
                {
                    extent.X0 = Math.Min(extent.X0, point.X); extent.Y0 = Math.Min(extent.Y0, point.Y);
                    extent.X1 = Math.Max(extent.X1, point.X); extent.Y1 = Math.Max(extent.Y1, point.Y);
                }
                return extent;
            }
            return Box != null && In(Box.X0) && In(Box.Y0) && In(Box.X1) && In(Box.Y1) && Box.X0 < Box.X1 && Box.Y0 < Box.Y1 ? Box : null;
        }
    }

    /// <summary>The still a turn is about. The Mac makes the observation from its own copy; the headset sends no pixels.</summary>
    public sealed class RecordedFrameRef
    {
        public string RecordingId { get; set; } = "";
        public string FrameId { get; set; } = "";
    }

    public static class RecordedScenes
    {
        /// <summary>The largest still the headset accepts. The Mac sends at most 2 MiB with a long edge of 1280.</summary>
        public const int MaxFrameBytes = 4 * 1024 * 1024;
        public const int MaxSide = 4096;

        public const int MaxFrames = 1000;
        // \z, not $: $ also matches before a final line feed.
        private static readonly Regex RecordingPattern = new Regex(@"^rec_[0-9a-f]{32}\z");
        private static readonly Regex FramePattern = new Regex(@"^rfr_[0-9a-f]{32}\z");
        private static readonly Regex DigestPattern = new Regex(@"^[0-9a-f]{64}\z");
        // A path under the service's own API, never another host or a way out of it.
        private static readonly Regex ServicePathPattern = new Regex(@"^/?v1/[A-Za-z0-9_\-./]+\z");
        public const float MaxFrameRate = 240f, MaxTangent = 20f;

        public static bool IsServicePath(string? path) =>
            path != null && ServicePathPattern.IsMatch(path) && !path.Contains("..") && !path.Contains("//");

        /// <summary>The analyzed still nearest a time in the clip, which a boop there is about; null when the clip lists none.</summary>
        public static RecordedFrameInfo? Nearest(RecordedSceneView scene, double seconds)
        {
            RecordedFrameInfo? nearest = null;
            foreach (var frame in scene.Frames)
                if (nearest == null || Math.Abs(frame.Seconds - seconds) < Math.Abs(nearest.Seconds - seconds)) nearest = frame;
            return nearest;
        }

        public static bool IsRecordingId(string? id) => id != null && RecordingPattern.IsMatch(id);
        public static bool IsFrameId(string? id) => id != null && FramePattern.IsMatch(id);
        public static bool IsDigest(string? sha256) => sha256 != null && DigestPattern.IsMatch(sha256);

        /// <summary>Where a clip's still is held, 0 to 1 along the clip, for the player bar under it; null for a photo or a
        /// clip whose length the Mac did not send.</summary>
        public static float? Progress(RecordedSceneView scene) =>
            scene.Kind == "video" && scene.SourceTimeSeconds is float at && scene.DurationSeconds is float length && length > 0f
                ? Math.Clamp(at / length, 0f, 1f) : (float?)null;

        /// <summary>A scene the headset can show: ids, kind, size, digest and capture trust all as the Mac promises.</summary>
        public static bool Valid(RecordedSceneView? scene)
        {
            if (scene == null || !IsRecordingId(scene.RecordingId) || !IsFrameId(scene.FrameId) || !IsDigest(scene.FrameSha256)
                || (scene.Kind != "photo" && scene.Kind != "video")
                || scene.Width < 1 || scene.Width > MaxSide || scene.Height < 1 || scene.Height > MaxSide
                || (scene.SourceTimeSeconds is float at && (float.IsNaN(at) || float.IsInfinity(at) || at < 0f))
                || (scene.DurationSeconds is float length && (float.IsNaN(length) || float.IsInfinity(length) || length < 0f
                    || (scene.SourceTimeSeconds is float held && held > length)))
                || scene.CapturedAt == null || scene.Frames == null || scene.Frames.Count > MaxFrames) return false;
            // A clip's video is under the service, a real size and frame rate and a length; only a clip has one.
            if (scene.Video is RecordedVideo video && (scene.Kind != "video" || !IsServicePath(video.Url) || !IsDigest(video.Sha256)
                || video.Width < 1 || video.Width > MaxSide || video.Height < 1 || video.Height > MaxSide
                || (video.FrameRate is float rate && !(rate > 0f && rate <= MaxFrameRate))
                || (video.DurationSeconds is float played && (!(played > 0f) || float.IsInfinity(played))))) return false;
            // A projection reaches some way on each axis, with no edge past about 87 degrees, and says where it came from.
            static bool Tangent(float value) => !float.IsNaN(value) && Math.Abs(value) <= MaxTangent;
            if (scene.Projection is RecordedProjection seen && !(Tangent(seen.TanLeft) && Tangent(seen.TanRight) && Tangent(seen.TanUp)
                && Tangent(seen.TanDown) && seen.TanLeft + seen.TanRight > .01f && seen.TanUp + seen.TanDown > .01f
                && (seen.Source == "lens-tag" || seen.Source == "measured-device-profile"))) return false;
            // An unknown capture time has no value; a known one is never more than unverified.
            if (scene.CapturedAt.Trust == "unknown" ? scene.CapturedAt.Value != null
                : scene.CapturedAt.Trust != "unverified" || (scene.CapturedAt.Value != null && scene.CapturedAt.Value.Trim().Length == 0)) return false;
            var shown = scene.Frames.Count == 0;
            foreach (var frame in scene.Frames)
            {
                if (frame == null || !IsFrameId(frame.FrameId) || !IsDigest(frame.FrameSha256)
                    || float.IsNaN(frame.Seconds) || float.IsInfinity(frame.Seconds) || frame.Seconds < 0f) return false;
                shown |= frame.FrameId == scene.FrameId && frame.FrameSha256 == scene.FrameSha256;
            }
            // A clip's list holds the still it shows, with the same digest.
            return shown;
        }
    }

    /// <summary>
    /// A recorded still shown flat in the room: its rectangle, and the map between its image points (0 to 1, origin
    /// top-left, y down) and the room. A 2D source has no depth, so the picture's plane is where its subjects lie.
    /// </summary>
    public readonly struct PicturePlane
    {
        public PicturePlane(Vector3 center, Vector3 right, Vector3 up, float width, float height)
        {
            Center = center; Right = right; Up = up; Width = width; Height = height;
        }

        public Vector3 Center { get; }
        /// <summary>Unit vectors along the picture's top edge (left to right) and its side (bottom to top).</summary>
        public Vector3 Right { get; }
        public Vector3 Up { get; }
        public float Width { get; }
        public float Height { get; }

        /// <summary>The room point of an image point, lifted along <paramref name="toward"/> by <paramref name="lift"/> meters.</summary>
        public Vector3 At(float x, float y, Vector3 toward = default, float lift = 0f) =>
            Center + Right * ((x - 0.5f) * Width) + Up * ((0.5f - y) * Height) + toward * lift;

        /// <summary>Where a ray meets the picture, as an image point; false when it misses, runs parallel or points away.</summary>
        public bool TryImage(Vector3 origin, Vector3 direction, out float x, out float y, out Vector3 hit)
        {
            x = y = 0f; hit = default;
            var normal = Vector3.Cross(Right, Up);
            var facing = Vector3.Dot(direction, normal);
            if (MathF.Abs(facing) < 1e-6f || Width <= 0f || Height <= 0f) return false;
            var along = Vector3.Dot(Center - origin, normal) / facing;
            if (!(along > 0f)) return false;
            hit = origin + direction * along;
            var local = hit - Center;
            var u = Vector3.Dot(local, Right) / Width + 0.5f;
            var v = 0.5f - Vector3.Dot(local, Up) / Height;
            // A ray aimed at an edge may land a rounding step outside it.
            const float edge = 1e-5f;
            if (u < -edge || u > 1f + edge || v < -edge || v > 1f + edge) return false;
            x = Math.Clamp(u, 0f, 1f); y = Math.Clamp(v, 0f, 1f);
            return true;
        }
    }
}
