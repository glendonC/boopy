#nullable enable
using System;
using System.Collections.Generic;
using System.Numerics;

namespace Boopy.Client
{
    /// <summary>
    /// Conversions between the service's image coordinates (0 to 1, origin top-left, y down) and
    /// the passthrough camera's viewport (0 to 1, origin bottom-left, y up), as MRUK's
    /// PassthroughCameraAccess defines it.
    /// </summary>
    public static class Geometry
    {
        public static Vector2 ToViewport(float x, float y) => new Vector2(x, 1f - y);

        public static Point2 FromViewport(Vector2 viewport) =>
            new Point2 { X = Clamp01(viewport.X), Y = Clamp01(1f - viewport.Y) };

        public static Vector2 Center(Box2 box) => new Vector2((box.X0 + box.X1) / 2f, (box.Y0 + box.Y1) / 2f);

        /// <summary>The corners of a box in image coordinates: top-left, top-right, bottom-right, bottom-left.</summary>
        public static Vector2[] Corners(Box2 box) => new[]
        {
            new Vector2(box.X0, box.Y0),
            new Vector2(box.X1, box.Y0),
            new Vector2(box.X1, box.Y1),
            new Vector2(box.X0, box.Y1),
        };

        /// <summary>A validated segmentation boundary, or the original approximate box.</summary>
        public static Vector2[] Outline(Grounding grounding)
        {
            return TryContour(grounding, out var result) ? result
                : grounding.Box == null ? Array.Empty<Vector2>() : Corners(grounding.Box);
        }

        /// <summary>Only actual, valid simple contours are eligible for a surface fill.</summary>
        public static bool TryContour(Grounding grounding, out Vector2[] result)
        {
            result = Array.Empty<Vector2>();
            var contour = grounding.Contour;
            if (grounding.Spatial?.Outcome == "contour" && contour != null && contour.Count >= 3 && contour.Count <= 256)
            {
                result = new Vector2[contour.Count];
                var valid = true;
                for (var i = 0; i < contour.Count; i++)
                {
                    var point = contour[i];
                    if (point == null || !Normalized(point.X) || !Normalized(point.Y)) { valid = false; break; }
                    result[i] = new Vector2(point.X, point.Y);
                }
                if (valid && SurfaceGeometry.TryTriangulate(result, out _)) return true;
            }
            result = Array.Empty<Vector2>();
            return false;
        }

        private static bool Normalized(float value) => !float.IsNaN(value) && !float.IsInfinity(value) && value >= 0f && value <= 1f;

        /// <summary>The image point an item is anchored at: its box's center, its point, or none for the scene.</summary>
        public static Vector2? Anchor(Grounding grounding)
        {
            if (grounding.Kind == "box" && grounding.Box != null) return Center(grounding.Box);
            if (grounding.Kind == "point" && grounding.Point != null) return new Vector2(grounding.Point.X, grounding.Point.Y);
            return null;
        }

        /// <summary>The centers of a depth grid's cells, row by row from the top-left, in image coordinates.</summary>
        public static IEnumerable<Vector2> CellCenters(int columns, int rows)
        {
            for (var row = 0; row < rows; row++)
            {
                for (var column = 0; column < columns; column++)
                {
                    yield return new Vector2((column + 0.5f) / columns, (row + 0.5f) / rows);
                }
            }
        }

        /// <summary>
        /// The distance along the ray through an image point, interpolated from the four nearest
        /// cell centers that had depth; null when none of them did.
        /// </summary>
        public static float? SampleDepth(DepthGrid grid, Vector2 point)
        {
            if (grid.Columns <= 0 || grid.Rows <= 0 || grid.Meters.Length != grid.Columns * grid.Rows) return null;
            var gx = Math.Clamp(point.X * grid.Columns - 0.5f, 0f, grid.Columns - 1);
            var gy = Math.Clamp(point.Y * grid.Rows - 0.5f, 0f, grid.Rows - 1);
            var x0 = (int)MathF.Floor(gx);
            var y0 = (int)MathF.Floor(gy);
            var x1 = Math.Min(x0 + 1, grid.Columns - 1);
            var y1 = Math.Min(y0 + 1, grid.Rows - 1);
            var fx = gx - x0;
            var fy = gy - y0;
            var total = 0f;
            var weight = 0f;
            void Add(int x, int y, float w)
            {
                var value = grid.Meters[y * grid.Columns + x];
                if (value == null || w <= 0f) return;
                total += value.Value * w;
                weight += w;
            }
            Add(x0, y0, (1 - fx) * (1 - fy));
            Add(x1, y0, fx * (1 - fy));
            Add(x0, y1, (1 - fx) * fy);
            Add(x1, y1, fx * fy);
            if (weight > 1e-4f) return total / weight;
            return NearestDepth(grid, (int)MathF.Round(gx), (int)MathF.Round(gy));
        }

        /// <summary>The mean of the nearest cells with depth, within one cell of the given one.</summary>
        private static float? NearestDepth(DepthGrid grid, int column, int row)
        {
            var best = float.MaxValue;
            var sum = 0f;
            var count = 0;
            for (var y = Math.Max(0, row - 1); y <= Math.Min(grid.Rows - 1, row + 1); y++)
            {
                for (var x = Math.Max(0, column - 1); x <= Math.Min(grid.Columns - 1, column + 1); x++)
                {
                    var value = grid.Meters[y * grid.Columns + x];
                    if (value == null) continue;
                    var distance = (x - column) * (x - column) + (y - row) * (y - row);
                    if (distance < best)
                    {
                        best = distance;
                        sum = 0f;
                        count = 0;
                    }
                    if (distance <= best)
                    {
                        sum += value.Value;
                        count++;
                    }
                }
            }
            return count == 0 ? (float?)null : sum / count;
        }

        private static float Clamp01(float value) => Math.Clamp(value, 0f, 1f);
    }

    /// <summary>Where chips go, so that they read at a constant size and leave the referent visible.</summary>
    public static class Layout
    {
        /// <summary>Chip text height as an angle: about 1.1 degrees, close to Meta's comfortable 18 dp.</summary>
        public const float ChipAngleDegrees = 1.1f;

        /// <summary>The scale that keeps a chip, designed 1 m away, the same apparent size at a distance.</summary>
        public static float ApparentScale(float distanceMeters) => Math.Clamp(distanceMeters, 0.3f, 4f);

        /// <summary>
        /// Positions for scene-level chips: an arc around the direction of the referent, at arm's
        /// length, slightly below the eyes, in rows of five from the middle outwards.
        /// </summary>
        public static List<Vector3> SceneArc(Vector3 eyes, Vector3 towards, int count, float radius = 0.85f)
        {
            var result = new List<Vector3>(count);
            var flat = new Vector3(towards.X, 0f, towards.Z);
            if (flat.LengthSquared() < 1e-6f) flat = new Vector3(0f, 0f, 1f);
            flat = Vector3.Normalize(flat);
            const int perRow = 5;
            const float spacingDegrees = 13f;
            for (var index = 0; index < count; index++)
            {
                var row = index / perRow;
                var slot = index % perRow;
                var inRow = Math.Min(perRow, count - row * perRow);
                var yaw = (slot - (inRow - 1) / 2f) * spacingDegrees * MathF.PI / 180f;
                var pitch = (-14f - row * 7f) * MathF.PI / 180f;
                var turned = Vector3.Transform(flat, Quaternion.CreateFromAxisAngle(Vector3.UnitY, yaw));
                var direction = Vector3.Normalize(turned * MathF.Cos(pitch) + Vector3.UnitY * MathF.Sin(pitch));
                result.Add(eyes + direction * radius);
            }
            return result;
        }
    }
}
