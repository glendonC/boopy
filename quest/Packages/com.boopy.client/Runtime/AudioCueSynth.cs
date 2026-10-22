#nullable enable
using System;

namespace Boopy.Client
{
    public enum AudioCue { Hover, Press, Confirm, Saved, CaptureOn, CaptureOff, Failure, Ready }

    /// <summary>Original, quiet felt/glass tones. No recorded media, randomness or engine dependency.</summary>
    public static class AudioCueSynth
    {
        public const int SampleRate = 24000;
        public const float MaximumPeak = 0.22f;

        public static float[] Generate(AudioCue cue, int sampleRate = SampleRate)
        {
            if (sampleRate < 8000 || sampleRate > 48000)
                throw new ArgumentOutOfRangeException(nameof(sampleRate));
            double duration;
            switch (cue)
            {
                case AudioCue.Hover: duration = 0.042; break;
                case AudioCue.Press: duration = 0.070; break;
                case AudioCue.Confirm: duration = 0.190; break;
                case AudioCue.Saved: duration = 0.350; break;
                case AudioCue.CaptureOn:
                case AudioCue.CaptureOff: duration = 0.095; break;
                case AudioCue.Failure: duration = 0.160; break;
                case AudioCue.Ready: duration = 0.240; break;
                default: throw new ArgumentOutOfRangeException(nameof(cue));
            }
            var samples = new float[(int)Math.Ceiling(duration * sampleRate)];
            switch (cue)
            {
                case AudioCue.Hover:
                    Tone(samples, sampleRate, 620, 0, duration, 0.60, 0.16); break;
                case AudioCue.Press:
                    Tone(samples, sampleRate, 245, 0, duration, 0.90, 0.11); break;
                case AudioCue.Confirm:
                    Tone(samples, sampleRate, 523.25, 0, 0.105, 0.55, 0.23);
                    Tone(samples, sampleRate, 659.25, 0.073, 0.117, 0.55, 0.20); break;
                case AudioCue.Saved:
                    Tone(samples, sampleRate, 261.63, 0, duration, 0.45, 0.15);
                    Tone(samples, sampleRate, 329.63, 0.022, duration - 0.022, 0.30, 0.17);
                    Tone(samples, sampleRate, 392.00, 0.044, duration - 0.044, 0.28, 0.16); break;
                case AudioCue.CaptureOn:
                    Tone(samples, sampleRate, 392.00, 0, duration, 0.50, 0.16, 1.03); break;
                case AudioCue.CaptureOff:
                    Tone(samples, sampleRate, 329.63, 0, duration, 0.45, 0.12, 0.97); break;
                case AudioCue.Ready:
                    Tone(samples, sampleRate, 440.0, 0, .240, .40, .11);
                    Tone(samples, sampleRate, 880.0, .075, .165, .27, .13); break;
                case AudioCue.Failure:
                    Tone(samples, sampleRate, 174.61, 0, duration, 0.75, 0.08); break;
            }
            var peak = 0f;
            foreach (var value in samples) peak = Math.Max(peak, Math.Abs(value));
            if (peak > MaximumPeak)
            {
                var scale = MaximumPeak / peak;
                for (var i = 0; i < samples.Length; i++) samples[i] *= scale;
            }
            samples[0] = 0f;
            samples[samples.Length - 1] = 0f;
            return samples;
        }

        private static void Tone(float[] samples, int rate, double frequency, double offset,
            double length, double strength, double brightness, double endPitch = 1.0)
        {
            var start = (int)Math.Round(offset * rate);
            var count = Math.Min(samples.Length - start, (int)Math.Ceiling(length * rate));
            var noise = 0.0;
            uint state = 0x3af19e27;
            for (var i = 0; i < count; i++)
            {
                var t = i / (double)rate;
                var progress = i / (double)Math.Max(1, count - 1);
                var attack = Math.Min(1.0, t / 0.006);
                attack = (1.0 - Math.Cos(Math.PI * attack)) / 2.0;
                var release = Math.Min(1.0, (count - 1 - i) / (rate * 0.015));
                release = (1.0 - Math.Cos(Math.PI * release)) / 2.0;
                var phase = 2.0 * Math.PI * frequency *
                    (t + 0.5 * (endPitch - 1.0) * t * progress);
                // Slightly inharmonic, independently damped modes give a struck material timbre.
                var modal = 0.72 * Math.Sin(phase) * Math.Exp(-t / (length * 0.42))
                    + brightness * Math.Sin(phase * 2.01) * Math.Exp(-t / (length * 0.19))
                    + 0.055 * Math.Sin(phase * 3.94) * Math.Exp(-t / (length * 0.10));
                state = unchecked(state * 1664525u + 1013904223u);
                var excitation = ((state >> 8) / 8388607.5) - 1.0;
                noise = 0.88 * noise + 0.12 * excitation;
                var transient = 0.08 * noise * Math.Exp(-t / 0.008);
                samples[start + i] += (float)(0.20 * strength * attack * release * (modal + transient));
            }
        }
    }
}
