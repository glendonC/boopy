#nullable enable
using TMPro;
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>
    /// An angle chart for measuring the Quest's own video capture, fixed to the view on black: a centre cross, thin lines
    /// every 5 degrees across and up or down out to 60, numbered every 10 (left and down negative), each line where the
    /// tangent of its angle puts it on a plane a fixed distance ahead of the middle of the eyes, so a rectilinear capture
    /// shows the lines evenly spaced in tangent. The plane is far off, so both eyes see it at nearly the same angles. It
    /// shows when Boopy is launched with the boolean extra <see cref="Extra"/>; nothing else of Boopy runs then.
    /// </summary>
    public sealed class CalibrationView : MonoBehaviour
    {
        public const string Extra = "boopy.calibration";
        public const float Distance = 8f, StepDegrees = 5f, LabelDegrees = 10f, MaxDegrees = 60f;
        // Widths and the numbers' size, in degrees from the eyes.
        private const float FineDegrees = .06f, TenDegrees = .12f, CrossDegrees = .2f, NumberDegrees = 1.2f;

        /// <summary>Where the line at this angle (degrees, right or up positive) lies on the chart's plane.</summary>
        public static float At(float degrees) => Distance * Mathf.Tan(degrees * Mathf.Deg2Rad);

        public static CalibrationView Create(Transform head)
        {
            var go = new GameObject("Calibration view");
            go.transform.SetParent(head, false);
            go.transform.localPosition = new Vector3(0f, 0f, Distance);
            var view = go.AddComponent<CalibrationView>();
            // Black behind everything, past the view's edge in every direction, so neither the room nor Boopy shows.
            var back = new GameObject("Black");
            back.transform.SetParent(go.transform, false);
            back.transform.localPosition = new Vector3(0f, 0f, .5f);
            back.transform.localScale = Vector3.one * (2f * (Distance + .5f) * Mathf.Tan(80f * Mathf.Deg2Rad));
            back.AddComponent<MeshFilter>().sharedMesh = Visuals.Quad();
            var black = back.AddComponent<MeshRenderer>();
            black.sharedMaterial = Visuals.Solid; black.sortingOrder = -20;
            black.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off; black.receiveShadows = false;
            var tint = new MaterialPropertyBlock(); tint.SetColor("_Color", Color.black); black.SetPropertyBlock(tint);
            var reach = At(MaxDegrees);
            var steps = Mathf.RoundToInt(MaxDegrees / StepDegrees);
            for (var i = -steps; i <= steps; i++)
            {
                var degrees = i * StepDegrees;
                var ten = Mathf.Approximately(degrees % LabelDegrees, 0f);
                var width = i == 0 ? CrossDegrees : ten ? TenDegrees : FineDegrees;
                var color = i == 0 ? SpatialTheme.Ember : ten ? SpatialTheme.TextColor : SpatialTheme.Secondary;
                view.Line($"Across {degrees:0}", new Vector3(At(degrees), -reach, 0f), new Vector3(At(degrees), reach, 0f), width, color);
                view.Line($"Up {degrees:0}", new Vector3(-reach, At(degrees), 0f), new Vector3(reach, At(degrees), 0f), width, color);
                if (i == 0 || !ten) continue;
                // Across numbers just above the middle line, up and down numbers just right of it.
                view.Number($"{degrees:0}", new Vector3(At(degrees), Em(NumberDegrees), 0f), TextAlignmentOptions.Bottom);
                view.Number($"{degrees:0}", new Vector3(Em(NumberDegrees) / 2f, At(degrees), 0f), TextAlignmentOptions.Left);
            }
            return view;
        }

        private static float Em(float degrees) => 2f * Distance * Mathf.Tan(degrees * Mathf.Deg2Rad / 2f);

        private void Line(string name, Vector3 from, Vector3 to, float degrees, Color color)
        {
            var host = new GameObject(name);
            host.transform.SetParent(transform, false);
            var line = Visuals.Line(host, Em(degrees), false, Visuals.Solid);
            line.useWorldSpace = false; line.positionCount = 2; line.numCapVertices = 0; line.sortingOrder = 1;
            line.alignment = LineAlignment.TransformZ;
            line.SetPosition(0, from); line.SetPosition(1, to);
            Visuals.Tint(line, color);
        }

        private void Number(string words, Vector3 at, TextAlignmentOptions alignment)
        {
            var text = SpatialTheme.Text(transform, "Number " + words, SpatialTheme.Utility, SpatialTheme.TextColor);
            text.text = words;
            text.alignment = alignment;
            text.textWrappingMode = TextWrappingModes.NoWrap;
            text.rectTransform.sizeDelta = new Vector2(4f, 1f);
            text.rectTransform.pivot = alignment == TextAlignmentOptions.Left ? new Vector2(0f, .5f) : new Vector2(.5f, 0f);
            text.transform.localScale = Vector3.one * (Em(NumberDegrees) / Mathf.Max(1e-5f, text.fontSize / 10f));
            text.transform.localPosition = at;
            text.sortingOrder = 2;
        }

        /// <summary>Whether this launch asked for the chart: the boolean extra on the activity's intent.</summary>
        public static bool Asked()
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            try
            {
                using var player = new AndroidJavaClass("com.unity3d.player.UnityPlayer");
                using var activity = player.GetStatic<AndroidJavaObject>("currentActivity");
                using var intent = activity.Call<AndroidJavaObject>("getIntent");
                return intent != null && intent.Call<bool>("getBooleanExtra", Extra, false);
            }
            catch (System.Exception) { return false; }
#else
            return false;
#endif
        }
    }
}
