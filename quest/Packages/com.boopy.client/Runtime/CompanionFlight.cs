#nullable enable
using System;
using System.Numerics;

namespace Boopy.Client
{
    /// <summary>Interruptible character-only travel inside a dedicated peripheral flight zone.</summary>
    public sealed class CompanionFlight
    {
        private Vector3 start, target;
        private float elapsed = 1f;
        public Vector3 Position { get; private set; }
        public float Pitch { get; private set; }
        public float Bank { get; private set; }

        public static Vector3 HomeFor(string state) => state switch
        {
            "listening" => new Vector3(0f, .035f, -.010f),
            "processing" => new Vector3(0f, -.025f, -.006f),
            "review" => new Vector3(0f, .015f, 0f),
            _ => Vector3.Zero,
        };

        public void MoveTo(Vector3 destination)
        {
            destination = new Vector3(Clamp(Finite(destination.X), -.008f, .008f),
                Clamp(Finite(destination.Y), -.025f, .035f), Clamp(Finite(destination.Z), -.012f, 0f));
            // Tracking jitter within two millimetres must not restart the anticipation on every frame.
            if (Vector3.DistanceSquared(target, destination) < .000004f) return;
            start = Position;
            target = destination;
            elapsed = 0f;
        }

        public Vector3 Tick(float delta, bool frozen, bool reduced, bool visible)
        {
            if (reduced || !visible)
            {
                Position = start = target = Vector3.Zero;
                Pitch = Bank = 0f;
                elapsed = 1f;
                return Position;
            }
            if (frozen) return Position;
            elapsed += Clamp(Finite(delta), 0f, .1f);
            if (elapsed >= .9f)
            {
                Position = target;
                Pitch = Bank = 0f;
                return Position;
            }
            var direction = target - start;
            if (direction.LengthSquared() > .00000001f) direction = Vector3.Normalize(direction);
            if (elapsed < .08f)
                Position = start - direction * .004f * (float)Math.Sin(elapsed / .08f * Math.PI);
            else
            {
                var progress = Clamp((elapsed - .08f) / .58f, 0f, 1f);
                var eased = progress * progress * (3f - 2f * progress);
                var arc = progress > 0f && progress < 1f ? (float)Math.Sin(progress * Math.PI) : 0f;
                Position = Vector3.Lerp(start, target, eased) + Vector3.UnitY * (arc * .007f);
                Pitch = -direction.Y * arc * 8f;
                Bank = -direction.X * arc * 9f;
                var settle = Clamp((elapsed - .66f) / .24f, 0f, 1f);
                if (settle > 0f && settle < 1f)
                    Position += Vector3.UnitY * ((float)Math.Sin(settle * Math.PI * 2f) * (1f - settle) * .002f);
            }
            Position = new Vector3(Clamp(Position.X, -.010f, .010f), Clamp(Position.Y, -.031f, .043f),
                Clamp(Position.Z, -.018f, .002f));
            return Position;
        }

        private static float Finite(float value) => float.IsNaN(value) || float.IsInfinity(value) ? 0f : value;
        private static float Clamp(float value, float min, float max) => Math.Max(min, Math.Min(max, value));
    }
}
