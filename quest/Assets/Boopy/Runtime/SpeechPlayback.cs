#nullable enable
using System;
using System.IO;
using System.Text;
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>Bounded service-generated PCM speech. No network, automatic enablement or model identity.</summary>
    public sealed class SpeechPlayback : MonoBehaviour
    {
        public const int MaxBytes = 2 * 1024 * 1024;
        private AudioSource? source;
        private AudioClip? clip;
        private float[]? waveform;
        public bool Playing => source != null && source.isPlaying;
        public bool HasClip => clip != null;
        /// <summary>Energy at the actual playback cursor, never inferred from response text.</summary>
        public float Activity => Playing && waveform != null ? EnergyAt(waveform, source!.timeSamples) : 0f;
        public static float EnergyAt(float[] samples, int cursor)
        {
            if (cursor < 0 || cursor >= samples.Length) return 0f;
            var end = Math.Min(samples.Length, cursor + 441); // 20 ms at the required sample rate.
            var energy = 0f;
            for (var index = cursor; index < end; index++) energy += samples[index] * samples[index];
            return Mathf.Clamp01(Mathf.Sqrt(energy / (end - cursor)) * 3f);
        }
        public static SpeechPlayback Create(Transform parent)
        {
            var go = new GameObject("Optional Boopy voice"); go.transform.SetParent(parent, false);
            var playback = go.AddComponent<SpeechPlayback>();
            playback.source = go.AddComponent<AudioSource>();
            playback.source.playOnAwake = false; playback.source.loop = false;
            playback.source.spatialBlend = 0; playback.source.volume = .35f;
            return playback;
        }
        public void Play(byte[] wav)
        {
            var samples = Decode(wav, out var sampleRate);
            Stop();
            clip = AudioClip.Create("Boopy response", samples.Length, 1, sampleRate, false);
            if (!clip.SetData(samples, 0)) { Stop(); throw new InvalidDataException("Speech sample upload failed."); }
            if (source == null) { Stop(); return; }
            waveform = samples;
            source.clip = clip; source.Play();
        }
        public void Stop()
        {
            waveform = null;
            if (source != null) { source.Stop(); source.clip = null; }
            if (clip != null)
            {
                if (Application.isPlaying) Destroy(clip); else DestroyImmediate(clip);
                clip = null;
            }
        }
        public static float[] Decode(byte[] wav) => Decode(wav,out _);
        public static float[] Decode(byte[] wav,out int sampleRate)
        {
            sampleRate=0;
            if (wav.Length < 44 || wav.Length > MaxBytes) throw new InvalidDataException("Speech WAV size is unsupported.");
            using var stream = new MemoryStream(wav, false);
            using var reader = new BinaryReader(stream, Encoding.ASCII);
            string Tag() => Encoding.ASCII.GetString(reader.ReadBytes(4));
            if (Tag() != "RIFF" || reader.ReadUInt32() != wav.Length - 8 || Tag() != "WAVE")
                throw new InvalidDataException("Invalid speech WAV container.");
            bool format = false; byte[]? data = null;
            while (stream.Position < stream.Length)
            {
                if (stream.Length - stream.Position < 8) throw new InvalidDataException("Truncated speech chunk.");
                var tag = Tag(); var length = reader.ReadUInt32();
                if (length > stream.Length - stream.Position) throw new InvalidDataException("Invalid speech chunk length.");
                var end = stream.Position + length;
                if (tag == "fmt ")
                {
                    if (format || length < 16 || reader.ReadUInt16() != 1 || reader.ReadUInt16() != 1)
                        throw new InvalidDataException("Speech requires mono PCM16.");
                    sampleRate=(int)reader.ReadUInt32();
                    if((sampleRate!=22050 && sampleRate!=24000) || reader.ReadUInt32()!=sampleRate*2 || reader.ReadUInt16()!=2 || reader.ReadUInt16()!=16)
                        throw new InvalidDataException("Speech requires mono PCM16 at 22050 or 24000 Hz.");
                    format = true;
                }
                else if (tag == "data")
                {
                    if (data != null || length == 0 || length % 2 != 0) throw new InvalidDataException("Invalid speech samples.");
                    data = reader.ReadBytes((int)length);
                }
                stream.Position = end + (length % 2);
                if (stream.Position > stream.Length) throw new InvalidDataException("Missing speech chunk padding.");
            }
            if (!format || data == null) throw new InvalidDataException("Speech WAV lacks format or samples.");
            var samples = new float[data.Length / 2];
            for (var index = 0; index < samples.Length; index++)
                samples[index] = (short)(data[index * 2] | data[index * 2 + 1] << 8) / 32768f;
            return samples;
        }
        private void OnDisable() => Stop();
        private void OnDestroy() => Stop();
    }
}
