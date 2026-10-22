using System;
using System.Collections.Generic;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class TalkCaptureTests
    {
        [Test]
        public void RecordsBeforeBlockingCapture()
        {
            var calls = new List<string>();
            var started = TalkCapture.Begin(
                () => { calls.Add("microphone"); return true; },
                () => calls.Add("capture"), () => calls.Add("discard"));
            Assert.That(started, Is.True);
            Assert.That(calls, Is.EqualTo(new[] { "microphone", "capture" }));
        }

        [Test]
        public void DoesNotCaptureWhenRecordingCannotStart()
        {
            var captured = false;
            Assert.That(TalkCapture.Begin(() => false, () => captured = true, () => { }), Is.False);
            Assert.That(captured, Is.False);
        }

        [Test]
        public void CaptureFailureDiscardsTheRecordingAndPropagates()
        {
            var discarded = false;
            Assert.Throws<InvalidOperationException>(() => TalkCapture.Begin(
                () => true, () => throw new InvalidOperationException("synthetic capture failure"),
                () => discarded = true));
            Assert.That(discarded, Is.True);
        }
    }
}
