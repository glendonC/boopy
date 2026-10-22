#nullable enable
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>Study gestures mapped to metres; each hand remains one detached ellipsoid.</summary>
    public readonly struct CompanionBlobPose
    {
        public readonly Vector3 Position, Scale;
        public readonly Quaternion Rotation;
        private CompanionBlobPose(Vector3 position, Vector3 axis, float stretch)
        {
            Position = new Vector3(position.x, position.y, -position.z) * .04f;
            Rotation = Quaternion.FromToRotation(Vector3.up, new Vector3(axis.x, axis.y, -axis.z).normalized);
            var width = 1f / Mathf.Sqrt(stretch);
            Scale = new Vector3(.016f * width, .020f * stretch, .0144f * width);
        }
        public static CompanionBlobPose At(string state, float age, float greetingAge, bool reduced, float side, Vector2 direction, float speakingActivity = 0f)
        {
            // Small paired hands belong to the silhouette; a real state owns their pose.
            var p = new Vector3(side * 1.15f, -.425f, .24f);
            var axis = new Vector3(side * .12f, 1f, .1f); var stretch = 1f;
            if (state == "listening" && side > 0f)
            { p = new Vector3(1.10f, .10f, .36f); axis = new Vector3(-.20f, 1f, .1f); stretch = .96f; }
            else if (state == "processing")
            { p = new Vector3(side * .98f, -.32f, .55f); axis = new Vector3(-side * .20f, 1f, .1f); stretch = .96f; }
            else if (state == "error")
            { p = new Vector3(side * 1.15f, -.35f, .28f); axis = new Vector3(side * .20f, 1f, .1f); }
            else if (state == "saved")
            { p = new Vector3(side * 1.12f, -.22f, .30f); axis = new Vector3(side * .16f, 1f, .1f); }
            var speech = float.IsNaN(speakingActivity) || float.IsInfinity(speakingActivity)
                ? 0f : Mathf.Clamp01(speakingActivity);
            if (speech > 0f && state != "listening" && state != "processing")
            {
                var beat = reduced ? 0f : speech;
                p = new Vector3(side * 1.13f, -.27f + .07f * beat, .30f);
                axis = new Vector3(side * (.15f + .10f * beat), 1f, .12f);
                stretch = 1f + .04f * beat;
            }
            return new CompanionBlobPose(p, axis, stretch);
        }
    }
}
