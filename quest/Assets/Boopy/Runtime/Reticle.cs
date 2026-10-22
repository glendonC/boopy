#nullable enable
using Boopy.Client;
using UnityEngine;

namespace Boopy.Quest
{
    public enum ReticleRole { Head, Hand, Capture }

    /// <summary>
    /// A small ring where a ray meets the room or a chip. The Quest 3 has no eye tracking, so
    /// the ring shows where the head is pointing.
    /// </summary>
    public sealed class Reticle : MonoBehaviour
    {
        private const int Segments = 32;
        private const float Radius = 0.008f;

        private LineRenderer? ring;
        private LineRenderer[] corners = System.Array.Empty<LineRenderer>();
        private Transform? head;
        private ReticleRole role;
        private InteractionActivity activity;

        public Vector3 Point { get; private set; }
        public bool OnSurface { get; private set; }

        public static Reticle Create(string name, Transform parent, Transform head, float width = 0.0016f,
            ReticleRole role = ReticleRole.Head)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);
            var reticle = go.AddComponent<Reticle>();
            reticle.head = head;
            reticle.role = role;
            var ringObject = new GameObject("Target ring");
            ringObject.transform.SetParent(go.transform, false);
            reticle.ring = Visuals.Line(ringObject, width, true, Visuals.Solid);
            reticle.ring.useWorldSpace = false;
            if (role == ReticleRole.Capture)
            {
                reticle.corners = new LineRenderer[4];
                for (var i = 0; i < reticle.corners.Length; i++)
                {
                    var bracketObject = new GameObject("Capture corner");
                    bracketObject.transform.SetParent(go.transform, false);
                    var bracket = Visuals.Line(bracketObject, 0.0018f, false, Visuals.Solid);
                    bracket.useWorldSpace = false;
                    bracket.positionCount = 3;
                    var x = i < 2 ? -1f : 1f;
                    var y = i % 2 == 0 ? -1f : 1f;
                    bracket.SetPosition(0, new Vector3(x * 0.010f, y * 0.017f, 0f));
                    bracket.SetPosition(1, new Vector3(x * 0.017f, y * 0.017f, 0f));
                    bracket.SetPosition(2, new Vector3(x * 0.017f, y * 0.010f, 0f));
                    reticle.corners[i] = bracket;
                }
            }
            reticle.DrawActivity();
            return reticle;
        }

        /// <summary>Actual recording/request state, never inferred from the ray or fabricated sensor data.</summary>
        public void SetActivity(bool listening, bool thinking)
        {
            var next = ActivityFeedback.From(listening, thinking);
            if (activity == next) return;
            activity = next;
            DrawActivity();
        }

        private void DrawActivity()
        {
            if (ring == null) return;
            var color = activity == InteractionActivity.Listening ? Visuals.Intent
                : activity == InteractionActivity.Thinking ? Visuals.Confirmed
                : role == ReticleRole.Hand ? Visuals.Confirmed
                : role == ReticleRole.Capture ? Visuals.Intent : Visuals.Reticle;
            if (!OnSurface) color.a *= 0.38f;
            Visuals.Tint(ring, color);
            foreach (var corner in corners) Visuals.Tint(corner, color);
            ring.enabled = role != ReticleRole.Capture || activity != InteractionActivity.Ready;
            ring.transform.localRotation = Quaternion.identity;
            ring.transform.localScale = Vector3.one;
            var thinking = activity == InteractionActivity.Thinking;
            ring.loop = !thinking;
            var diamond = role == ReticleRole.Hand && !thinking;
            ring.positionCount = diamond ? 4 : Segments;
            var radius = role == ReticleRole.Hand ? Radius * 1.25f : Radius;
            for (var i = 0; i < ring.positionCount; i++)
            {
                var angle = thinking ? i * Mathf.PI * 1.4f / (Segments - 1)
                    : i * Mathf.PI * 2f / ring.positionCount;
                ring.SetPosition(i, new Vector3(Mathf.Cos(angle), Mathf.Sin(angle), 0f) * radius);
            }
            AnimateActivity();
        }

        private void AnimateActivity()
        {
            if (ring == null) return;
            if (activity == InteractionActivity.Thinking)
                ring.transform.localRotation = Quaternion.AngleAxis(-Time.unscaledTime * 110f, Vector3.forward);
            else if (activity == InteractionActivity.Listening)
                ring.transform.localScale = Vector3.one * (1f + 0.07f * Mathf.Sin(Time.unscaledTime * 4f));
        }

        /// <summary>Puts the ring at a point, facing the eyes and keeping its apparent size; dim when it found no surface.</summary>
        public void Show(Vector3 point, bool onSurface)
        {
            Point = point;
            var changedSurface = OnSurface != onSurface;
            OnSurface = onSurface;
            gameObject.SetActive(true);
            transform.position = point;
            if (head != null)
            {
                var toEyes = head.position - point;
                if (toEyes.sqrMagnitude > 1e-6f) transform.rotation = Quaternion.LookRotation(-toEyes.normalized, Vector3.up);
                transform.localScale = Vector3.one * Mathf.Clamp(toEyes.magnitude, 0.3f, 4f);
            }
            if (changedSurface) DrawActivity();
        }

        public void Hide() => gameObject.SetActive(false);

        private void LateUpdate()
        {
            if (activity != InteractionActivity.Ready) AnimateActivity();
        }
    }
}
