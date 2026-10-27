#nullable enable
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>
    /// Where the person pointed on a recording, when the model's only shape for the subject there is its loose box (DESIGN):
    /// a loose box is no shape Boopy knows, so none is drawn. A small Ember ring, about 1.8 degrees across, two device pixels
    /// wide on a two-pixel Graphite halo at 70 percent, with no fill. It pulses once as it appears (a cut with reduced
    /// motion) and stays while the word shows.
    /// </summary>
    public sealed class BoopPin : MonoBehaviour
    {
        public const float Degrees = 1.8f, PulseSeconds = .45f;
        // A Quest 3 pixel is about 0.7 mrad.
        private const float Stroke = .0014f, HaloEach = .0014f, Pulse = .35f;
        private const int Segments = 48;
        private LineRenderer? ring, halo;
        private float pulseAge = float.PositiveInfinity;
        private bool reduced;

        /// <summary>The ring's size in meters, its halo included; its center is its transform's position.</summary>
        public Vector2 Size { get; private set; }

        public static BoopPin Create(Transform parent)
        {
            var go = new GameObject("Boop pin");
            go.transform.SetParent(parent, false);
            var pin = go.AddComponent<BoopPin>();
            pin.halo = pin.Circle("Boop pin halo", new Color(WordBlock.Graphite.r, WordBlock.Graphite.g, WordBlock.Graphite.b, .7f), 1);
            pin.ring = pin.Circle("Boop pin ring", SpatialTheme.Ember, 2);
            go.SetActive(false);
            return pin;
        }

        private LineRenderer Circle(string name, Color color, int order)
        {
            var host = new GameObject(name); host.transform.SetParent(transform, false);
            var line = Visuals.Line(host, Stroke, true, Visuals.Solid);
            line.useWorldSpace = false; line.alignment = LineAlignment.TransformZ; line.positionCount = Segments;
            line.sortingOrder = order;
            Visuals.Tint(line, color);
            return line;
        }

        /// <summary>
        /// Shows the pin at <paramref name="at"/>, lying in the picture's plane (<paramref name="facing"/>), sized for
        /// <paramref name="distance"/> meters from the eyes. It pulses only as it first appears.
        /// </summary>
        public void Show(Vector3 at, Quaternion facing, float distance, bool reducedMotion)
        {
            if (ring == null || halo == null) return;
            reduced = reducedMotion;
            transform.SetPositionAndRotation(at, facing);
            var stroke = Stroke * distance; var outer = HaloEach * distance;
            var radius = distance * Mathf.Tan(Degrees / 2f * Mathf.Deg2Rad) - stroke / 2f - outer;
            for (var i = 0; i < Segments; i++)
            {
                var angle = 2f * Mathf.PI * i / Segments;
                var point = new Vector3(Mathf.Cos(angle), Mathf.Sin(angle), 0f) * radius;
                ring.SetPosition(i, point); halo.SetPosition(i, point + new Vector3(0f, 0f, .0005f));
            }
            ring.widthMultiplier = stroke; halo.widthMultiplier = stroke + 2f * outer;
            var across = 2f * (radius + stroke / 2f + outer);
            Size = new Vector2(across, across);
            if (!gameObject.activeSelf) { pulseAge = reduced ? float.PositiveInfinity : 0f; gameObject.SetActive(true); }
            Refresh(0f);
        }

        public void Hide() => gameObject.SetActive(false);

        private void LateUpdate() => Refresh(Time.unscaledDeltaTime);

        /// <summary>Explicit elapsed time keeps editor checks deterministic.</summary>
        public void Refresh(float elapsed)
        {
            if (!float.IsNaN(elapsed) && elapsed > 0f && pulseAge < PulseSeconds) pulseAge += elapsed;
            var swell = pulseAge < PulseSeconds ? Pulse * Mathf.Sin(pulseAge / PulseSeconds * Mathf.PI) : 0f;
            transform.localScale = Vector3.one * (1f + swell);
        }
    }
}
