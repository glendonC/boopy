#nullable enable
using Boopy.Client;
using UnityEngine;
using N = System.Numerics;

namespace Boopy.Quest
{
    /// <summary>
    /// Converts live Unity poses to the compact HUD follow rule. Root owns when to freeze, acceptance
    /// of the proposed footprint, and applying placement; this component never moves room labels.
    /// </summary>
    public sealed class FollowConsole : MonoBehaviour
    {
        private readonly ViewFollow motion = new ViewFollow();
        private Transform? viewer;
        private Transform? panel;
        public bool Ready => viewer != null && panel != null;
        public bool Following => motion.Following;
        public Vector3 DesiredPosition => Target();

        public void Initialize(Transform head, Transform console)
        {
            viewer = head;
            panel = console;
            motion.Reset();
        }

        public Vector3 Target(float yawDegrees = 0f, float pitchDegrees = -20f)
        {
            if (viewer == null) return panel != null ? panel.position : transform.position;
            return ToUnity(ViewFollow.Target(Pose(), yawDegrees, pitchDegrees));
        }

        /// <summary>Returns a candidate only; the caller places it and resolves any label overlap.</summary>
        public Vector3 Advance(Vector3 safeTarget, bool frozen)
        {
            if (viewer == null || panel == null) return transform.position;
            return ToUnity(motion.Step(Pose(), ToNumerics(panel.position), ToNumerics(safeTarget),
                frozen, Time.unscaledDeltaTime));
        }

        public void ResetMotion() => motion.Reset();
        private HeadPose Pose() => new HeadPose(ToNumerics(viewer!.position), ToNumerics(viewer.forward));
        private static N.Vector3 ToNumerics(Vector3 value) => new N.Vector3(value.x, value.y, value.z);
        private static Vector3 ToUnity(N.Vector3 value) => new Vector3(value.X, value.Y, value.Z);
    }
}
