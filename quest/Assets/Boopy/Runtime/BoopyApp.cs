#nullable enable
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>
    /// The loop on the headset. A session comes up and shows the product.
    /// The headset draws. The Mac decides what anything means.
    /// </summary>
    public sealed class BoopyApp : MonoBehaviour
    {
        private void Start()
        {
            var rig = FindAnyObjectByType<OVRCameraRig>();
            if (rig == null)
            {
                Debug.LogError("Boopy: the scene has no OVRCameraRig. Run Boopy > Build Scene.");
                enabled = false;
                return;
            }
            var head = rig.centerEyeAnchor;
            var room = gameObject.AddComponent<RoomCamera>();
            SessionScene.Create(transform, room, head);
            var status = StatusLine.Create(transform, head, Visuals.Quad());
            status.Say("Your AI, in your world.");
        }
    }
}
