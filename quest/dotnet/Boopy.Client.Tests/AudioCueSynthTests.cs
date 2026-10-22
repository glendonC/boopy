using System;
using System.Linq;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class AudioCueSynthTests
    {
        [TestCase(AudioCue.Hover)]
        [TestCase(AudioCue.Press)]
        [TestCase(AudioCue.Confirm)]
        [TestCase(AudioCue.Saved)]
        [TestCase(AudioCue.CaptureOn)]
        [TestCase(AudioCue.CaptureOff)]
        [TestCase(AudioCue.Failure)]
        public void HasQuietFiniteDeterministicPcmAndSilenceAtTheBoundaries(AudioCue cue)
        {
            var samples = AudioCueSynth.Generate(cue);
            Assert.That(samples.Length, Is.InRange((int)(0.04 * AudioCueSynth.SampleRate),
                (int)(0.36 * AudioCueSynth.SampleRate)));
            Assert.That(samples.All(s => !float.IsNaN(s) && !float.IsInfinity(s)), Is.True);
            Assert.That(samples.Select(Math.Abs).Max(), Is.InRange(0.02f, AudioCueSynth.MaximumPeak));
            Assert.That(samples[0], Is.Zero);
            Assert.That(samples[samples.Length - 1], Is.Zero);
            Assert.That(samples, Is.EqualTo(AudioCueSynth.Generate(cue)));
            var attackPeak = samples.Take((int)(0.001 * AudioCueSynth.SampleRate)).Select(Math.Abs).Max();
            Assert.That(attackPeak, Is.LessThan(0.012f), "attack avoids a sharp digital click");
            var lastPeak = samples.Skip(samples.Length - (int)(0.001 * AudioCueSynth.SampleRate))
                .Select(Math.Abs).Max();
            Assert.That(lastPeak, Is.LessThan(0.004f), "tail fades into silence");
        }

        [Test]
        public void GivesEachSemanticCueADifferentWaveformAndShortDuration()
        {
            var cues = (AudioCue[])Enum.GetValues(typeof(AudioCue));
            for (var i = 0; i < cues.Length; i++)
                for (var j = i + 1; j < cues.Length; j++)
                    Assert.That(AudioCueSynth.Generate(cues[i]).SequenceEqual(AudioCueSynth.Generate(cues[j])), Is.False);
            Assert.That(AudioCueSynth.Generate(AudioCue.Saved).Length,
                Is.GreaterThan(AudioCueSynth.Generate(AudioCue.Confirm).Length));
            Assert.That(AudioCueSynth.Generate(AudioCue.Hover).Length,
                Is.LessThan(AudioCueSynth.Generate(AudioCue.Press).Length));
        }

        [TestCase(8000)]
        [TestCase(48000)]
        public void SupportsBoundedSampleRatesWithoutClipping(int rate)
        {
            var samples = AudioCueSynth.Generate(AudioCue.Saved, rate);
            Assert.That(samples.Length, Is.EqualTo((int)Math.Ceiling(0.35 * rate)));
            Assert.That(samples.Select(Math.Abs).Max(), Is.LessThanOrEqualTo(AudioCueSynth.MaximumPeak));
        }

        [Test]
        public void RefusesUnsupportedInputsRatherThanGeneratingUnboundedSamples()
        {
            Assert.Throws<ArgumentOutOfRangeException>(() => AudioCueSynth.Generate(AudioCue.Hover, 0));
            Assert.Throws<ArgumentOutOfRangeException>(() => AudioCueSynth.Generate(AudioCue.Hover, 192000));
            Assert.Throws<ArgumentOutOfRangeException>(() => AudioCueSynth.Generate((AudioCue)999));
        }
    }
}
