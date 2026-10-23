#nullable enable
using System.Collections.Generic;
using Boopy.Client;
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>
    /// Proposed shape only. The attended subject has a soft solid Ember edge with no dashes or corners and a brighter
    /// inner rim; a mask also has a low fill, while a box with no mask stays approximate: a rounded loop just outside
    /// it on its plane, with no fill. One sweep of light crosses the subject from Boopy's side when it first appears
    /// and when Boopy starts working on it. Other overlays keep their quiet look: mask contours may fill; approximate
    /// boxes are dashed and never fill.
    /// </summary>
    public sealed class GroundedOverlay : MonoBehaviour
    {
        private const float SweepSeconds = .6f;
        private LineRenderer? outline, rim, band;
        private MeshRenderer? fill;
        private bool attended;
        private float sweepClock = float.PositiveInfinity;
        private Vector3 sweepFrom;
        private Mesh? mesh;
        private MaterialPropertyBlock? tint;
        private bool filling;
        private bool ambient;
        private float clock;
        private float revealClock;
        private bool traced;
        private bool reducedMotion;
        private bool primary;
        private bool focused;
        private bool anyFocused;
        private float ambientDistance = 1f;
        private float viewerDistance = 1f;
        private Vector3[] shape = System.Array.Empty<Vector3>();
        private Vector3[] placed = System.Array.Empty<Vector3>();
        private Vector3[] extent = System.Array.Empty<Vector3>();
        private Vector3[] rimPoints = System.Array.Empty<Vector3>();

        /// <summary>The placed boundary this overlay draws, in world space.</summary>
        public IReadOnlyList<Vector3> Boundary => shape;

        /// <summary>How far the running sweep has crossed the subject, 0 to 1; null when no sweep runs.</summary>
        public float? SweepProgress => sweepClock < SweepSeconds ? Mathf.Clamp01(sweepClock / SweepSeconds) : (float?)null;
        private Color color = new Color(.94f, .91f, .82f, 1f);

        public static GroundedOverlay Create(Transform parent, bool ambient = false, bool attended = false)
        {
            var go = new GameObject("Proposed object shape"); go.transform.SetParent(parent, false);
            var overlay = go.AddComponent<GroundedOverlay>();
            overlay.ambient = ambient;
            overlay.attended = attended && !ambient;
            if (ambient) overlay.color = new Color(.89f, .89f, .92f, 1f);
            if (overlay.attended) overlay.color = SpatialTheme.Ember;
            overlay.outline = Visuals.Line(new GameObject("Observed boundary"), 0.0018f, true, overlay.attended ? Visuals.SoftEdge : Visuals.Dashed);
            overlay.outline.transform.SetParent(go.transform, false);
            var surface = new GameObject("Proposed contour tint"); surface.transform.SetParent(go.transform, false);
            overlay.mesh = new Mesh { name = "Captured contour surface" };
            surface.AddComponent<MeshFilter>().sharedMesh = overlay.mesh;
            overlay.fill = surface.AddComponent<MeshRenderer>();
            overlay.fill.sharedMaterial = Visuals.Solid;
            overlay.fill.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            overlay.fill.receiveShadows = false;
            overlay.tint = new MaterialPropertyBlock();
            if (overlay.attended)
            {
                overlay.rim = Visuals.Line(new GameObject("Inner rim"), 0.001f, true, Visuals.SoftEdge);
                overlay.rim.transform.SetParent(go.transform, false);
                overlay.band = Visuals.Line(new GameObject("Scan band"), 0.012f, false, Visuals.SoftEdge);
                overlay.band.transform.SetParent(go.transform, false);
                overlay.band.positionCount = 2;
                overlay.band.enabled = false;
            }
            return overlay;
        }

        /// <summary>Draws the placed boundary; true when its shape changed, which is when an outline first appears.
        /// <paramref name="viewer"/> sets a box's margin, a fixed angle from where the person stands.</summary>
        public bool Show(Grounding grounding, Vector3[] points, bool capturedDepth, bool primary, Vector3? viewer = null)
        {
            if (outline == null || fill == null || mesh == null) return false;
            var boundary = Geometry.Outline(grounding);
            var valid = Geometry.TryContour(grounding, out var mask);
            var triangulated = SurfaceGeometry.TryTriangulate(mask, out var triangles);
            // The attended subject's box with no mask is drawn as a rounded loop around it on its plane: no corners.
            var box = attended && !valid && grounding.Box != null && points.Length == 4;
            var drawn = box ? RoundedBox(points, BoxMargin * (viewer != null ? Vector3.Distance(viewer.Value, Centroid(points)) : 1f)) : points;
            // Changed means the placed subject moved, not that a box's margin followed the eyes.
            var changed = traced != valid || placed.Length != points.Length;
            for (var i = 0; !changed && i < points.Length; i++)
                changed = (placed[i] - points[i]).sqrMagnitude > 1e-10f;
            if (changed) revealClock = reducedMotion ? 0.75f : 0f;
            placed = (Vector3[])points.Clone();
            shape = (Vector3[])drawn.Clone();
            traced = valid;
            outline.enabled = drawn.Length >= 3;
            outline.sharedMaterial = attended ? Visuals.SoftEdge : valid && capturedDepth ? Visuals.Solid : Visuals.Dashed;
            outline.textureScale = attended ? Vector2.one : new Vector2(35f, 1f);
            this.primary = primary;
            ApplyEmphasis();
            ApplyTrace();
            ApplyRim();
            // The subject itself, which the sweep crosses: a box's own four corners, not the margin out to its edge.
            extent = box ? (Vector3[])points.Clone() : shape;
            // Only a mask fills; a box with no mask stays approximate, an edge with no fill.
            filling = !ambient && valid && capturedDepth && points.Length == boundary.Length && triangulated;
            fill.enabled = filling;
            mesh.Clear();
            if (filling)
            {
                var vertices = new Vector3[points.Length];
                for (var i = 0; i < points.Length; i++) vertices[i] = transform.InverseTransformPoint(points[i]);
                mesh.vertices = vertices;
                mesh.triangles = triangles;
                mesh.RecalculateBounds();
            }
            ApplyTint();
            return changed;
        }

        /// <summary>
        /// One finite sweep of light across the attended subject, starting on the side nearest <paramref name="from"/>
        /// (where Boopy is). Reduced motion plays none.
        /// </summary>
        public void Sweep(Vector3 from)
        {
            if (!attended || reducedMotion || extent.Length < 3 || band == null) return;
            sweepFrom = from;
            sweepClock = 0f;
            ApplySweep();
        }

        public void SetIdentityAccent(int slot)
        {
            if (ambient || attended) return;
            var accent = ObjectAccents.Color(slot);
            color = new Color(accent.X, accent.Y, accent.Z, 1f);
            ApplyEmphasis(); ApplyTint();
        }

        public void SetFocus(bool on, bool hasFocus)
        {
            if (focused == on && anyFocused == hasFocus) return;
            focused = on; anyFocused = hasFocus;
            ApplyEmphasis(); ApplyTint();
        }

        /// <summary>Keep captured ambient lines thin but visible at distance with AA disabled.
        /// This changes apparent width only; source vertices, tint and time remain untouched.</summary>
        public void SetAmbientViewer(Vector3 eyes)
        {
            if (!ambient || shape.Length == 0) return;
            var distance = .05f;
            foreach (var point in shape) distance = Mathf.Max(distance, Vector3.Distance(point, eyes));
            if (Mathf.Approximately(distance, ambientDistance)) return;
            ambientDistance = distance; ApplyEmphasis();
        }

        /// <summary>A subject's outline keeps its base width in angle beyond 1 m, for the same reason: with AA
        /// disabled a thinner line draws nothing where it falls between pixel centers. Within 1 m it is unchanged.</summary>
        public void SetViewer(Vector3 eyes)
        {
            if (ambient || shape.Length == 0) return;
            var distance = 1f;
            foreach (var point in shape) distance = Mathf.Max(distance, Vector3.Distance(point, eyes));
            if (Mathf.Approximately(distance, viewerDistance)) return;
            viewerDistance = distance; ApplyEmphasis();
        }

        private void ApplyEmphasis()
        {
            if (outline == null) return;
            Visuals.Tint(outline, new Color(color.r, color.g, color.b, ambient ? (focused ? .68f : .28f) : ObjectAccents.OutlineOpacity(focused, anyFocused, primary)));
            // A soft edge fades toward its sides, so the attended subject's line is wider than the base 1.8 mrad.
            outline.widthMultiplier = ambient ? ambientDistance * (focused ? .0026f : .0018f)
                : viewerDistance * (attended ? (focused ? .0034f : .0028f) : focused ? .0024f : .0018f);
            ApplyRim();
        }

        public void SetReducedMotion(bool on)
        {
            reducedMotion = on;
            if (on) { revealClock = 0.75f; sweepClock = float.PositiveInfinity; ApplySweep(); }
            ApplyTrace(); ApplyTint();
        }

        private void LateUpdate() => RefreshVisuals(Time.unscaledDeltaTime);

        /// <summary>Explicit elapsed time also makes synthetic editor previews deterministic.</summary>
        public void RefreshVisuals(float elapsed)
        {
            if (float.IsNaN(elapsed) || float.IsInfinity(elapsed) || elapsed < 0f) return;
            if (!ambient && !reducedMotion && elapsed > 0f) clock += elapsed;
            if (!ambient && !reducedMotion && revealClock < 0.75f && elapsed > 0f) { revealClock += elapsed; ApplyTrace(); }
            if (attended && sweepClock < SweepSeconds && elapsed > 0f) { sweepClock += elapsed; ApplySweep(); }
            ApplyTint();
        }

        // A brighter, thinner line against the inside of the edge, on the subject's own plane, so the two read as one edge.
        private void ApplyRim()
        {
            if (rim == null || outline == null) return;
            rim.enabled = outline.enabled && shape.Length >= 3;
            if (!rim.enabled) return;
            rim.widthMultiplier = outline.widthMultiplier * .55f;
            var center = Centroid(shape);
            var inset = (outline.widthMultiplier + rim.widthMultiplier) / 2f;
            // One buffer, reused: this runs whenever the eyes move.
            if (rimPoints.Length != shape.Length) rimPoints = new Vector3[shape.Length];
            for (var i = 0; i < shape.Length; i++)
            {
                var inward = center - shape[i];
                rimPoints[i] = shape[i] + inward.normalized * Mathf.Min(inset, inward.magnitude * .3f);
            }
            rim.positionCount = rimPoints.Length;
            rim.SetPositions(rimPoints);
            var bright = Color.Lerp(color, Color.white, .45f);
            Visuals.Tint(rim, new Color(bright.r, bright.g, bright.b, .85f));
        }

        // The sweep is a band of light across the subject itself (a box, not its margin), perpendicular to the way it
        // travels: from the side nearest Boopy to the far side, eased, then gone.
        private void ApplySweep()
        {
            if (band == null) return;
            var progress = SweepProgress;
            var shape = extent;
            band.enabled = progress != null && shape.Length >= 3;
            if (!band.enabled) return;
            // Toward the middle of the subject's extent, not the average of its points, which a mask's rounded top crowds.
            var center = Middle(shape);
            var normal = Normal(shape);
            var travel = Vector3.ProjectOnPlane(center - sweepFrom, normal);
            if (travel.sqrMagnitude < 1e-8f) travel = Vector3.ProjectOnPlane(shape[1] - shape[0], normal);
            travel.Normalize();
            var across = Vector3.Cross(normal, travel).normalized;
            float near = float.PositiveInfinity, far = float.NegativeInfinity;
            foreach (var point in shape) { var along = Vector3.Dot(point - center, travel); near = Mathf.Min(near, along); far = Mathf.Max(far, along); }
            var eased = progress!.Value * progress.Value * (3f - 2f * progress.Value);
            var at = Mathf.Lerp(near, far, eased);
            float low = float.PositiveInfinity, high = float.NegativeInfinity;
            Vector3 lowPoint = default, highPoint = default;
            for (var i = 0; i < shape.Length; i++)
            {
                var a = shape[i]; var b = shape[(i + 1) % shape.Length];
                var da = Vector3.Dot(a - center, travel) - at; var db = Vector3.Dot(b - center, travel) - at;
                if (da * db > 0f || Mathf.Approximately(da, db)) continue;
                var crossing = a + (b - a) * (da / (da - db));
                var side = Vector3.Dot(crossing - center, across);
                if (side < low) { low = side; lowPoint = crossing; }
                if (side > high) { high = side; highPoint = crossing; }
            }
            band.enabled = high > low;
            if (!band.enabled) return;
            band.SetPosition(0, lowPoint);
            band.SetPosition(1, highPoint);
            var bright = Color.Lerp(color, Color.white, .6f);
            Visuals.Tint(band, new Color(bright.r, bright.g, bright.b, .85f * (1f - .4f * Mathf.Abs(2f * progress.Value - 1f))));
            band.widthMultiplier = .012f * viewerDistance;
        }

        private static Vector3 Centroid(Vector3[] points)
        {
            var sum = Vector3.zero;
            foreach (var point in points) sum += point;
            return points.Length == 0 ? sum : sum / points.Length;
        }

        private static Vector3 Middle(Vector3[] points)
        {
            var bounds = new Bounds(points[0], Vector3.zero);
            foreach (var point in points) bounds.Encapsulate(point);
            return bounds.center;
        }

        // Newell's method: the plane's normal for a closed, possibly not quite planar, loop.
        private static Vector3 Normal(Vector3[] points)
        {
            var normal = Vector3.zero;
            for (var i = 0; i < points.Length; i++)
            {
                var a = points[i]; var b = points[(i + 1) % points.Length];
                normal += new Vector3((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y));
            }
            return normal.sqrMagnitude > 1e-12f ? normal.normalized : Vector3.forward;
        }

        // About 7 mrad from where the person stands: a box's edge sits just outside it, never a card around it.
        private const float BoxMargin = .007f;

        // The four placed corners (rays through a box's corners meet a tilted plane as a slight trapezoid) as one
        // loop that follows them: each side moved outward by the margin, each corner an arc of three times it. The
        // margin is a third of the radius, more than the .29 an arc needs to clear a corner, so every corner of the
        // box stays inside and the loop sits close to it.
        private static Vector3[] RoundedBox(Vector3[] corners, float margin)
        {
            var u = corners[1] - corners[0];
            if (u.sqrMagnitude < 1e-8f) return corners;
            u.Normalize();
            var v = Vector3.ProjectOnPlane(corners[3] - corners[0], u);
            if (v.sqrMagnitude < 1e-8f) return corners;
            v.Normalize();
            var flat = new Vector2[corners.Length];
            for (var i = 0; i < corners.Length; i++) flat[i] = new Vector2(Vector3.Dot(corners[i] - corners[0], u), Vector3.Dot(corners[i] - corners[0], v));
            var area = 0f; float left = 0f, right = 0f, top = 0f, bottom = 0f;
            for (var i = 0; i < flat.Length; i++)
            {
                var a = flat[i]; var b = flat[(i + 1) % flat.Length];
                area += a.x * b.y - b.x * a.y;
                left = Mathf.Min(left, a.x); right = Mathf.Max(right, a.x); top = Mathf.Min(top, a.y); bottom = Mathf.Max(bottom, a.y);
            }
            if (Mathf.Abs(area) < 1e-8f || right - left < 1e-4f || bottom - top < 1e-4f) return corners;
            // A small box keeps its arcs apart: the radius never passes a quarter of its shorter side.
            var radius = Mathf.Min(3f * margin, Mathf.Min(right - left, bottom - top) * .25f);
            var inset = radius - radius / 3f;
            // Outward normal of the side from corner i to corner i + 1, whichever way the loop turns.
            var outward = new Vector2[flat.Length];
            for (var i = 0; i < flat.Length; i++)
            {
                var side = flat[(i + 1) % flat.Length] - flat[i];
                outward[i] = new Vector2(side.y, -side.x).normalized * Mathf.Sign(area);
            }
            const int steps = 6;
            var points = new List<Vector3>();
            for (var i = 0; i < flat.Length; i++)
            {
                var before = outward[(i + flat.Length - 1) % flat.Length]; var after = outward[i];
                var center = flat[i] - inset * (before + after) / (1f + Vector2.Dot(before, after));
                var start = Mathf.Atan2(before.y, before.x);
                var turn = Mathf.DeltaAngle(start * Mathf.Rad2Deg, Mathf.Atan2(after.y, after.x) * Mathf.Rad2Deg) * Mathf.Deg2Rad;
                for (var step = 0; step <= steps; step++)
                {
                    var angle = start + turn * step / steps;
                    var at = center + new Vector2(Mathf.Cos(angle), Mathf.Sin(angle)) * radius;
                    points.Add(corners[0] + u * at.x + v * at.y);
                }
            }
            return points.ToArray();
        }

        private void ApplyTrace()
        {
            if (outline == null) return;
            outline.loop = ambient || !traced;
            if (ambient || !traced) { outline.positionCount = shape.Length; outline.SetPositions(shape); return; }
            var points = new System.Numerics.Vector3[shape.Length];
            for (var i = 0; i < shape.Length; i++) points[i] = new System.Numerics.Vector3(shape[i].x, shape[i].y, shape[i].z);
            var trace = SurfaceGeometry.TraceBoundary(points, revealClock / 0.45f);
            outline.positionCount = trace.Length;
            for (var i = 0; i < trace.Length; i++) outline.SetPosition(i, new Vector3(trace[i].X, trace[i].Y, trace[i].Z));
        }
        private void ApplyTint()
        {
            if (!filling || fill == null || tint == null) return;
            // A restrained breathing tint on the actual contour, not a fabricated scanning mask.
            var alpha = (reducedMotion ? 0.055f : 0.055f + 0.015f * Mathf.Sin(clock * 1.5f))
                * SurfaceGeometry.FillReveal(revealClock) * ObjectAccents.FillMultiplier(focused, anyFocused);
            tint.SetColor("_Color", new Color(color.r, color.g, color.b, alpha)); fill.SetPropertyBlock(tint);
        }
        private void OnDestroy()
        {
            if (mesh == null) return;
            if (Application.isPlaying) Destroy(mesh); else DestroyImmediate(mesh);
        }
    }
}
