#nullable enable
using Boopy.Client;
using UnityEngine;
using N = System.Numerics;

namespace Boopy.Quest
{
    /// <summary>
    /// Converts live Unity poses to the console's room rule: its home in the current view, and whether it stands far from it.
    /// Root owns when to freeze, acceptance of the footprint, and applying placement; this component never moves room labels.
    /// </summary>
    public sealed class FollowConsole : MonoBehaviour
    {
        private readonly ViewFollow motion = new ViewFollow();
        private Transform? viewer;
        private Transform? panel;
        private ContextConsole? controls;
        public bool Ready => viewer != null && panel != null;
        public bool Following => motion.Following;
        public Vector3 DesiredPosition => Target();
        /// <summary>The console's home for the current head pose, where a turn places it and where it comes back to.</summary>
        public Vector3 Home => viewer != null && controls != null ? SessionScene.HomeFor(viewer, controls) : DesiredPosition;

        public void Initialize(Transform head, Transform console)
        {
            viewer = head;
            panel = console;
            controls = console.GetComponent<ContextConsole>();
            motion.Reset();
        }

        /// <summary>True when the console stands more than 30 degrees from <paramref name="home"/>, as seen now.</summary>
        public bool FarFrom(Vector3 home) => viewer != null && panel != null
            && ViewFollow.Reanchors(Pose(), ToNumerics(panel.position), ToNumerics(home));

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
