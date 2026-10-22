#nullable enable
using System.Collections.Generic;
using Boopy.Client;
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>Scene-local, restrained interaction tones; silent throughout microphone recording.</summary>
    public sealed class InteractionAudio : MonoBehaviour
    {
        private readonly Dictionary<AudioCue, AudioClip> clips = new Dictionary<AudioCue, AudioClip>();
        private AudioSource? source;
        private bool recording;
        private bool soundEnabled = true;
        private float volume = 0.22f;
        private float lastHover = float.NegativeInfinity;

        public bool SoundEnabled => soundEnabled;
        public float Volume => volume;

        public static InteractionAudio Create(Transform parent)
        {
            var go = new GameObject("Interaction sound");
            go.transform.SetParent(parent, false);
            var sound = go.AddComponent<InteractionAudio>();
            sound.Initialize();
            return sound;
        }

        private void Awake() => Initialize();

        private void Initialize()
        {
            if (source != null) return;
            source = gameObject.AddComponent<AudioSource>();
            source.playOnAwake = false;
            source.loop = false;
            source.spatialBlend = 0.35f;
            source.spatialize = false;
            source.dopplerLevel = 0f;
            source.rolloffMode = AudioRolloffMode.Logarithmic;
            source.minDistance = 0.35f;
            source.maxDistance = 3f;
            source.priority = 192;
            source.volume = volume;
            foreach (AudioCue cue in System.Enum.GetValues(typeof(AudioCue)))
            {
                var samples = AudioCueSynth.Generate(cue);
                var clip = AudioClip.Create("Boopy " + cue, samples.Length, 1,
                    AudioCueSynth.SampleRate, false);
                if (!clip.SetData(samples, 0))
                {
                    Destroy(clip);
                    soundEnabled = false;
                    continue;
                }
                clips.Add(cue, clip);
            }
        }

        /// <summary>Call on target-entry edges, never every frame. Hover also has a 120ms cooldown.</summary>
        public void Play(AudioCue cue)
        {
            if (recording || !soundEnabled || !isActiveAndEnabled || source == null ||
                volume <= 0f || !clips.TryGetValue(cue, out var clip)) return;
            if (cue == AudioCue.Hover)
            {
                // Hover must not chatter or interrupt an acknowledgement/receipt tone.
                if (source.isPlaying || Time.unscaledTime - lastHover < 0.12f) return;
                lastHover = Time.unscaledTime;
            }
            // One cue at a time bounds the peak instead of accumulating repeated one-shots.
            source.Stop();
            source.PlayOneShot(clip);
        }

        /// <summary>Set true immediately before Voice.Begin; no onset cue is played into the mic.</summary>
        public void SetRecording(bool on)
        {
            recording = on;
            if (on && source != null) source.Stop();
        }

        public void SetEnabled(bool on)
        {
            soundEnabled = on;
            if (!on && source != null) source.Stop();
        }

        public void SetVolume(float value)
        {
            volume = float.IsNaN(value) || float.IsInfinity(value) ? 0f : Mathf.Clamp(value, 0f, 0.35f);
            if (source != null)
            {
                source.volume = volume;
                if (volume == 0f) source.Stop();
            }
        }

        private void OnDisable()
        {
            if (source != null) source.Stop();
        }

        private void OnDestroy()
        {
            if (source != null) source.Stop();
            foreach (var clip in clips.Values) Destroy(clip);
            clips.Clear();
        }
    }
}
