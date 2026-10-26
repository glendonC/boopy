#nullable enable
using System;
using System.Linq;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>
    /// The angle chart for measuring the Quest's own capture: every line at its exact angle from the eyes, every tenth
    /// numbered, black past the view's edge, and fixed to the view when the head turns. No launch extra in the editor.
    /// </summary>
    public static class CalibrationViewValidation
    {
        public static void Validate()
        {
            GameObject? eyes = null;
            try
            {
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                eyes = new GameObject("Synthetic eyes");
                eyes.transform.SetPositionAndRotation(new Vector3(.3f, 1.6f, -.2f), Quaternion.Euler(-8f, 25f, 3f));
                var chart = CalibrationView.Create(eyes.transform);
                Require(!CalibrationView.Asked(), "The editor launch asks for the chart.");
                Require(chart.transform.parent == eyes.transform, "The chart is not fixed to the view.");
                var lines = chart.GetComponentsInChildren<LineRenderer>(true);
                var steps = Mathf.RoundToInt(CalibrationView.MaxDegrees / CalibrationView.StepDegrees);
                Require(lines.Length == 2 * (2 * steps + 1), $"The chart has {lines.Length} lines, not one every 5 degrees both ways.");
                // Each line's middle, seen from the eyes, at its angle across or up; the head turns and it stays there.
                foreach (var turned in new[] { false, true })
                {
                    if (turned) eyes.transform.rotation = Quaternion.Euler(20f, -40f, -6f);
                    for (var i = -steps; i <= steps; i++)
                    {
                        var degrees = i * CalibrationView.StepDegrees;
                        foreach (var (name, across) in new[] { ($"Across {degrees:0}", true), ($"Up {degrees:0}", false) })
                        {
                            var line = lines.Single(found => found.name == name);
                            var middle = eyes.transform.InverseTransformPoint(line.transform.TransformPoint((line.GetPosition(0) + line.GetPosition(1)) / 2f));
                            var angle = Mathf.Atan2(across ? middle.x : middle.y, middle.z) * Mathf.Rad2Deg;
                            Require(Mathf.Abs(angle - degrees) < .01f, $"{name} lies at {angle:0.000} degrees.");
                            var start = line.transform.TransformPoint(line.GetPosition(0)); var end = line.transform.TransformPoint(line.GetPosition(1));
                            var reach = Mathf.Atan2(CalibrationView.At(CalibrationView.MaxDegrees), CalibrationView.Distance) * Mathf.Rad2Deg;
                            var span = Mathf.Atan2(Mathf.Abs(across ? eyes.transform.InverseTransformPoint(end).y : eyes.transform.InverseTransformPoint(end).x), CalibrationView.Distance) * Mathf.Rad2Deg;
                            Require(Mathf.Abs(span - reach) < .01f && Vector3.Distance(start, end) > 0f, $"{name} does not run out to 60 degrees.");
                        }
                    }
                }
                var numbers = chart.GetComponentsInChildren<TextMeshPro>(true).Select(text => text.text).OrderBy(text => text).ToArray();
                var expected = Enumerable.Range(-6, 13).Where(i => i != 0).SelectMany(i => new[] { (i * 10).ToString(), (i * 10).ToString() }).OrderBy(text => text).ToArray();
                Require(numbers.SequenceEqual(expected), "The chart is not numbered every 10 degrees both ways: " + string.Join(" ", numbers));
                var back = chart.GetComponentsInChildren<MeshRenderer>(true).Single(renderer => renderer.name == "Black");
                var half = Mathf.Atan2(back.transform.localScale.x / 2f, back.transform.localPosition.z + CalibrationView.Distance) * Mathf.Rad2Deg;
                Require(half > 75f && back.sortingOrder < lines.Min(line => line.sortingOrder), $"The black reaches {half:0.0} degrees, or draws over the lines.");
                Debug.Log("Boopy calibration view validation passed (synthetic eyes; no device).");
            }
            catch (Exception error)
            {
                Debug.LogException(error);
                if (Application.isBatchMode) EditorApplication.Exit(1);
                else throw;
            }
            finally { if (eyes != null) UnityEngine.Object.DestroyImmediate(eyes); }
        }

        private static void Require(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
        }
    }
}
