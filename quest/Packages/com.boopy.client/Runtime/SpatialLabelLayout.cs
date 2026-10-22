#nullable enable
using System;
using System.Collections.Generic;
using System.Numerics;

namespace Boopy.Client
{
    /// <summary>A conservative envelope in view-relative tangent-plane coordinates (x/z, y/z).</summary>
    public readonly struct LabelRect
    {
        public LabelRect(float minX, float minY, float maxX, float maxY)
        {
            if (!Finite(minX) || !Finite(minY) || !Finite(maxX) || !Finite(maxY)
                || maxX < minX || maxY < minY)
                throw new ArgumentException("A label rectangle needs finite, ordered edges.");
            MinX = minX;
            MinY = minY;
            MaxX = maxX;
            MaxY = maxY;
        }

        public float MinX { get; }
        public float MinY { get; }
        public float MaxX { get; }
        public float MaxY { get; }
        public Vector2 Center => new Vector2((MinX + MaxX) * 0.5f, (MinY + MaxY) * 0.5f);
        public Vector2 Size => new Vector2(MaxX - MinX, MaxY - MinY);

        public static LabelRect Around(Vector2 center, Vector2 size) =>
            new LabelRect(center.X - size.X * 0.5f, center.Y - size.Y * 0.5f,
                center.X + size.X * 0.5f, center.Y + size.Y * 0.5f);

        /// <summary>Protect every projected corner, including the extent of a slanted object.</summary>
        public static LabelRect Envelope(IReadOnlyList<Vector2> points)
        {
            if (points.Count == 0) throw new ArgumentException("An envelope needs projected corners.", nameof(points));
            var minX = points[0].X;
            var maxX = minX;
            var minY = points[0].Y;
            var maxY = minY;
            foreach (var point in points)
            {
                minX = MathF.Min(minX, point.X);
                maxX = MathF.Max(maxX, point.X);
                minY = MathF.Min(minY, point.Y);
                maxY = MathF.Max(maxY, point.Y);
            }
            return new LabelRect(minX, minY, maxX, maxY);
        }

        public bool Contains(LabelRect other) => other.MinX >= MinX && other.MaxX <= MaxX
            && other.MinY >= MinY && other.MaxY <= MaxY;

        /// <summary>Touching edges are allowed; a positive gap reserves breathing room.</summary>
        public bool Intersects(LabelRect other, float gap = 0f) =>
            MinX < other.MaxX + gap && MaxX > other.MinX - gap
            && MinY < other.MaxY + gap && MaxY > other.MinY - gap;

        private static bool Finite(float value) => !float.IsNaN(value) && !float.IsInfinity(value);
    }

    /// <summary>
    /// Initial label placement beside protected object envelopes. The caller keeps placements in
    /// occupied across corrections, using actual measured caption/detail bounds. This helper does
    /// not shrink labels or cover an object when space runs out: false means hide/page the overflow.
    /// </summary>
    public static class SpatialLabelLayout
    {
        /// <summary>
        /// Reserve a caller-measured view-center keepout along with object and label bounds.
        /// False withholds the entire measured group; neither labels nor targets are shrunk.
        /// The keepout size is supplied by the presentation, not a claimed device comfort threshold.
        /// </summary>
        public static bool TryPlace(Vector2 preferredCenter, Vector2 size,
            IReadOnlyList<LabelRect> protectedAreas, IReadOnlyList<LabelRect> occupied,
            LabelRect bounds, LabelRect centerKeepout, out LabelRect placement, float gap = 0.02f)
        {
            placement = default;
            if (centerKeepout.Size.X <= 0f || centerKeepout.Size.Y <= 0f
                || centerKeepout.MinX > 0f || centerKeepout.MaxX < 0f
                || centerKeepout.MinY > 0f || centerKeepout.MaxY < 0f) return false;
            var protectedWithCenter = new List<LabelRect>(protectedAreas.Count + 1);
            protectedWithCenter.AddRange(protectedAreas);
            protectedWithCenter.Add(centerKeepout);
            return TryPlace(preferredCenter, size, protectedWithCenter, occupied, bounds, out placement, gap);
        }

        public static bool TryPlace(Vector2 preferredCenter, Vector2 size,
            IReadOnlyList<LabelRect> protectedAreas, IReadOnlyList<LabelRect> occupied,
            LabelRect bounds, out LabelRect placement, float gap = 0.02f)
        {
            placement = default;
            if (!Finite(preferredCenter.X) || !Finite(preferredCenter.Y)
                || !Finite(size.X) || !Finite(size.Y) || size.X <= 0f || size.Y <= 0f
                || !Finite(gap) || gap < 0f || size.X > bounds.Size.X || size.Y > bounds.Size.Y)
                return false;

            var half = size * 0.5f;
            var left = bounds.MinX + half.X;
            var right = bounds.MaxX - half.X;
            var bottom = bounds.MinY + half.Y;
            var top = bounds.MaxY - half.Y;
            var xs = new List<float> { Math.Clamp(preferredCenter.X, left, right), left, right };
            var ys = new List<float> { Math.Clamp(preferredCenter.Y, bottom, top), bottom, top };
            // Feasible rectangle centers are separated from each obstacle by one of its four
            // edges. Include their intersections too, so a crowded corner is still considered.
            void AddEdges(IReadOnlyList<LabelRect> areas)
            {
                foreach (var area in areas)
                {
                    // A tiny extra margin avoids floating-point reconstruction crossing an edge.
                    const float roundingMargin = 0.00001f;
                    xs.Add(Math.Clamp(area.MinX - gap - half.X - roundingMargin, left, right));
                    xs.Add(Math.Clamp(area.MaxX + gap + half.X + roundingMargin, left, right));
                    ys.Add(Math.Clamp(area.MinY - gap - half.Y - roundingMargin, bottom, top));
                    ys.Add(Math.Clamp(area.MaxY + gap + half.Y + roundingMargin, bottom, top));
                }
            }
            AddEdges(protectedAreas);
            AddEdges(occupied);
            // Stable ties prefer the upper side, then the left. Obstacle input order cannot
            // alter a placement; retaining occupied placements prevents correction-driven drift.
            xs.Sort();
            ys.Sort((a, b) => b.CompareTo(a));
            var best = float.PositiveInfinity;
            var found = false;
            foreach (var y in ys)
            {
                foreach (var x in xs)
                {
                    var candidate = LabelRect.Around(new Vector2(x, y), size);
                    if (!bounds.Contains(candidate) || Collides(candidate, protectedAreas, gap)
                        || Collides(candidate, occupied, gap)) continue;
                    var score = Vector2.DistanceSquared(candidate.Center, preferredCenter);
                    if (score >= best) continue;
                    found = true;
                    best = score;
                    placement = candidate;
                }
            }
            return found;
        }

        private static bool Collides(LabelRect candidate, IReadOnlyList<LabelRect> areas, float gap)
        {
            foreach (var area in areas)
                if (candidate.Intersects(area, gap)) return true;
            return false;
        }

        private static bool Finite(float value) => !float.IsNaN(value) && !float.IsInfinity(value);
    }
}
