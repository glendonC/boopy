#nullable enable
namespace Boopy.Client
{
    public enum PinchEvent
    {
        None,

        /// <summary>The fingers met: capture the frame and cues now, before the head moves.</summary>
        Began,

        /// <summary>Held long enough to be talking: start recording.</summary>
        Holding,

        /// <summary>Let go quickly: a tap on whatever is targeted.</summary>
        Tapped,

        /// <summary>Let go after talking: send what was said.</summary>
        Released,

        /// <summary>Dropped without a clean release (tracking lost, system gesture): discard.</summary>
        Cancelled,
    }

    /// <summary>
    /// One hand's pinch, read once a frame: a quick pinch is a tap, a held pinch is talking.
    /// Hysteresis on pinch strength stops a wavering pinch from flickering.
    /// </summary>
    public sealed class PinchGesture
    {
        /// <summary>Holding longer than this is talking. Meta's long press is 0.5 s; talking starts sooner.</summary>
        public const float HoldSeconds = 0.35f;

        public const float PressStrength = 0.85f;
        public const float ReleaseStrength = 0.5f;

        private bool down;
        private bool holding;
        private float since;

        public bool Down => down;
        public bool Holding => holding;

        /// <summary>Seconds since the pinch began, while it is down.</summary>
        public float HeldFor(float now) => down ? now - since : 0f;

        public PinchEvent Update(bool tracked, float strength, bool systemGesture, float now)
        {
            if (!tracked || systemGesture)
            {
                if (!down) return PinchEvent.None;
                down = false;
                holding = false;
                return PinchEvent.Cancelled;
            }
            if (!down)
            {
                if (strength < PressStrength) return PinchEvent.None;
                down = true;
                holding = false;
                since = now;
                return PinchEvent.Began;
            }
            if (strength < ReleaseStrength)
            {
                down = false;
                // Capture or a slow frame may take longer than the hold threshold. The next
                // sample can already be the release, without an intermediate Holding event.
                var wasHolding = holding || now - since >= HoldSeconds;
                holding = false;
                return wasHolding ? PinchEvent.Released : PinchEvent.Tapped;
            }
            if (!holding && now - since >= HoldSeconds)
            {
                holding = true;
                return PinchEvent.Holding;
            }
            return PinchEvent.None;
        }
    }
}
