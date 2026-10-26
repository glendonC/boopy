#nullable enable
using System.Collections.Generic;
using Boopy.Client;
using UnityEngine;
using N = System.Numerics;

namespace Boopy.Quest
{
    /// <summary>
    /// One tracked hand: its index pinch as taps and holds, and a ray a seated person can point
    /// with. The SDK ray needs the hand held up near shoulder height, so the room does not use it;
    /// a recording that fills the view does, since there the Quest's own pointing is what the
    /// person knows. The palm's facing comes from the knuckle positions, not from joint axes, so it
    /// does not depend on any skeleton's axis conventions. While a Touch controller is held in that
    /// hand the headset tracks no hand, so the controller's trigger is the pinch and its pose the ray.
    /// </summary>
    public sealed class HandInput
    {
        /// <summary>A Touch controller in this hand, read once a frame: whether it is held, its trigger, and its pose.</summary>
        public readonly struct Controller
        {
            public Controller(bool held, float trigger, Vector3 position, Vector3 forward)
            {
                Held = held; Trigger = trigger; Position = position; Forward = forward;
            }

            public bool Held { get; }
            public float Trigger { get; }
            public Vector3 Position { get; }
            public Vector3 Forward { get; }
        }

        private readonly OVRHand? hand;
        private readonly OVRSkeleton? skeleton;
        private Dictionary<OVRSkeleton.BoneId, Transform>? bones;
        private string? reportedBlock;
        private bool usingController;
        private int reportedHand = -1;

        public HandInput(bool right, OVRHand? hand, OVRSkeleton? skeleton)
        {
            Right = right;
            this.hand = hand;
            this.skeleton = skeleton;
        }

        public bool Right { get; }
        /// <summary>Whether the scene gave this hand its OVRHand and OVRSkeleton.</summary>
        public bool Found => hand != null && skeleton != null;
        public PinchGesture Gesture { get; } = new PinchGesture();
        public bool RayActive { get; private set; }
        public Ray Ray { get; private set; }
        public bool Tracked { get; private set; }
        /// <summary>A newly blocked pinch attempt this update, for a brief hint to the person.</summary>
        public string? BlockedAttempt { get; private set; }

        /// <summary>
        /// Reads the hand, or the controller held in it, once a frame; returns what its pinch did. With
        /// <paramref name="pointing"/> the hand's ray is the Quest's own pointing pose.
        /// </summary>
        public PinchEvent Update(Transform head, float now, bool inputAllowed, Controller controller = default, bool pointing = false)
        {
            BlockedAttempt = null;
            ReportHand();
            var handTracked = hand != null && hand.IsTracked && hand.IsDataHighConfidence;
            var held = !handTracked && controller.Held;
            if (held != usingController)
            {
                usingController = held;
                Debug.Log($"Boopy: input {(Right ? "right" : "left")} {(held ? "controller" : "hand")}.");
            }
            Tracked = inputAllowed && (handTracked || held);
            var rawStrength = held ? controller.Trigger : hand != null ? hand.GetFingerPinchStrength(OVRHand.HandFinger.Index) : 0f;
            var strength = Tracked ? rawStrength : 0f;
            var palmFacesHead = held ? AimController(controller) : pointing ? AimPointer() : UpdateRay(head);
            var system = !held && (hand != null && hand.IsSystemGestureInProgress || palmFacesHead);
            var pinch = Gesture.Update(Tracked, strength, system, now);
            var blocked = !inputAllowed ? "focus" : held ? null : hand == null ? "missing-hand"
                : !hand.IsTracked ? "tracking" : !hand.IsDataHighConfidence ? "confidence"
                : hand.IsSystemGestureInProgress ? "system" : palmFacesHead ? "palm" : null;
            // Only gesture edges and newly blocked attempts are logged: no poses, audio or
            // frame contents, and no per-frame tracking chatter while the hands rest.
            if (pinch != PinchEvent.None)
            {
                Debug.Log($"Boopy: input {(Right ? "right" : "left")} {pinch} reason={blocked ?? "none"}.");
            }
            if (rawStrength >= PinchGesture.PressStrength && blocked != null && reportedBlock != blocked)
            {
                reportedBlock = blocked;
                BlockedAttempt = blocked;
                Debug.Log($"Boopy: input {(Right ? "right" : "left")} blocked reason={blocked}.");
            }
            else if (rawStrength < PinchGesture.ReleaseStrength)
            {
                reportedBlock = null;
            }
            return pinch;
        }

        // A held controller points where it points; it has no palm to face the eyes.
        private bool AimController(Controller controller)
        {
            RayActive = Tracked && controller.Forward.sqrMagnitude > 1e-6f;
            Ray = new Ray(controller.Position, RayActive ? controller.Forward.normalized : Vector3.forward);
            return false;
        }

        // The Quest's own pointing pose, while it has one; the headset's menu gesture comes as a system gesture instead.
        private bool AimPointer()
        {
            RayActive = Tracked && hand != null && hand.IsPointerPoseValid;
            if (RayActive) Ray = new Ray(hand!.PointerPose.position, hand.PointerPose.forward);
            return false;
        }

        // What the headset says of this hand, logged on each change only, so a device run shows which of tracking, valid
        // data and confidence a pinch waited on. No poses.
        private void ReportHand()
        {
            if (hand == null) return;
            var state = (hand.IsTracked ? 1 : 0) | (hand.IsDataValid ? 2 : 0) | (hand.IsDataHighConfidence ? 4 : 0);
            if (state == reportedHand) return;
            reportedHand = state;
            static string Said(bool yes) => yes ? "yes" : "no";
            Debug.Log($"Boopy: input {(Right ? "right" : "left")} hand tracked={Said(hand.IsTracked)} valid={Said(hand.IsDataValid)} confident={Said(hand.IsDataHighConfidence)}.");
        }

        /// <summary>Updates the ray; returns whether the palm faces the eyes (the headset's menu gesture).</summary>
        private bool UpdateRay(Transform head)
        {
            RayActive = false;
            if (!Tracked || hand == null || !TryBone(OVRSkeleton.BoneId.XRHand_Wrist, out var wrist)
                || !TryBone(OVRSkeleton.BoneId.XRHand_Palm, out var palm)
                || !TryBone(OVRSkeleton.BoneId.XRHand_IndexProximal, out var knuckle)
                || !TryBone(OVRSkeleton.BoneId.XRHand_LittleProximal, out var little))
            {
                return false;
            }
            var across = Vector3.Cross(knuckle - wrist, little - wrist);
            var palmNormal = (Right ? -across : across).normalized;
            var posture = new HandPosture(true, Right, ToN(knuckle), ToN(palm), ToN(palmNormal), hand.HandScale);
            var aim = SeatedPointing.Aim(new HeadPose(ToN(head.position), ToN(head.forward)), posture);
            RayActive = aim.Active;
            Ray = new Ray(ToU(aim.Origin), ToU(aim.Direction));
            return aim.PalmFacesHead;
        }

        private bool TryBone(OVRSkeleton.BoneId id, out Vector3 position)
        {
            position = default;
            if (skeleton == null || !skeleton.IsInitialized || !skeleton.IsDataValid) return false;
            if (bones == null || bones.Count == 0)
            {
                bones = new Dictionary<OVRSkeleton.BoneId, Transform>();
                foreach (var bone in skeleton.Bones) bones[bone.Id] = bone.Transform;
            }
            if (!bones.TryGetValue(id, out var transform) || transform == null) return false;
            position = transform.position;
            return true;
        }

        private static N.Vector3 ToN(Vector3 value) => new N.Vector3(value.x, value.y, value.z);

        private static Vector3 ToU(N.Vector3 value) => new Vector3(value.X, value.Y, value.Z);
    }
}
