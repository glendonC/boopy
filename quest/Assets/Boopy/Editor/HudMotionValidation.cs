#nullable enable
using System;
using System.Linq;
using System.Reflection;
using TMPro;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>Production control/motion assertions with synthetic elapsed time only.</summary>
    public static class HudMotionValidation
    {
        public static void ValidateFinal()
        {
            Validate(); ValidateCharacterSequence(); LiveSceneHudValidation.Validate(); ModularUiValidation.Validate(); SpeechValidation.Validate();
            Debug.Log("Boopy final HUD control, pause, glyph and speech validation passed.");
        }
        public static void ValidateAll()
        {
            Validate(); ValidateCharacterSequence(); LiveSceneHudValidation.Validate(); SpeechValidation.Validate();
            FirstTurnExperienceValidation.Validate(); SpeakingCompanionValidation.Validate();
            ConversationActionsValidation.Validate(); ConversationVisibilityValidation.Validate();
            ConsoleFootprintValidation.Validate(); ContextualFollowUpValidation.Validate();
            PeripheralHudValidation.ValidateAll();
            Debug.Log("Boopy combined live HUD, voice and conversation validation passed.");
        }
        public static void Validate()
        {
            var root = new GameObject("Synthetic HUD motion");
            try
            {
                foreach (var action in new[] { ConsoleAction.Options, ConsoleAction.Review, ConsoleAction.FollowUpOne })
                {
                    var control = SpatialAction.Create(root.transform, action, action == ConsoleAction.Options ? "Options" : action == ConsoleAction.Review ? "Review" : "What is this?", action == ConsoleAction.Options ? .080f : .220f);
                    control.Refresh(1f, 1f, false);
                    var label = control.GetComponentsInChildren<TextMeshPro>(true).Single();
                    Require(label.gameObject.activeSelf && label.color.a > .95f, "A control label waits for hover.");
                    var edge = control.GetComponentsInChildren<LineRenderer>(true).Single(line => line.name == "Action boundary");
                    var plate = control.GetComponentsInChildren<MeshRenderer>(true).Single(renderer => renderer.name == "Action surface");
                    var color = new MaterialPropertyBlock(); plate.GetPropertyBlock(color); var resting = color.GetColor("_Color");
                    Require(!edge.enabled && plate.enabled && resting.a > .9f, "Resting action lacks its filled well or retains a perimeter cage.");
                    Require(plate.GetComponent<MeshFilter>().sharedMesh.vertexCount > 20, "Action well is not rounded.");
                    var box = control.GetComponent<BoxCollider>(); var size = box.size; var position = box.transform.position;
                    control.Focus(true); control.Press(true); control.Refresh(.2f, 1f, false);
                    plate.GetPropertyBlock(color); var focused = color.GetColor("_Color");
                    Require(focused != resting && focused.a > .9f && box.size == size && box.transform.position == position,
                        "Focus lacks filled feedback or moves the target.");
                    control.Focus(false); control.Press(false); control.Refresh(1f, .2f, true);
                    plate.GetPropertyBlock(color);
                    Require(!box.enabled && color.GetColor("_Color").a <= .2f, "Fading control remains interactive or fully opaque.");
                }
                var companion = CompanionOrb.Create(root.transform);
                companion.SetState("idle");
                var body = (Transform)Read(companion, "body")!;
                var origin = root.transform.position; var maximum = 0f;
                for (var frame = 0; frame < 1080; frame++)
                {
                    companion.Refresh(1f / 60f, false);
                    maximum = Mathf.Max(maximum, body.localPosition.magnitude);
                    Require(body.localPosition.magnitude < .003f, "Idle character left its anchored breathing envelope.");
                }
                Require(maximum <= .003f && root.transform.position == origin, "Idle character made an unrelated excursion or moved its HUD anchor.");
                companion.SetFrozen(true); var pinned = body.localPosition;
                companion.Refresh(1f, false); Require(body.localPosition == pinned, "Targeting freeze moved the body.");
                companion.SetFrozen(false); companion.Refresh(.1f, true); var reduced = body.localPosition;
                companion.Refresh(10f, true); Require(body.localPosition == reduced, "Reduced motion retained autonomous travel.");
                companion.SetState("processing"); companion.Refresh(.1f, false);
                var hand = (Transform)Read(companion, "rightHand")!; var before = hand.localPosition;
                for (var frame = 0; frame < 30; frame++) companion.Refresh(1f / 60f, false);
                Require(hand.localPosition.y > before.y && hand.localPosition.y > .010f
                    && Mathf.Abs(hand.localPosition.x-.035f)<.002f, "Processing did not lift a close hand into its considering pose.");
                companion.Refresh(.1f, true); var quietHand = hand.localPosition;
                companion.Refresh(10f, true); Require(hand.localPosition == quietHand, "Reduced processing retained its orbit.");
                Require(companion.GetComponentsInChildren<Collider>(true).Length == 0, "Character motion introduced interaction targets.");
                var head = new GameObject("Synthetic caption eyes").transform; head.SetParent(root.transform, false);
                var console = ContextConsole.Create(root.transform, head);
                var caption = DialogueStrip.Create(root.transform, head); console.DockDialogue(caption);
                caption.Show(DialogueStage.Working, "Thinking…"); caption.SetCancelableWait(true);
                Require(!caption.GetComponentsInChildren<Transform>(true).Any(value => value.name == "Pending reply dot"), "Rejected thinking dots remain in the caption.");
                var words = caption.GetComponentsInChildren<TextMeshPro>(true).Single(value => value.name == "Actual response");
                caption.SetFallback(true); caption.RefreshVisuals(.3f);
                var shimmerBefore = GlyphColors(words); caption.RefreshVisuals(.3f);
                Require(shimmerBefore.Length > 0 && !shimmerBefore.SequenceEqual(GlyphColors(words)), "Actual working text has no moving brightness shimmer.");
                console.SetReducedMotion(true); caption.RefreshVisuals(.2f);
                var reducedColors = GlyphColors(words); caption.RefreshVisuals(10f);
                Require(reducedColors.SequenceEqual(GlyphColors(words)), "Reduced waiting text continues shimmering.");
                console.SetReducedMotion(false);
                caption.Show(DialogueStage.Response, "Exact synthetic reply."); caption.RefreshVisuals(.3f);
                var replyColors = GlyphColors(words); caption.RefreshVisuals(.7f);
                Require(replyColors.SequenceEqual(GlyphColors(words)) && caption.FullText == "Exact synthetic reply.", "Settled reply retains shimmer or loses exact text.");
                Debug.Log("Boopy HUD control and anchored character validation passed; synthetic timing, not headset comfort.");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }
        /// <summary>Actual production rig driven by a synthetic event sequence; no device/audio/model.</summary>
        public static void ValidateCharacterSequence()
        {
            ValidateGreeting();
            var root = new GameObject("Synthetic coherent companion sequence");
            try
            {
                var companion = CompanionOrb.Create(root.transform);
                var body = (Transform)Read(companion, "body")!;
                var hand = (Transform)Read(companion, "rightHand")!;
                companion.FlyToward(new Vector3(.5f, .2f, -1f));
                companion.Refresh(.2f, false);
                companion.SetState("listening"); companion.SetSpeaking(1f); companion.Refresh(.2f, false);
                Require((float)Read(companion, "speakingActivity")! == 0f, "Old audio overrides actual recording.");
                companion.SetState("processing"); companion.SetSpeaking(1f); companion.Refresh(.3f, false);
                Require(hand.localPosition.y>.010f && (float)Read(companion,"speakingActivity")! == 0f,
                    "Pending request failed to react promptly or inherited old playback.");
                var minimumHand=float.PositiveInfinity;var maximumHand=float.NegativeInfinity;
                var minimumScale=float.PositiveInfinity;var maximumScale=float.NegativeInfinity;
                var anchor=companion.transform.position;
                for (var frame = 0; frame < 600; frame++)
                {
                    companion.SetState("processing"); // Ordinary Compose must not restart the performance.
                    companion.Refresh(1f / 60f, false);
                    if(frame<30)continue;
                    minimumHand=Mathf.Min(minimumHand,hand.localPosition.y);maximumHand=Mathf.Max(maximumHand,hand.localPosition.y);
                    minimumScale=Mathf.Min(minimumScale,body.localScale.y);maximumScale=Mathf.Max(maximumScale,body.localScale.y);
                    Require(Mathf.Abs(hand.localPosition.x-.035f)<.0001f && hand.localPosition.y>=.0119f && hand.localPosition.y<=.0141f,
                        "Pending hand left its close considering envelope or orbited.");
                    Require(body.localPosition.magnitude<.002f && companion.transform.position==anchor,"Considering moved the interaction anchor.");
                }
                Require(maximumHand-minimumHand>.001f && maximumScale-minimumScale>.012f,
                    "Actual long processing became a static pose while its text kept waiting.");
                companion.SetFrozen(true);var pinnedProcessing=body.localPosition;
                companion.Refresh(.8f,false);
                Require(body.localPosition==pinnedProcessing,"Reading freeze lost its fixed translation.");
                companion.SetFrozen(false);
                companion.Refresh(0f,true);var quietProcessingHand=hand.localPosition;var quietProcessingRotation=body.localRotation;
                companion.Refresh(12f,true);
                Require(hand.localPosition==quietProcessingHand && body.localRotation==quietProcessingRotation,
                    "Reduced processing continued its considering performance.");
                companion.SetState("review"); companion.Refresh(.2f, false);
                Require(hand.localPosition.y<-.010f,"Returned answer retained the pending considering hand.");
                var responseAt = (float)Read(companion, "stateAt")!;
                companion.SetState("review");
                Require((float)Read(companion, "stateAt")! == responseAt, "Refreshing a response restarts its gesture.");
                companion.SetSpeaking(.8f); companion.Refresh(.1f, false);
                companion.SetState("listening"); companion.Refresh(.1f, false);
                Require((float)Read(companion, "speakingActivity")! == 0f, "New recording did not interrupt playback expression.");
                companion.SetState("error"); companion.Refresh(.3f, false);
                companion.SetState("idle"); companion.Refresh(.3f, false);
                Require(body.localPosition.magnitude < .003f, "Interrupted sequence moved the anchored character.");
                companion.SetVisible(false); companion.SetState("saved"); companion.SetVisible(true);
                Require((float)Read(companion, "clock")! - (float)Read(companion, "stateAt")! >= 1f, "Reveal replays a hidden completion gesture.");
                companion.Refresh(0f, true); var still = body.localPosition; var stillHand = hand.localPosition;
                companion.Refresh(20f, true);
                Require(body.localPosition == still && hand.localPosition == stillHand, "Reduced sequence keeps moving.");
                Debug.Log("Boopy synthetic event-driven companion sequence passed; wearer acceptance remains unverified.");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }

        public static void ValidateGreeting()
        {
            var root=new GameObject("Synthetic first visible greeting");
            try
            {
                var greeting=CompanionOrb.Create(root.transform);var quiet=CompanionOrb.Create(root.transform);
                var body=(Transform)Read(greeting,"body")!;var quietBody=(Transform)Read(quiet,"body")!;
                var hand=(Transform)Read(greeting,"rightHand")!;var quietHand=(Transform)Read(quiet,"rightHand")!;
                var anchor=greeting.transform.position;
                greeting.SetAttention(new Vector3(.2f,.04f,-1f));quiet.SetAttention(new Vector3(.2f,.04f,-1f));
                greeting.Greet();greeting.Refresh(.25f,false);quiet.Refresh(.25f,false);
                Require(Quaternion.Angle(body.localRotation,quietBody.localRotation)>4f,
                    "Actual opening acknowledgment is imperceptibly static.");
                Require(hand.localPosition==quietHand.localPosition && greeting.transform.position==anchor,
                    "Greeting adds a hand wave or moves its caption/control anchor.");
                greeting.Refresh(1f,false);quiet.Refresh(1f,false);
                Require(Quaternion.Angle(body.localRotation,quietBody.localRotation)<.05f,
                    "Finite greeting keeps running after its opening.");
                greeting.Greet();greeting.Refresh(0f,true);quiet.Refresh(0f,true);
                greeting.Refresh(.25f,false);quiet.Refresh(.25f,false);
                Require(Quaternion.Angle(body.localRotation,quietBody.localRotation)<.05f
                    && float.IsNegativeInfinity((float)Read(greeting,"greetingAt")!),
                    "Reduced greeting replays when motion is enabled later.");
                foreach(var state in new[]{"listening","processing","error"})
                {
                    greeting.SetState("idle");quiet.SetState("idle");greeting.Greet();
                    greeting.SetState(state);quiet.SetState(state);
                    greeting.Refresh(.1f,false);quiet.Refresh(.1f,false);
                    Require(float.IsNegativeInfinity((float)Read(greeting,"greetingAt")!)
                        && Quaternion.Angle(body.localRotation,quietBody.localRotation)<.05f,
                        "Real "+state+" failed to replace the greeting immediately.");
                }
                greeting.SetState("idle");greeting.Greet();greeting.SetVisible(false);greeting.SetVisible(true);
                Require(float.IsNegativeInfinity((float)Read(greeting,"greetingAt")!),"Hidden greeting was queued for later replay.");
                Debug.Log("Boopy finite opening greeting passed; actual event, no wave, no fake speech, no reduced replay.");
            }
            finally {UnityEngine.Object.DestroyImmediate(root);}
        }

        private static Color32[] GlyphColors(TextMeshPro text)
        {
            var info = text.textInfo;
            return info.characterInfo.Take(info.characterCount).Where(glyph => glyph.isVisible)
                .Select(glyph => info.meshInfo[glyph.materialReferenceIndex].colors32[glyph.vertexIndex]).ToArray();
        }
        private static object? Read(object target, string name) => target.GetType().GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(target);
        private static void Require(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
    }
}
