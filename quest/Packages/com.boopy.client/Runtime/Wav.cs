#nullable enable
using System;
using System.IO;
using System.Text;

namespace Boopy.Client
{
    /// <summary>Microphone samples as the 16 kHz, mono, 16-bit WAV whisper.cpp reads.</summary>
    public static class Wav
    {
        public const int SampleRate = 16000;

        /// <summary>Shorter clips hold no speech worth sending.</summary>
        public const float MinSeconds = 0.3f;

        public const float MaxSeconds = 30f;

        /// <summary>
        /// Encodes interleaved float samples, mixing channels down and resampling linearly to
        /// 16 kHz; null when the clip is too short.
        /// </summary>
        public static byte[]? Encode(float[] samples, int count, int channels, int rate)
        {
            if (channels < 1) throw new ArgumentOutOfRangeException(nameof(channels));
            if (rate < 1) throw new ArgumentOutOfRangeException(nameof(rate));
            var frames = Math.Min(count, samples.Length) / channels;
            if (frames < rate * MinSeconds) return null;
            var mono = new float[frames];
            for (var frame = 0; frame < frames; frame++)
            {
                var sum = 0f;
                for (var channel = 0; channel < channels; channel++) sum += samples[frame * channels + channel];
                mono[frame] = sum / channels;
            }
            var outFrames = (int)Math.Min((long)frames * SampleRate / rate, (long)(SampleRate * MaxSeconds));
            var pcm = new short[outFrames];
            for (var index = 0; index < outFrames; index++)
            {
                var source = (double)index * rate / SampleRate;
                var left = (int)source;
                var right = Math.Min(left + 1, frames - 1);
                var t = (float)(source - left);
                var value = mono[left] * (1 - t) + mono[right] * t;
                pcm[index] = (short)Math.Round(Math.Clamp(value, -1f, 1f) * short.MaxValue);
            }
            using var stream = new MemoryStream(44 + outFrames * 2);
            using var writer = new BinaryWriter(stream, Encoding.ASCII);
            writer.Write(Encoding.ASCII.GetBytes("RIFF"));
            writer.Write(36 + outFrames * 2);
            writer.Write(Encoding.ASCII.GetBytes("WAVE"));
            writer.Write(Encoding.ASCII.GetBytes("fmt "));
            writer.Write(16);
            writer.Write((short)1);
            writer.Write((short)1);
            writer.Write(SampleRate);
            writer.Write(SampleRate * 2);
            writer.Write((short)2);
            writer.Write((short)16);
            writer.Write(Encoding.ASCII.GetBytes("data"));
            writer.Write(outFrames * 2);
            foreach (var sample in pcm) writer.Write(sample);
            writer.Flush();
            return stream.ToArray();
        }
    }
}
