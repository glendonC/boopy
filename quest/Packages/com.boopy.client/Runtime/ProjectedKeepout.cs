#nullable enable
using System;
using System.Collections.Generic;
using System.Numerics;

namespace Boopy.Client
{
    public enum FollowPlacement { Move, Hold, Hide }
    /// <summary>Conservative captured-geometry envelopes reprojected from the current viewer.</summary>
    public static class ProjectedKeepout
    {
        public static FollowPlacement Decide(bool candidateClear, bool currentClear) => candidateClear
            ? FollowPlacement.Move : currentClear ? FollowPlacement.Hold : FollowPlacement.Hide;

        public static bool TryEnvelope(IReadOnlyList<Vector3> boundary, HeadPose viewer, out LabelRect envelope)
        {
            envelope = default;
            if (boundary.Count == 0 || viewer.Forward.LengthSquared() < 1e-8f) return false;
            var forward = Vector3.Normalize(viewer.Forward);
            var right = Vector3.Cross(Vector3.UnitY, forward);
            right = right.LengthSquared() < 1e-8f ? Vector3.UnitX : Vector3.Normalize(right);
            var up = Vector3.Normalize(Vector3.Cross(forward, right));
            var local = new List<Vector3>(boundary.Count);
            foreach (var point in boundary)
            {
                var delta = point - viewer.Position;
                local.Add(new Vector3(Vector3.Dot(delta, right), Vector3.Dot(delta, up), Vector3.Dot(delta, forward)));
            }
            const float near = 0.05f;
            var projected = new List<Vector2>();
            var previous = local[local.Count - 1];
            foreach (var current in local)
            {
                // Clip boundary edges, not just vertices: an object crossing the near plane
                // must retain the full visible extent rather than disappearing from protection.
                if ((previous.Z >= near) != (current.Z >= near))
                {
                    var amount = (near - previous.Z) / (current.Z - previous.Z);
                    var intersection = Vector3.Lerp(previous, current, amount);
                    projected.Add(new Vector2(intersection.X / near, intersection.Y / near));
                }
                if (current.Z >= near) projected.Add(new Vector2(current.X / current.Z, current.Y / current.Z));
                previous = current;
            }
            if (projected.Count == 0) return false; // Entire captured boundary is behind the current viewer.
            envelope = LabelRect.Envelope(projected);
            return true;
        }

        public static bool IsClear(LabelRect footprint, IReadOnlyList<LabelRect> protectedAreas, float gap = 0.025f)
        {
            foreach (var area in protectedAreas)
                if (footprint.Intersects(area, gap)) return false;
            return true;
        }
    }
}
