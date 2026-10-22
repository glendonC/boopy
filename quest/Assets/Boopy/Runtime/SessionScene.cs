#nullable enable
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>
    /// The session in the room. It comes up with the headset and holds the scene for the product.
    /// </summary>
    public sealed class SessionScene : MonoBehaviour
    {
        private RoomCamera? room;
        private Transform? head;
        private Mesh? quad;

        public static SessionScene Create(Transform parent, RoomCamera room, Transform head)
        {
            var go = new GameObject("Session");
            go.transform.SetParent(parent, false);
            var scene = go.AddComponent<SessionScene>();
            scene.room = room;
            scene.head = head;
            scene.quad = Visuals.Quad();
            return scene;
        }
    }
}
