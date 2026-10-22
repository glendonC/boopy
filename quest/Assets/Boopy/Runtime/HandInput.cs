#nullable enable
using System.Collections.Generic;
using Boopy.Client;
using UnityEngine;
using N = System.Numerics;

namespace Boopy.Quest
{
    /// <summary>
    /// One tracked hand: its index pinch as taps and holds, and a ray a seated person can point
    /// with. The SDK ray needs the hand held up near shoulder height, so this one does not use it.
    /// The palm's facing comes from the knuckle positions, not from joint axes, so it does not
    /// depend on any skeleton's axis conventions.
    /// </summary>
    public sealed class HandInput
    {
        private readonly OVRHand? hand;
        private readonly OVRSkeleton? skeleton;
        private Dictionary<OVRSkeleton.BoneId, Transform>? bones;
        private string? reportedBlock;

        public HandInput(bool right, OVRHand? hand, OVRSkeleton? skeleton)
        {
            Right = right;
            this.hand = hand;
            this.skeleton = skeleton;
        }

        public bool Right { get; }
        public PinchGesture Gesture { get; } = new PinchGesture();
        public bool RayActive { get; private set; }
        public Ray Ray { get; private set; }
        public bool Tracked { get; private set; }
        /// <summary>A newly blocked pinch attempt this update, for a brief hint to the person.</summary>
        public string? BlockedAttempt { get; private set; }

        /// <summary>Reads the hand once a frame; returns what its pinch did.</summary>
        public PinchEvent Update(Transform head, float now, bool inputAllowed)
        {
            BlockedAttempt = null;
            Tracked = inputAllowed && hand != null && hand.IsTracked && hand.IsDataHighConfidence;
            var rawStrength = hand != null ? hand.GetFingerPinchStrength(OVRHand.HandFinger.Index) : 0f;
            var strength = Tracked ? rawStrength : 0f;
            var palmFacesHead = UpdateRay(head);
            var system = hand != null && hand.IsSystemGestureInProgress || palmFacesHead;
            var pinch = Gesture.Update(Tracked, strength, system, now);
            var blocked = !inputAllowed ? "focus" : hand == null ? "missing-hand"
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
