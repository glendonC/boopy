#nullable enable
using System;
using System.Numerics;

namespace Boopy.Client
{
    /// <summary>
    /// A compact peripheral HUD. It stays still inside a small dead zone and during
    /// interaction; large turns reanchor instead of sweeping across the centre of view.
    /// The caller supplies the actual current position and owns collision/layout acceptance.
    /// </summary>
    public sealed class ViewFollow
    {
        public const float StartAngleDegrees = 4f;
        public const float StopAngleDegrees = 2f;
        public const float StartDistanceMeters = 0.04f;
        public const float StopDistanceMeters = 0.02f;
        public const float SettleSeconds = 0f;
        public const float MaxAngularDegreesPerSecond = 240f;
        public const float MaxRadialMetersPerSecond = 1.2f;
        private const float DampingSeconds = 0.08f;
        public const float ReanchorAngleDegrees = 30f;
        public bool Following { get; private set; }

        /// <summary>A view-relative side target, without roll. Angles are design decisions, not platform facts.</summary>
        public static Vector3 Target(HeadPose head, float yawDegrees = 18f, float pitchDegrees = -10f,
            float distanceMeters = 1f)
        {
            var forward = Unit(head.Forward, Vector3.UnitZ);
            var right = Unit(Vector3.Cross(Vector3.UnitY, forward), Vector3.UnitX);
            var up = Unit(Vector3.Cross(forward, right), Vector3.UnitY);
            var yaw = yawDegrees * MathF.PI / 180f;
            var pitch = pitchDegrees * MathF.PI / 180f;
            var direction = forward * (MathF.Cos(yaw) * MathF.Cos(pitch))
                + right * (MathF.Sin(yaw) * MathF.Cos(pitch)) + up * MathF.Sin(pitch);
            return head.Position + Unit(direction, forward) * MathF.Max(0.3f, distanceMeters);
        }

        public void Reset()
        {
            Following = false;
        }

        public Vector3 Step(HeadPose head, Vector3 current, Vector3 target, bool frozen, float deltaSeconds)
        {
            if (frozen || !Finite(deltaSeconds) || deltaSeconds <= 0f)
            {
                if (frozen) Reset();
                return current;
            }
            var old = current - head.Position;
            var desired = target - head.Position;
            var radius = old.Length();
            var wantedRadius = desired.Length();
            if (!Finite(radius) || !Finite(wantedRadius) || wantedRadius < 0.3f) { Reset(); return current; }
            var wantedDirection = desired / wantedRadius;
            var direction = Unit(old, wantedDirection);
            var angle = MathF.Acos(Math.Clamp(Vector3.Dot(direction, wantedDirection), -1f, 1f));
            var degrees = angle * 180f / MathF.PI;
            var radialError = MathF.Abs(radius - wantedRadius);
            if (Following && degrees <= StopAngleDegrees && radialError <= StopDistanceMeters)
            {
                Reset();
                return current;
            }
            if (!Following)
            {
                if (degrees <= StartAngleDegrees && radialError <= StartDistanceMeters)
                {
                    return current;
                }
                Following = true;
            }
            var right = Unit(Vector3.Cross(Vector3.UnitY, Unit(head.Forward, Vector3.UnitZ)), Vector3.UnitX);
            var oldSide = Vector3.Dot(direction, right);
            var targetSide = Vector3.Dot(wantedDirection, right);
            // The caller has already selected a clear peripheral destination. Never animate
            // a long pursuit or an arc from the opposite side through the forward centre.
            if (degrees >= ReanchorAngleDegrees || oldSide * targetSide < 0f)
            {
                Reset();
                return target;
            }
            // A stalled capture or resume must not turn one frame into an abrupt reposition.
            var dt = MathF.Min(deltaSeconds, 0.05f);
            var fraction = 1f - MathF.Exp(-dt / DampingSeconds);
            var advance = MathF.Min(angle * fraction, MaxAngularDegreesPerSecond * dt * MathF.PI / 180f);
            if (advance > 0f)
            {
                var axis = Vector3.Cross(direction, wantedDirection);
                if (axis.LengthSquared() < 1e-8f)
                    axis = Vector3.Cross(direction, MathF.Abs(direction.Y) < 0.9f ? Vector3.UnitY : Vector3.UnitX);
                axis = Unit(axis, Vector3.UnitY);
                direction = Unit(Vector3.Transform(direction, Quaternion.CreateFromAxisAngle(axis, advance)), wantedDirection);
            }
            var change = (wantedRadius - radius) * fraction;
            change = Math.Clamp(change, -MaxRadialMetersPerSecond * dt, MaxRadialMetersPerSecond * dt);
            var nextRadius = MathF.Max(0f, radius + change);
            return head.Position + direction * nextRadius;
        }

        private static Vector3 Unit(Vector3 value, Vector3 fallback) => value.LengthSquared() > 1e-8f
            ? Vector3.Normalize(value) : fallback;
        private static bool Finite(float value) => !float.IsNaN(value) && !float.IsInfinity(value);
    }
}
