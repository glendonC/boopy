#nullable enable
using Boopy.Client;
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>
    /// The microphone while a pinch is held, as a 16 kHz WAV for whisper.cpp on the Mac. Recording
    /// starts the moment the fingers meet, so the first word is not lost. A tap discards it.
    /// </summary>
    public sealed class Voice
    {
        private AudioClip? clip;

        public bool Recording => clip != null;

        public bool Available => Microphone.devices.Length > 0;

        public void Begin()
        {
            if (clip != null || !Available) return;
            Microphone.GetDeviceCaps(null, out var min, out var max);
            var rate = min == 0 && max == 0 ? Wav.SampleRate : Mathf.Clamp(Wav.SampleRate, min, max);
            // Not looping, a second longer than a clip may be, so the end is never overwritten.
            clip = Microphone.Start(null, false, (int)Wav.MaxSeconds + 1, rate);
        }

        /// <summary>Stops and returns the clip as WAV, or null when it was too short or nothing was recorded.</summary>
        public byte[]? End()
        {
            if (clip == null) return null;
            var position = Microphone.GetPosition(null);
            Microphone.End(null);
            var recorded = clip;
            clip = null;
            var samples = new float[Mathf.Max(0, position) * recorded.channels];
            if (samples.Length > 0) recorded.GetData(samples, 0);
            var wav = Wav.Encode(samples, samples.Length, recorded.channels, recorded.frequency);
            Object.Destroy(recorded);
            return wav;
        }

        public void Discard()
        {
            if (clip == null) return;
            Microphone.End(null);
            Object.Destroy(clip);
            clip = null;
        }
    }
}
