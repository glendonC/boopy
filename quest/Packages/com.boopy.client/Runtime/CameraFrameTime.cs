#nullable enable
using System;

namespace Boopy.Client
{
    /// <summary>Translate the SDK's image UTC age once; subsequent expiry uses the local monotonic clock.</summary>
    public static class CameraFrameTime
    {
        public const float MaximumAgeSeconds = 3f;

        public static bool TrySourceTime(DateTime capturedAt, DateTime utcNow, float monotonicNow, out float sourceTime)
        {
            sourceTime = 0;
            if (capturedAt.Kind != DateTimeKind.Utc || utcNow.Kind != DateTimeKind.Utc
                || capturedAt <= new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)
                || float.IsNaN(monotonicNow) || float.IsInfinity(monotonicNow)) return false;
            var age = (utcNow - capturedAt).TotalSeconds;
            // The SDK exposes realtime Unix microseconds, not an arbitrary epoch. No future-skew
            // allowance is established by that contract; an invalid clock keeps the view unknown.
            if (age < 0 || age > MaximumAgeSeconds) return false;
            sourceTime = monotonicNow - (float)age;
            return true;
        }

        public static bool IsFresh(float sourceTime, float monotonicNow) =>
            !float.IsNaN(sourceTime) && !float.IsInfinity(sourceTime)
            && !float.IsNaN(monotonicNow) && !float.IsInfinity(monotonicNow)
            && monotonicNow >= sourceTime && monotonicNow - sourceTime <= MaximumAgeSeconds;
    }
}
