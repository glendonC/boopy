#nullable enable
using System;
using System.Reflection;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>Synthetic playback-energy channel only; no microphone, audio or provider call.</summary>
    public static class SpeakingCompanionValidation
    {
        public static void Validate()
        {
            var root = new GameObject("Synthetic speech companion");
            try
            {
                var companion = CompanionOrb.Create(root.transform);
                var independent = CompanionOrb.Create(root.transform);
                var body = (Transform)Read(companion, "body")!;
                companion.SetState("review"); independent.SetState("review");
                companion.SetSpeaking(.2f); companion.Refresh(.1f, false);
                var quiet = body.localPosition;
                companion.SetSpeaking(1f); companion.Refresh(.1f, false);
                Require(body.localPosition.y > quiet.y, "Actual speech energy did not drive the body beat.");
                Require((float)Read(independent, "speakingActivity")! == 0f, "One companion's speech changed another.");
                var hand = (Transform)Read(companion, "rightHand")!;
                var frozenPosition = body.localPosition; var frozenRotation = body.localRotation; var frozenHand = hand.localPosition;
                var clock = (float)Read(companion, "clock")!;
                companion.SetFrozen(true); companion.SetSpeaking(.05f); companion.Refresh(3f, false);
                Require(body.localPosition == frozenPosition, "Reading moved the companion anchor.");
                Require(body.localRotation != frozenRotation, "Reading suppressed actual playback pose response.");
                Require(hand.localPosition != frozenHand && (float)Read(companion, "clock")! > clock, "Reading freeze suppressed actual speech expression.");
                companion.SetSpeaking(0f); companion.SetState("processing"); companion.Refresh(.1f, true);
                Require((float)Read(companion, "leftOpening")! < (float)Read(companion, "rightOpening")!, "Reading freeze suppressed state eye expression.");
                companion.SetState("review"); companion.SetSpeaking(.01f); companion.Refresh(.1f, true);
                var frozenReducedHand = hand.localPosition; var frozenReducedRotation = hand.localRotation;
                var reducedBodyRotation = body.localRotation; var reducedBodyScale = body.localScale;
                companion.SetSpeaking(1f); companion.Refresh(10f, true);
                Require(hand.localPosition == frozenReducedHand && hand.localRotation == frozenReducedRotation, "Reduced expression oscillated while reading.");
                Require(body.localPosition == frozenPosition && body.localRotation == reducedBodyRotation && body.localScale == reducedBodyScale, "Reduced expression moved the pinned state pose.");
                companion.SetFrozen(false); companion.SetSpeaking(.01f); companion.Refresh(.1f, true);
                var reducedPosition = body.localPosition; var reducedRotation = body.localRotation; var reducedHand = hand.localPosition;
                companion.SetSpeaking(1f); companion.Refresh(10f, true);
                Require(body.localPosition == reducedPosition && body.localRotation == reducedRotation && hand.localPosition == reducedHand, "Reduced speech pose oscillated with energy or time.");
                companion.SetSpeaking(0f); companion.Refresh(.1f, true);
                Require(body.localRotation != reducedRotation, "Stopped audio retained the speech pose.");
                companion.SetSpeaking(1f); companion.SetVisible(false); companion.SetSpeaking(1f); companion.Refresh(10f, false);
                Require(!body.gameObject.activeSelf && (float)Read(companion, "speakingActivity")! == 0f, "Hidden companion retained speech activity.");
                companion.SetVisible(true); companion.SetSpeaking(float.NaN);
                Require((float)Read(companion, "speakingActivity")! == 0f, "Invalid energy invented speech.");
                Require(companion.GetComponentsInChildren<Collider>(true).Length == 0, "Speech introduced interaction colliders.");
                Debug.Log("Boopy synthetic speech-companion validation passed; PCM-linked beats are not word timing or lip sync.");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }
        private static object? Read(object target, string name) => target.GetType().GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(target);
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
