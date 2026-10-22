#nullable enable
using System;
namespace Boopy.Client
{
    /// <summary>Explicit button recording lifetime; expiry only discards, never submits speech.</summary>
    public sealed class ButtonTalk
    {
        public bool Recording { get; private set; }
        private float started;
        public bool Begin(float now)
        {
            if (Recording || float.IsNaN(now) || float.IsInfinity(now)) return false;
            started = now; Recording = true; return true;
        }
        public bool End() { var wasRecording = Recording; Recording = false; return wasRecording; }
        public bool Expired(float now) => Recording && (float.IsNaN(now) || float.IsInfinity(now)
            || now < started || now - started >= Wav.MaxSeconds);
    }
}
