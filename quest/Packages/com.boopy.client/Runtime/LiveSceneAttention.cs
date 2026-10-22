#nullable enable
using System;
using System.Collections.Generic;
using System.Numerics;

namespace Boopy.Client
{
    public sealed class LiveSceneProposal
    {
        private readonly float x0, y0, x1, y1;
        public string Label { get; }
        public float Confidence { get; }
        public float MaskConfidence { get; }
        public string MaskSha256 { get; }
        public int MaskPixels { get; }
        public Box2 Box => new Box2 { X0 = x0, Y0 = y0, X1 = x1, Y1 = y1 };
        public IReadOnlyList<Vector2> Contour { get; }
        public IReadOnlyList<int> Triangles { get; }

        internal LiveSceneProposal(SceneObject item, Vector2[] contour, int[] triangles)
        {
            Label = item.Label; Confidence = item.Confidence; MaskConfidence = item.MaskConfidence;
            MaskSha256 = item.MaskSha256; MaskPixels = item.MaskPixels;
            x0 = item.Box.X0; y0 = item.Box.Y0; x1 = item.Box.X1; y1 = item.Box.Y1;
            Contour = Array.AsReadOnly(contour); Triangles = Array.AsReadOnly(triangles);
        }

        /// <summary>A disposable presentation copy; mutations cannot change this admitted proposal.</summary>
        public Grounding GroundingFor(LiveSceneSource source)
        {
            var points = new List<Point2>(Contour.Count);
            foreach (var point in Contour) points.Add(new Point2 { X = point.X, Y = point.Y });
            return new Grounding {
                Kind = "box", Box = Box, Contour = points, ObservationId = source.FrameId,
                Spatial = new SpatialEvidence { Provider = source.Provider, Model = source.Model, Concept = Label,
                    Outcome = "contour", Verification = "proposed", Confidence = MaskConfidence,
                    FrameSha256 = source.FrameSha256, MaskSha256 = MaskSha256, LatencyMs = source.LatencyMs }
            };
        }
    }

    /// <summary>
    /// One validated immutable observation admission. Copies evidence, caches triangulation and
    /// retains no request, JPEG or mutable response DTO. A replacement is a new admission, not a track.
    /// </summary>
    public sealed class LiveSceneSource
    {
        public string StreamId { get; }
        public string FrameId { get; }
        public int Sequence { get; }
        public string CapturedAt { get; }
        public string FrameSha256 { get; }
        public string EventId { get; }
        public string Provider { get; }
        public string Model { get; }
        public string Verification => "proposed";
        public bool FrameRetained { get; }
        public float LatencyMs { get; }
        public float SourceTime { get; }
        public IReadOnlyList<LiveSceneProposal> Objects { get; }

        private LiveSceneSource(SceneObservation source, float sourceTime, List<LiveSceneProposal> objects)
        {
            StreamId = source.StreamId; FrameId = source.FrameId; Sequence = source.Sequence;
            CapturedAt = source.CapturedAt; FrameSha256 = source.FrameSha256; EventId = source.EventId;
            Provider = source.Provider; Model = source.Model; FrameRetained = source.FrameRetained;
            LatencyMs = source.LatencyMs; SourceTime = sourceTime; Objects = objects.AsReadOnly();
        }

        public static bool TryCreate(SceneObservation? source, SceneObservationRequest? request,
            float sourceTime, float now, out LiveSceneSource? bound)
        {
            bound = null;
            if (!CameraFrameTime.IsFresh(sourceTime, now) || source == null || request?.Frame == null
                || request.Frame.Jpeg == null || source.FrameSha256 == null
                || source.Objects == null || source.Objects.Count > 4) return false;
            // Validate the copies that will actually be admitted, rather than retaining a
            // mutable DTO and relying on an earlier successful transport validation.
            var frozen = new SceneObservation {
                StreamId = source.StreamId, FrameId = source.FrameId, Sequence = source.Sequence,
                CapturedAt = source.CapturedAt, FrameSha256 = source.FrameSha256, EventId = source.EventId,
                Provider = source.Provider, Model = source.Model, Verification = source.Verification,
                FrameRetained = source.FrameRetained, LatencyMs = source.LatencyMs
            };
            foreach (var item in source.Objects)
            {
                if (item == null || item.Box == null || item.Contour == null || item.MaskSha256 == null
                    || item.Contour.Count < 3 || item.Contour.Count > 256
                    || !Normalized(item.Box.X0) || !Normalized(item.Box.Y0)
                    || !Normalized(item.Box.X1) || !Normalized(item.Box.Y1)
                    || item.Box.X0 >= item.Box.X1 || item.Box.Y0 >= item.Box.Y1) return false;
                var points = new List<Point2>(item.Contour.Count);
                foreach (var point in item.Contour)
                {
                    if (point == null) return false;
                    points.Add(new Point2 { X = point.X, Y = point.Y });
                }
                frozen.Objects.Add(new SceneObject {
                    Label = item.Label, Confidence = item.Confidence, MaskConfidence = item.MaskConfidence,
                    MaskSha256 = item.MaskSha256, MaskPixels = item.MaskPixels,
                    Box = new Box2 { X0 = item.Box.X0, Y0 = item.Box.Y0, X1 = item.Box.X1, Y1 = item.Box.Y1 },
                    Contour = points
                });
            }
            var requested = new SceneObservationRequest {
                StreamId = request.StreamId, FrameId = request.FrameId, Sequence = request.Sequence,
                Frame = new FrameData { CapturedAt = request.Frame.CapturedAt, Jpeg = request.Frame.Jpeg }
            };
            if (!frozen.Matches(requested)) return false;
            var objects = new List<LiveSceneProposal>(frozen.Objects.Count);
            foreach (var item in frozen.Objects)
            {
                var contour = new Vector2[item.Contour.Count];
                for (var i = 0; i < contour.Length; i++) contour[i] = new Vector2(item.Contour[i].X, item.Contour[i].Y);
                if (!SurfaceGeometry.TryTriangulate(contour, out var triangles)) return false;
                objects.Add(new LiveSceneProposal(item, contour, triangles));
            }
            bound = new LiveSceneSource(frozen, sourceTime, objects);
            return true;
        }

        private static bool Normalized(float value) => !float.IsNaN(value) && !float.IsInfinity(value)
            && value >= 0f && value <= 1f;
    }

    /// <summary>One observation-local presentation target, never a confirmed or persistently tracked object.</summary>
    public sealed class LiveSceneTarget
    {
        private readonly LiveSceneSource? admittedSource;
        public string StreamId { get; }
        public string FrameId { get; }
        public int Sequence { get; }
        public string CapturedAt { get; }
        public string FrameSha256 { get; }
        public string EventId { get; }
        public string Provider { get; }
        public string Model { get; }
        public int ObjectIndex { get; }
        public bool FromPointer { get; }
        public string MaskSha256 { get; }
        public float SourceTime { get; }

        internal LiveSceneTarget(SceneObservation source, int index, bool fromPointer, float sourceTime)
        {
            StreamId = source.StreamId; FrameId = source.FrameId; Sequence = source.Sequence;
            CapturedAt = source.CapturedAt; FrameSha256 = source.FrameSha256; EventId = source.EventId;
            Provider = source.Provider; Model = source.Model; ObjectIndex = index;
            FromPointer = fromPointer; MaskSha256 = source.Objects[index].MaskSha256; SourceTime = sourceTime;
        }

        internal LiveSceneTarget(LiveSceneSource source, int index, bool fromPointer)
        {
            admittedSource = source;
            StreamId = source.StreamId; FrameId = source.FrameId; Sequence = source.Sequence;
            CapturedAt = source.CapturedAt; FrameSha256 = source.FrameSha256; EventId = source.EventId;
            Provider = source.Provider; Model = source.Model; ObjectIndex = index;
            FromPointer = fromPointer; MaskSha256 = source.Objects[index].MaskSha256; SourceTime = source.SourceTime;
        }

        internal bool Matches(LiveSceneSource source) => ReferenceEquals(admittedSource, source)
            && SourceTime == source.SourceTime && StreamId == source.StreamId && FrameId == source.FrameId
            && Sequence == source.Sequence && CapturedAt == source.CapturedAt && FrameSha256 == source.FrameSha256
            && EventId == source.EventId && Provider == source.Provider && Model == source.Model
            && ObjectIndex >= 0 && ObjectIndex < source.Objects.Count
            && MaskSha256 == source.Objects[ObjectIndex].MaskSha256;

        internal bool Matches(SceneObservation source, float sourceTime) => SourceTime == sourceTime
            && StreamId == source.StreamId && FrameId == source.FrameId && Sequence == source.Sequence
            && CapturedAt == source.CapturedAt && FrameSha256 == source.FrameSha256 && EventId == source.EventId
            && Provider == source.Provider && Model == source.Model
            && ObjectIndex >= 0 && ObjectIndex < source.Objects.Count
            && MaskSha256 == source.Objects[ObjectIndex].MaskSha256;
    }

    /// <summary>
    /// Pure contour targeting using normalized points projected into the exact source image.
    /// Head direction is not eye gaze. Active pointing takes priority, including a miss or
    /// ambiguous overlap. No confidence ranking, semantic decision, mutation or tracking occurs.
    /// </summary>
    public static class LiveSceneAttention
    {
        public static bool TrySelect(LiveSceneSource source, float now, Vector2? headPoint,
            Vector2? pointerPoint, out LiveSceneTarget? target)
        {
            target = null;
            if (source == null || !CameraFrameTime.IsFresh(source.SourceTime, now)) return false;
            var point = pointerPoint ?? headPoint;
            if (!point.HasValue || !Normalized(point.Value.X) || !Normalized(point.Value.Y)) return false;
            var index = -1;
            for (var i = 0; i < source.Objects.Count; i++)
            {
                if (!SurfaceGeometry.Contains(source.Objects[i].Contour, point.Value)) continue;
                if (index >= 0) return false;
                index = i;
            }
            if (index < 0) return false;
            target = new LiveSceneTarget(source, index, pointerPoint.HasValue);
            return true;
        }

        public static bool IsCurrent(LiveSceneTarget? target, LiveSceneSource source, float now) => target != null
            && source != null && CameraFrameTime.IsFresh(source.SourceTime, now) && target.Matches(source);

        public static bool TrySelect(SceneObservation source, SceneObservationRequest request,
            float sourceTime, float now, Vector2? headPoint, Vector2? pointerPoint, out LiveSceneTarget? target)
        {
            target = null;
            if (!CurrentSource(source, request, sourceTime, now)) return false;
            var point = pointerPoint ?? headPoint;
            if (!point.HasValue || !Normalized(point.Value.X) || !Normalized(point.Value.Y)) return false;
            var index = -1;
            for (var i = 0; i < source.Objects.Count; i++)
            {
                if (!Geometry.TryContour(source.Objects[i].GroundingFor(source), out var contour)
                    || !SurfaceGeometry.Contains(contour, point.Value)) continue;
                if (index >= 0) return false;
                index = i;
            }
            if (index < 0) return false;
            target = new LiveSceneTarget(source, index, pointerPoint.HasValue, sourceTime);
            return true;
        }

        /// <summary>Recheck before presentation or dispatch; the original monotonic source time cannot be renewed.</summary>
        public static bool IsCurrent(LiveSceneTarget? target, SceneObservation source,
            SceneObservationRequest request, float sourceTime, float now) => target != null
            && CurrentSource(source, request, sourceTime, now) && target.Matches(source, sourceTime);

        // sourceTime is the capture timestamp already translated once by CameraFrameTime.
        // The source DTO/request comparison reuses the client transport's established checks.
        private static bool CurrentSource(SceneObservation source, SceneObservationRequest request,
            float sourceTime, float now) => CameraFrameTime.IsFresh(sourceTime, now) && source.Matches(request);

        private static bool Normalized(float value) => !float.IsNaN(value) && !float.IsInfinity(value)
            && value >= 0f && value <= 1f;
    }
}
