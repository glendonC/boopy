#nullable enable
using System;
using System.Collections.Generic;
using System.Numerics;

namespace Boopy.Client
{
    public readonly struct CapturedPlane
    {
        public CapturedPlane(Vector3 normal, float offset) { Normal = normal; Offset = offset; }
        public Vector3 Normal { get; }
        public float Offset { get; }
        public bool Intersect(Vector3 origin, Vector3 direction, out Vector3 point)
        {
            point = default;
            var divisor = Vector3.Dot(Normal, direction);
            if (MathF.Abs(divisor) < 0.02f) return false;
            var distance = (Offset - Vector3.Dot(Normal, origin)) / divisor;
            if (!float.IsFinite(distance) || distance < 0.05f || distance > 6f) return false;
            point = origin + direction * distance;
            return true;
        }
    }

    /// <summary>Bounded geometry from captured evidence; no semantic plane or hidden-edge guesses.</summary>
    public static class SurfaceGeometry
    {
        /// <summary>Reveal only the returned boundary, by arc length, including its closing edge.</summary>
        public static Vector3[] TraceBoundary(IReadOnlyList<Vector3> points, float progress)
        {
            if (points.Count < 3 || !float.IsFinite(progress)) return Array.Empty<Vector3>();
            progress = Math.Clamp(progress, 0f, 1f);
            var perimeter = 0f;
            for (var i = 0; i < points.Count; i++) perimeter += Vector3.Distance(points[i], points[(i + 1) % points.Count]);
            if (!float.IsFinite(perimeter) || perimeter <= 1e-6f) return Array.Empty<Vector3>();
            var output = new List<Vector3> { points[0] };
            var remaining = perimeter * progress;
            for (var i = 0; i < points.Count; i++)
            {
                var end = points[(i + 1) % points.Count];
                var length = Vector3.Distance(points[i], end);
                if (remaining < length)
                {
                    output.Add(Vector3.Lerp(points[i], end, length > 0f ? remaining / length : 0f));
                    break;
                }
                output.Add(end); remaining -= length;
            }
            return output.ToArray();
        }

        public static float FillReveal(float elapsed) => float.IsFinite(elapsed)
            ? Math.Clamp((elapsed - 0.45f) / 0.3f, 0f, 1f) : 0f;

        public static bool CameraRay(Vector2 image, int width, int height, CameraInfo camera, out Vector3 direction)
        {
            direction = default;
            if (width <= 0 || height <= 0 || camera.FocalLength.Length != 2 || camera.PrincipalPoint.Length != 2
                || camera.SensorResolution.Length != 2 || camera.SensorResolution[0] <= 0 || camera.SensorResolution[1] <= 0
                || !float.IsFinite(camera.FocalLength[0]) || !float.IsFinite(camera.FocalLength[1])
                || camera.FocalLength[0] <= 0f || camera.FocalLength[1] <= 0f) return false;
            var sensorX = camera.SensorResolution[0]; var sensorY = camera.SensorResolution[1];
            var scaleX = (float)width / sensorX; var scaleY = (float)height / sensorY;
            var scale = MathF.Max(scaleX, scaleY); scaleX /= scale; scaleY /= scale;
            var x = (sensorX * ((1f - scaleX) * 0.5f + scaleX * image.X) - camera.PrincipalPoint[0]) / camera.FocalLength[0];
            var y = (sensorY * ((1f - scaleY) * 0.5f + scaleY * (1f - image.Y)) - camera.PrincipalPoint[1]) / camera.FocalLength[1];
            if (!float.IsFinite(x) || !float.IsFinite(y)) return false;
            direction = Vector3.Normalize(new Vector3(x, y, 1f));
            return true;
        }

        public static bool Contains(IReadOnlyList<Vector2> contour, Vector2 point)
        {
            var inside = false;
            for (var i = 0; i < contour.Count; i++)
            {
                var a = contour[i]; var b = contour[(i + 1) % contour.Count];
                if ((a.Y > point.Y) != (b.Y > point.Y)
                    && point.X < (b.X - a.X) * (point.Y - a.Y) / (b.Y - a.Y) + a.X) inside = !inside;
            }
            return inside;
        }

        public static bool TryTriangulate(IReadOnlyList<Vector2> contour, out int[] triangles)
        {
            triangles = Array.Empty<int>();
            if (contour.Count < 3 || contour.Count > 256) return false;
            var area = 0f;
            for (var i = 0; i < contour.Count; i++)
            {
                var a = contour[i]; var b = contour[(i + 1) % contour.Count];
                if (!float.IsFinite(a.X) || !float.IsFinite(a.Y) || a.X < 0f || a.X > 1f || a.Y < 0f || a.Y > 1f
                    || Vector2.DistanceSquared(a, b) < 1e-12f) return false;
                area += a.X * b.Y - a.Y * b.X;
                for (var j = i + 2; j < contour.Count; j++)
                {
                    if (i == 0 && j == contour.Count - 1) continue;
                    if (Crosses(a, b, contour[j], contour[(j + 1) % contour.Count])) return false;
                }
            }
            if (MathF.Abs(area) < 1e-6f) return false;
            var winding = MathF.Sign(area);
            var remaining = new List<int>(); for (var i = 0; i < contour.Count; i++) remaining.Add(i);
            var output = new List<int>();
            while (remaining.Count > 3)
            {
                var found = false;
                for (var i = 0; i < remaining.Count; i++)
                {
                    var a = remaining[(i + remaining.Count - 1) % remaining.Count];
                    var b = remaining[i]; var c = remaining[(i + 1) % remaining.Count];
                    var cross = Turn(contour[a], contour[b], contour[c]) * winding;
                    if (MathF.Abs(cross) < 1e-8f) { remaining.RemoveAt(i); found = true; break; }
                    if (cross < 0f) continue;
                    var occupied = false;
                    foreach (var point in remaining)
                    {
                        if (point == a || point == b || point == c) continue;
                        if (Turn(contour[a], contour[b], contour[point]) * winding >= -1e-8f
                            && Turn(contour[b], contour[c], contour[point]) * winding >= -1e-8f
                            && Turn(contour[c], contour[a], contour[point]) * winding >= -1e-8f) { occupied = true; break; }
                    }
                    if (occupied) continue;
                    output.Add(a); output.Add(b); output.Add(c); remaining.RemoveAt(i); found = true; break;
                }
                if (!found || remaining.Count < 3) return false;
            }
            output.AddRange(remaining); triangles = output.ToArray(); return true;
        }

        public static bool TryFitPlane(IReadOnlyList<Vector3> supplied, out CapturedPlane plane)
        {
            plane = default;
            if (supplied.Count < 8) return false;
            var samples = new List<Vector3>();
            var count = Math.Min(32, supplied.Count);
            for (var i = 0; i < count; i++) samples.Add(supplied[i * (supplied.Count - 1) / (count - 1)]);
            var required = (int)MathF.Ceiling(samples.Count * 0.9f);
            var bestSupport = 0; var bestError = float.PositiveInfinity;
            for (var a = 0; a < samples.Count - 2; a++)
            for (var b = a + 1; b < samples.Count - 1; b++)
            for (var c = b + 1; c < samples.Count; c++)
            {
                var normal = Vector3.Cross(samples[b] - samples[a], samples[c] - samples[a]);
                if (normal.LengthSquared() < 0.00000625f) continue; // Distributed support, not a tiny/collinear patch.
                normal = Vector3.Normalize(normal); var offset = Vector3.Dot(normal, samples[a]);
                var support = 0; var error = 0f;
                foreach (var sample in samples)
                {
                    var residual = MathF.Abs(Vector3.Dot(normal, sample) - offset);
                    if (!float.IsFinite(residual) || residual > 0.015f) continue;
                    support++; error += residual * residual;
                }
                if (support < required || MathF.Sqrt(error / support) > 0.005f) continue;
                if (support < bestSupport || (support == bestSupport && error >= bestError)) continue;
                bestSupport = support; bestError = error; plane = new CapturedPlane(normal, offset);
            }
            return bestSupport >= required;
        }

        private static float Turn(Vector2 a, Vector2 b, Vector2 c) => (b.X - a.X) * (c.Y - a.Y) - (b.Y - a.Y) * (c.X - a.X);
        private static bool Crosses(Vector2 a, Vector2 b, Vector2 c, Vector2 d)
        {
            var x = Turn(a, b, c); var y = Turn(a, b, d); var u = Turn(c, d, a); var v = Turn(c, d, b);
            bool On(Vector2 p, Vector2 q, Vector2 r) => r.X >= MathF.Min(p.X, q.X) - 1e-8f && r.X <= MathF.Max(p.X, q.X) + 1e-8f
                && r.Y >= MathF.Min(p.Y, q.Y) - 1e-8f && r.Y <= MathF.Max(p.Y, q.Y) + 1e-8f;
            return (x * y < 0f && u * v < 0f) || (MathF.Abs(x) < 1e-8f && On(a, b, c))
                || (MathF.Abs(y) < 1e-8f && On(a, b, d)) || (MathF.Abs(u) < 1e-8f && On(c, d, a))
                || (MathF.Abs(v) < 1e-8f && On(c, d, b));
        }
    }
}
