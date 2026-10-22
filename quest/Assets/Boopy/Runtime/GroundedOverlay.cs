#nullable enable
using Boopy.Client;
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>Proposed shape only: mask contours may fill; approximate boxes are dashed and never fill.</summary>
    public sealed class GroundedOverlay : MonoBehaviour
    {
        private LineRenderer? outline;
        private MeshRenderer? fill;
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
        private Vector3[] shape = System.Array.Empty<Vector3>();
        private Color color = new Color(.94f, .91f, .82f, 1f);

        public static GroundedOverlay Create(Transform parent, bool ambient = false)
        {
            var go = new GameObject("Proposed object shape"); go.transform.SetParent(parent, false);
            var overlay = go.AddComponent<GroundedOverlay>();
            overlay.ambient = ambient;
            if (ambient) overlay.color = new Color(.89f, .89f, .92f, 1f);
            overlay.outline = Visuals.Line(new GameObject("Observed boundary"), 0.0018f, true, Visuals.Dashed);
            overlay.outline.transform.SetParent(go.transform, false);
            var surface = new GameObject("Proposed contour tint"); surface.transform.SetParent(go.transform, false);
            overlay.mesh = new Mesh { name = "Captured contour surface" };
            surface.AddComponent<MeshFilter>().sharedMesh = overlay.mesh;
            overlay.fill = surface.AddComponent<MeshRenderer>();
            overlay.fill.sharedMaterial = Visuals.Solid;
            overlay.fill.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            overlay.fill.receiveShadows = false;
            overlay.tint = new MaterialPropertyBlock();
            return overlay;
        }

        public void Show(Grounding grounding, Vector3[] points, bool capturedDepth, bool primary)
        {
            if (outline == null || fill == null || mesh == null) return;
            var boundary = Geometry.Outline(grounding);
            var valid = Geometry.TryContour(grounding, out var mask);
            var triangulated = SurfaceGeometry.TryTriangulate(mask, out var triangles);
            var changed = traced != valid || shape.Length != points.Length;
            for (var i = 0; !changed && i < points.Length; i++)
                changed = (shape[i] - points[i]).sqrMagnitude > 1e-10f;
            if (changed) revealClock = reducedMotion ? 0.75f : 0f;
            shape = (Vector3[])points.Clone();
            traced = valid;
            outline.enabled = points.Length >= 3;
            outline.sharedMaterial = valid && capturedDepth ? Visuals.Solid : Visuals.Dashed;
            outline.textureScale = new Vector2(35f, 1f);
            this.primary = primary;
            ApplyEmphasis();
            ApplyTrace();
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
        }

        public void SetIdentityAccent(int slot)
        {
            if (ambient) return;
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

        private void ApplyEmphasis()
        {
            if (outline == null) return;
            Visuals.Tint(outline, new Color(color.r, color.g, color.b, ambient ? (focused ? .68f : .28f) : ObjectAccents.OutlineOpacity(focused, anyFocused, primary)));
            outline.widthMultiplier = ambient ? ambientDistance * (focused ? .0026f : .0018f) : focused ? .0024f : .0018f;
        }

        public void SetReducedMotion(bool on)
        {
            reducedMotion = on;
            if (on) revealClock = 0.75f;
            ApplyTrace(); ApplyTint();
        }

        private void LateUpdate() => RefreshVisuals(Time.unscaledDeltaTime);

        /// <summary>Explicit elapsed time also makes synthetic editor previews deterministic.</summary>
        public void RefreshVisuals(float elapsed)
        {
            if (float.IsNaN(elapsed) || float.IsInfinity(elapsed) || elapsed < 0f) return;
            if (!ambient && !reducedMotion && elapsed > 0f) clock += elapsed;
            if (!ambient && !reducedMotion && revealClock < 0.75f && elapsed > 0f) { revealClock += elapsed; ApplyTrace(); }
            ApplyTint();
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
