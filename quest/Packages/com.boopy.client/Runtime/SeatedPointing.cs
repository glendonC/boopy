#nullable enable
using System;
using System.Numerics;

namespace Boopy.Client
{
    /// <summary>Where the head is and faces, in world space, in meters, with Y up.</summary>
    public readonly struct HeadPose
    {
        public HeadPose(Vector3 position, Vector3 forward)
        {
            Position = position;
            Forward = forward;
        }

        public Vector3 Position { get; }

        public Vector3 Forward { get; }
    }

    /// <summary>What hand tracking reports about one hand, in world space, in meters, with Y up.</summary>
    public readonly struct HandPosture
    {
        public HandPosture(bool tracked, bool right, Vector3 knuckle, Vector3 palm, Vector3 palmNormal, float scale = 1f)
        {
            Tracked = tracked;
            Right = right;
            Knuckle = knuckle;
            Palm = palm;
            PalmNormal = palmNormal;
            Scale = scale;
        }

        /// <summary>The hand is tracked with high confidence.</summary>
        public bool Tracked { get; }

        public bool Right { get; }

        /// <summary>The index finger's knuckle, which a pinch barely moves: where the ray starts.</summary>
        public Vector3 Knuckle { get; }

        /// <summary>The middle of the palm.</summary>
        public Vector3 Palm { get; }

        /// <summary>The direction the palm faces, out of the palm.</summary>
        public Vector3 PalmNormal { get; }

        /// <summary>The hand's size relative to an average hand, which scales the body offsets.</summary>
        public float Scale { get; }
    }

    /// <summary>A hand ray for a seated person, and whether it should be on.</summary>
    public readonly struct SeatedRay
    {
        public SeatedRay(bool active, Vector3 origin, Vector3 direction, bool palmFacesHead, bool palmDown)
        {
            Active = active;
            Origin = origin;
            Direction = direction;
            PalmFacesHead = palmFacesHead;
            PalmDown = palmDown;
        }

        /// <summary>The ray is on: the hand is tracked, in front of the person, and neither resting nor making the system gesture.</summary>
        public bool Active { get; }

        public Vector3 Origin { get; }

        /// <summary>A unit vector.</summary>
        public Vector3 Direction { get; }

        /// <summary>The palm faces the eyes, the posture of the headset's own menu gesture: a pinch then is the system's.</summary>
        public bool PalmFacesHead { get; }

        /// <summary>The palm faces the floor, as a hand does that rests or types on a desk, a keyboard or a lap.</summary>
        public bool PalmDown { get; }
    }

    /// <summary>
    /// A hand ray a seated person can point with from a relaxed posture. The headset's own hand ray
    /// runs from the shoulder through the hand, so a target 10 degrees below the eyes needs the hand
    /// held up near shoulder height. This one runs through the index knuckle from a pivot
    /// <see cref="PivotDown"/> below the eyes, about where a relaxed forearm rests, so a hand held a
    /// little above a desk points ahead: across the room, or at something on the desk.
    /// </summary>
    /// <remarks>
    /// The trade-off: hands at a desk's height point near the stage, so the pivot alone would put rays
    /// on the room while the person types. A hand whose palm faces the floor (resting or typing on a
    /// desk, a keyboard or a lap) therefore has no ray; to point, the palm turns to face sideways or
    /// away, as it does when pointing at something across a room, and as it does for the headset's
    /// own ray. A palm facing the eyes is the headset's menu gesture and has no ray either. Hands low
    /// in the lap or on an armrest point steeply down, at nothing.
    /// </remarks>
    public static class SeatedPointing
    {
        /// <summary>The pivot's offsets from the eyes, in meters, for an average hand, in the frame the head faces on the level.</summary>
        public const float PivotSide = 0.13f;

        public const float PivotDown = 0.40f;

        public const float PivotBack = 0.10f;

        /// <summary>A palm closer than this to facing straight down rests or types, and has no ray.</summary>
        public const float PalmDownDegrees = 20f;

        /// <summary>A palm closer than this to facing the eyes makes the system gesture, and has no ray.</summary>
        public const float PalmToHeadDegrees = 60f;

        /// <summary>A hand must be at least this far in front of the eyes to point.</summary>
        public const float InFrontMeters = 0.1f;

        private static readonly Vector3 Up = Vector3.UnitY;

        /// <summary>The pivot the ray passes through for this hand: below and behind its shoulder.</summary>
        public static Vector3 Pivot(HeadPose head, bool right, float scale)
        {
            var (forward, rightward) = Level(head.Forward);
            var size = Math.Clamp(scale, 0.8f, 1.25f);
            return head.Position
                + rightward * ((right ? PivotSide : -PivotSide) * size)
                - Up * (PivotDown * size)
                - forward * (PivotBack * size);
        }

        /// <summary>The ray for a hand, and whether it is on. The pose is computed even when off, so it is ready when it turns on.</summary>
        public static SeatedRay Aim(HeadPose head, HandPosture hand)
        {
            var pivot = Pivot(head, hand.Right, hand.Scale);
            var along = hand.Knuckle - pivot;
            var direction = along.LengthSquared() > 1e-8f ? Vector3.Normalize(along) : Level(head.Forward).Forward;
            var normal = hand.PalmNormal.LengthSquared() > 1e-8f ? Vector3.Normalize(hand.PalmNormal) : Vector3.Zero;

            var toEyes = head.Position - hand.Palm;
            var palmFacesHead = toEyes.LengthSquared() > 1e-8f
                && Vector3.Dot(normal, Vector3.Normalize(toEyes)) > MathF.Cos(PalmToHeadDegrees * MathF.PI / 180f);
            var palmDown = Vector3.Dot(normal, -Up) > MathF.Cos(PalmDownDegrees * MathF.PI / 180f);
            var inFront = Vector3.Dot(hand.Knuckle - head.Position, Level(head.Forward).Forward) >= InFrontMeters;

            var active = hand.Tracked && normal != Vector3.Zero && !palmFacesHead && !palmDown && inFront;
            return new SeatedRay(active, hand.Knuckle, direction, palmFacesHead, palmDown);
        }

        /// <summary>Where the head faces on the level, and its right, for Unity's left-handed frame.</summary>
        private static (Vector3 Forward, Vector3 Right) Level(Vector3 forward)
        {
            var level = new Vector3(forward.X, 0f, forward.Z);
            level = level.LengthSquared() > 1e-8f ? Vector3.Normalize(level) : Vector3.UnitZ;
            return (level, new Vector3(level.Z, 0f, -level.X));
        }
    }
}
