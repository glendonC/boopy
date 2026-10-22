#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using Boopy.Client;
using UnityEngine;
using N = System.Numerics;

namespace Boopy.Quest
{
    /// <summary>Captured proposed contours, with one source-bound label for current head/hand attention.</summary>
    public sealed class LiveSceneHud : MonoBehaviour
    {
        private sealed class PlacedProposal
        {
            public int Index;
            public Vector3[] Boundary = Array.Empty<Vector3>();
            public N.Vector3[] ProtectedContour = Array.Empty<N.Vector3>();
            public N.Vector3[] ProtectedBox = Array.Empty<N.Vector3>();
            public GroundedOverlay Overlay = null!;
        }
        private Transform? head;
        private RoomCamera? room;
        private readonly List<GroundedOverlay> outlines = new List<GroundedOverlay>();
        private readonly List<PlacedProposal> placed = new List<PlacedProposal>();
        private readonly List<LabelRect> protectedAreas = new List<LabelRect>();
        private LiveSceneSource? source;
        private Chip? label;
        private Ray headRay;
        private Ray? handRay;
        private int labelIndex = -1;
        private bool active, processing, reduced, paused;
        private string status = "Looking around";
        private Vector3? firstTarget;
        private const float Gap = .02f;
        private static readonly LabelRect ViewBounds = new LabelRect(-.9f, -.65f, .9f, .65f);
        public int VisibleObjects { get; private set; }
        public string Status => !active || paused ? "Scene paused" : status;
        public Vector3? FirstTarget => active && !paused ? firstTarget : null;
        public LiveSceneTarget? CurrentTarget { get; private set; }
        public bool HasPresentationFocus { get; private set; }

        public static LiveSceneHud Create(Transform parent, Transform head, RoomCamera room)
        {
            var go = new GameObject("Live scene HUD"); go.transform.SetParent(parent, false);
            var hud = go.AddComponent<LiveSceneHud>(); hud.head = head; hud.room = room;
            for (var i = 0; i < 4; i++)
            {
                var outline = GroundedOverlay.Create(go.transform, ambient: true);
                outline.gameObject.SetActive(false); hud.outlines.Add(outline);
            }
            hud.SetActive(true, false); return hud;
        }
        public void SetActive(bool value, bool reduce)
        {
            var resumed = value && !active;
            active = value; reduced = reduce;
            foreach (var outline in outlines) outline.SetReducedMotion(reduced);
            label?.SetReducedMotion(reduced);
            if (!value) ClearObjects();
            else if (resumed) status = "Looking around";
        }
        public void SetPaused(bool value)
        {
            if (paused == value) return;
            paused = value; ClearObjects(); status = "Looking around";
        }
        public void SetProcessing(bool value)
        {
            processing = value;
            if (value && VisibleObjects == 0) status = "Looking around";
        }
        public void Unavailable() { status = "Scene recognition unavailable"; ClearObjects(); }

        public bool Show(SceneObservation result, SceneObservationRequest request, Snapshot snapshot, float now)
        {
            if (!active || paused || head == null || room == null || snapshot.SourceTime == null
                || !SnapshotMatches(snapshot, request)
                || !LiveSceneSource.TryCreate(result, request, snapshot.SourceTime.Value, now, out var admitted)
                || admitted == null) return false;
            ClearObjects(); source = admitted;
            // Sorting presentation must not change the observation-local object index.
            var ordered = Enumerable.Range(0, source.Objects.Count)
                .OrderBy(index => source.Objects[index].Box.X0).ThenBy(index => source.Objects[index].Box.Y0).ToArray();
            foreach (var index in ordered)
            {
                var proposal = source.Objects[index]; var grounding = proposal.GroundingFor(source);
                var points = room.PlaceBoundary(grounding, snapshot, out var depth);
                var overlay = outlines[placed.Count]; overlay.gameObject.SetActive(true);
                overlay.SetReducedMotion(reduced); overlay.Show(grounding, points, depth, false);
                overlay.SetAmbientViewer(head.position);
                placed.Add(new PlacedProposal { Index = index, Boundary = points, Overlay = overlay,
                    ProtectedContour = points.Select(ToNumerics).ToArray(),
                    ProtectedBox = room.PlaceBoundary(new Grounding { Kind = "box", Box = proposal.Box }, snapshot, out _)
                        .Select(ToNumerics).ToArray() });
                if (firstTarget == null && points.Length > 0)
                    firstTarget = points.Aggregate(Vector3.zero, (sum, point) => sum + point) / points.Length;
            }
            VisibleObjects = placed.Count;
            status = VisibleObjects == 0 ? "Looking around" : "Live view";
            return true;
        }
        // Match the snapshot used for placement once. No pixels or mutable capture metadata
        // enter the attention/layout frame loop.
        private static bool SnapshotMatches(Snapshot snapshot, SceneObservationRequest request)
        {
            var frame = request?.Frame;
            return frame != null && snapshot.Jpeg != null && frame.Width == snapshot.Width && frame.Height == snapshot.Height
                && frame.CapturedAt == snapshot.CapturedAt.ToUniversalTime().ToString("o")
                && frame.Jpeg == Convert.ToBase64String(snapshot.Jpeg)
                && frame.Camera != null && snapshot.Camera != null
                && frame.Camera.Eye == snapshot.Camera.Eye && frame.Camera.Pose != null && snapshot.Camera.Pose != null
                && Same(frame.Camera.Pose.Position, new[] { snapshot.Pose.position.x, snapshot.Pose.position.y, snapshot.Pose.position.z })
                && Same(frame.Camera.Pose.Rotation, new[] { snapshot.Pose.rotation.x, snapshot.Pose.rotation.y, snapshot.Pose.rotation.z, snapshot.Pose.rotation.w })
                && Same(frame.Camera.Pose.Position, snapshot.Camera.Pose.Position)
                && Same(frame.Camera.Pose.Rotation, snapshot.Camera.Pose.Rotation)
                && Same(frame.Camera.FocalLength, snapshot.Camera.FocalLength)
                && Same(frame.Camera.PrincipalPoint, snapshot.Camera.PrincipalPoint)
                && Same(frame.Camera.SensorResolution, snapshot.Camera.SensorResolution)
                && frame.Depth != null && snapshot.Depth != null
                && frame.Depth.Columns == snapshot.Depth.Columns && frame.Depth.Rows == snapshot.Depth.Rows
                && Same(frame.Depth.Meters, snapshot.Depth.Meters);
        }
        private static bool Same<T>(T[]? first, T[]? second) => first != null && second != null && first.SequenceEqual(second);
        public void SetAttentionRays(Ray currentHeadRay, Ray? activeHandRay)
        { headRay = currentHeadRay; handRay = activeHandRay; }

        public void RefreshAttention(float now, IReadOnlyList<LabelRect> occupied, LabelRect center, float scale)
        {
            Refresh(0f, now);
            if (!active || paused || head == null || source == null) { HideLabel(true); return; }
            var cue = handRay ?? headRay;
            var holding = label != null && label.gameObject.activeSelf
                && LiveSceneAttention.IsCurrent(CurrentTarget, source, now) && LabelContains(cue, label);
            HasPresentationFocus = holding;
            if (!holding)
            {
                var point = ImagePoint(cue); var invalid = new N.Vector2(-1f, -1f);
                var selected = LiveSceneAttention.TrySelect(source, now,
                    handRay.HasValue ? null : point, handRay.HasValue ? point ?? invalid : (N.Vector2?)null, out var target);
                if (!selected || target == null) { HideLabel(true); return; }
                if (CurrentTarget == null || CurrentTarget.ObjectIndex != target.ObjectIndex
                    || CurrentTarget.FromPointer != target.FromPointer) CurrentTarget = target;
            }
            if (CurrentTarget == null) { HideLabel(true); return; }
            var selectedShape = placed.Find(shape => shape.Index == CurrentTarget.ObjectIndex);
            if (selectedShape == null) { HideLabel(true); return; }
            if (label == null) label = Chip.Create(transform, Visuals.Quad());
            label.SetReducedMotion(reduced);
            if (labelIndex != selectedShape.Index)
            { label.ShowProposed(source.Objects[selectedShape.Index].Label); labelIndex = selectedShape.Index; }
            label.Shrink = scale;
            var viewer = new HeadPose(ToNumerics(head.position), ToNumerics(head.forward));
            protectedAreas.Clear();
            foreach (var shape in placed)
            {
                if (ProjectedKeepout.TryEnvelope(shape.ProtectedContour, viewer, out var contour)) protectedAreas.Add(contour);
                if (ProjectedKeepout.TryEnvelope(shape.ProtectedBox, viewer, out var box)) protectedAreas.Add(box);
            }
            var previous = label.gameObject.activeSelf && label.Placed;
            label.gameObject.SetActive(true); label.Face(head);
            bool Clear(LabelRect area) => ViewBounds.Contains(area) && !area.Intersects(center, Gap)
                && ProjectedKeepout.IsClear(area, protectedAreas, Gap) && ProjectedKeepout.IsClear(area, occupied, Gap);
            if (!(previous && LabelBounds(label, viewer, out var existing) && Clear(existing)))
            {
                var preferred = ProjectedKeepout.TryEnvelope(selectedShape.ProtectedContour, viewer, out var subject)
                    ? subject.Center : N.Vector2.Zero;
                var dimensions = label.LayoutSize * scale; var size = new N.Vector2(dimensions.x, dimensions.y);
                var found = false;
                for (var attempt = 0; attempt < 8; attempt++)
                {
                    if (!SpatialLabelLayout.TryPlace(preferred, size, protectedAreas, occupied,
                        ViewBounds, center, out var candidate, Gap)) break;
                    var right = Vector3.Cross(Vector3.up, head.forward).normalized;
                    if (right.sqrMagnitude < 1e-8f) right = head.right;
                    var up = Vector3.Cross(head.forward, right).normalized;
                    var home = head.position + (head.forward + right * candidate.Center.X + up * candidate.Center.Y).normalized;
                    label.Place(home, NearestBoundary(home, selectedShape.Boundary)); label.Face(head);
                    if (!LabelBounds(label, viewer, out var actual)) break;
                    if (Clear(actual)) { found = true; break; }
                    size = new N.Vector2(MathF.Max(size.X, 2f * MathF.Max(candidate.Center.X - actual.MinX, actual.MaxX - candidate.Center.X)) * 1.05f,
                        MathF.Max(size.Y, 2f * MathF.Max(candidate.Center.Y - actual.MinY, actual.MaxY - candidate.Center.Y)) * 1.05f);
                }
                if (!found) { HideLabel(false); return; }
            }
            // Endpoint belongs to this source's placed boundary, never a new current-depth hit.
            label.Place(label.Home, NearestBoundary(label.Home, selectedShape.Boundary)); label.Face(head);
            foreach (var shape in placed) shape.Overlay.SetFocus(shape.Index == CurrentTarget.ObjectIndex, true);
        }
        private N.Vector2? ImagePoint(Ray ray)
        {
            if (source == null || !ValidRay(ray)) return null;
            var objectIndex = -1; N.Vector2? point = null;
            foreach (var shape in placed)
            {
                var proposal = source.Objects[shape.Index]; var nearest = float.PositiveInfinity; N.Vector2? hit = null;
                for (var i = 0; i < proposal.Triangles.Count; i += 3)
                {
                    var a = proposal.Triangles[i]; var b = proposal.Triangles[i + 1]; var c = proposal.Triangles[i + 2];
                    if (!TriangleHit(ray, shape.Boundary[a], shape.Boundary[b], shape.Boundary[c], out var t, out var u, out var v)
                        || t >= nearest) continue;
                    nearest = t; hit = proposal.Contour[a] * (1f - u - v) + proposal.Contour[b] * u + proposal.Contour[c] * v;
                }
                if (!hit.HasValue) continue;
                if (objectIndex >= 0) return null; // Overlapping captured objects remain unknown.
                objectIndex = shape.Index; point = hit;
            }
            return point;
        }
        private static bool TriangleHit(Ray ray, Vector3 a, Vector3 b, Vector3 c, out float t, out float u, out float v)
        {
            t = u = v = 0f;
            var edge1 = b - a; var edge2 = c - a; var cross = Vector3.Cross(ray.direction, edge2);
            var determinant = Vector3.Dot(edge1, cross);
            if (Mathf.Abs(determinant) < 1e-8f) return false;
            var inverse = 1f / determinant; var offset = ray.origin - a;
            u = Vector3.Dot(offset, cross) * inverse;
            if (u < -.00001f || u > 1.00001f) return false;
            var q = Vector3.Cross(offset, edge1); v = Vector3.Dot(ray.direction, q) * inverse;
            if (v < -.00001f || u + v > 1.00001f) return false;
            t = Vector3.Dot(edge2, q) * inverse;
            return t >= .05f && !float.IsNaN(t) && !float.IsInfinity(t);
        }
        private static bool ValidRay(Ray ray) => Finite(ray.origin.x) && Finite(ray.origin.y) && Finite(ray.origin.z)
            && Finite(ray.direction.x) && Finite(ray.direction.y) && Finite(ray.direction.z) && ray.direction.sqrMagnitude > 1e-8f;
        private static bool Finite(float value) => !float.IsNaN(value) && !float.IsInfinity(value);
        private static bool LabelContains(Ray ray, Chip chip)
        {
            if (!ValidRay(ray)) return false;
            var plane = new Plane(chip.transform.forward, chip.transform.position);
            if (!plane.Raycast(ray, out var distance) || distance < 0f) return false;
            var at = chip.transform.InverseTransformPoint(ray.GetPoint(distance)); var half = chip.LayoutSize * .5f;
            return Mathf.Abs(at.x) <= half.x && Mathf.Abs(at.y) <= half.y;
        }
        private static bool LabelBounds(Chip chip, HeadPose viewer, out LabelRect bounds)
        {
            var half = chip.LayoutSize * .5f;
            var corners = new[] { new Vector3(-half.x, -half.y, 0f), new Vector3(half.x, -half.y, 0f),
                new Vector3(half.x, half.y, 0f), new Vector3(-half.x, half.y, 0f) };
            return ProjectedKeepout.TryEnvelope(corners.Select(point => ToNumerics(chip.transform.TransformPoint(point))).ToArray(), viewer, out bounds);
        }
        private static Vector3 NearestBoundary(Vector3 home, Vector3[] boundary)
        {
            var nearest = boundary[0]; var distance = float.PositiveInfinity;
            for (var i = 0; i < boundary.Length; i++)
            {
                var a = boundary[i]; var edge = boundary[(i + 1) % boundary.Length] - a;
                var amount = edge.sqrMagnitude > 0f ? Mathf.Clamp01(Vector3.Dot(home - a, edge) / edge.sqrMagnitude) : 0f;
                var point = a + edge * amount; var candidate = (point - home).sqrMagnitude;
                if (candidate < distance) { distance = candidate; nearest = point; }
            }
            return nearest;
        }
        private void HideLabel(bool clearTarget)
        {
            HasPresentationFocus = false;
            if (clearTarget) CurrentTarget = null;
            label?.gameObject.SetActive(false);
            foreach (var shape in placed) shape.Overlay.SetFocus(false, false);
        }
        private void ClearObjects()
        {
            HideLabel(true); labelIndex = -1; source = null; placed.Clear();
            VisibleObjects = 0; firstTarget = null;
            foreach (var outline in outlines) outline.gameObject.SetActive(false);
        }
        private void Update() => Refresh(Time.unscaledDeltaTime, Time.unscaledTime);
        public void Refresh(float delta, float now)
        {
            if (!active || head == null) return;
            if (source != null && !CameraFrameTime.IsFresh(source.SourceTime, now))
            { ClearObjects(); status = "Waiting for a fresh view"; }
            foreach (var shape in placed) shape.Overlay.SetAmbientViewer(head.position);
            if (paused) return;
            if (processing && VisibleObjects == 0 && status != "Waiting for a fresh view") status = "Looking around";
        }
        private static N.Vector3 ToNumerics(Vector3 point) => new N.Vector3(point.x, point.y, point.z);
    }
}
