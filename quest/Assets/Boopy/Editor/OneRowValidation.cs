#nullable enable
using System;
using System.Linq;
using TMPro;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>
    /// Sheets and cards sit on the line's column: the dark panel spans the text column with the line's 12 mm side margin,
    /// and the sheet's own words start on the text column. Synthetic, standard and large.
    /// </summary>
    public static class OneRowValidation
    {
        public static void Run()
        {
            HangulFont.Install();
            foreach (var large in new[] { false, true })
            {
                var root = new GameObject("Synthetic column alignment");
                try
                {
                    var eyes = new GameObject("Eyes").transform;
                    eyes.SetParent(root.transform, false);
                    var console = ContextConsole.Create(root.transform, eyes);
                    console.SetReducedMotion(true);
                    console.Place(Vector3.forward);
                    if (large) console.Activate(ConsoleAction.Size);
                    console.Render(TaskPresentationValidation.Session());
                    console.Activate(ConsoleAction.Options);
                    console.RefreshVisuals(0f);
                    OnColumn(console, large ? "Context sheet, large" : "Context sheet", "Comfort options");
                    console.Activate(ConsoleAction.Review);
                    console.RefreshVisuals(0f);
                    OnColumn(console, large ? "reader, large" : "reader", "Evidence instrument");
                }
                finally { UnityEngine.Object.DestroyImmediate(root); }
            }
            Debug.Log("Boopy column alignment passed: sheets and cards sit on the line's text column (synthetic).");
        }

        // The surface's own words, not a control parked on it.
        private static void OnColumn(ContextConsole console, string when, string name)
        {
            var surface = console.GetComponentsInChildren<SpatialSurface>(true).Single(candidate => candidate.name == name);
            if (!surface.gameObject.activeInHierarchy) throw new InvalidOperationException(when + ": " + name + " is hidden.");
            var plate = surface.GetComponentsInChildren<MeshFilter>(true).Single(filter => filter.name == "Readability island");
            var bounds = plate.sharedMesh.bounds;
            var left = console.transform.InverseTransformPoint(plate.transform.TransformPoint(bounds.min)).x;
            var right = console.transform.InverseTransformPoint(plate.transform.TransformPoint(bounds.max)).x;
            if (Mathf.Abs(left - (SpatialTheme.ShelfLeft - .012f)) >= .001f || Mathf.Abs(right - (SpatialTheme.ShelfLeft + SpatialTheme.ShelfWidth + .012f)) >= .001f)
                throw new InvalidOperationException(when + ": " + name + "'s panel spans x " + left.ToString("0.000") + " to " + right.ToString("0.000")
                    + ", not the text column with the line's 12 mm margins.");
            foreach (var text in surface.GetComponentsInChildren<TextMeshPro>().Where(text =>
                (text.name == "State" || text.name == "Title" || text.name == "Body") && !string.IsNullOrWhiteSpace(text.text)))
            {
                text.ForceMeshUpdate(true, true);
                var start = console.transform.InverseTransformPoint(text.transform.TransformPoint(new Vector3(-text.rectTransform.sizeDelta.x / 2f, 0f, 0f))).x;
                var end = console.transform.InverseTransformPoint(text.transform.TransformPoint(text.textBounds.max)).x;
                if (Mathf.Abs(start - SpatialTheme.ShelfLeft) >= .001f || end > SpatialTheme.ShelfLeft + SpatialTheme.ShelfWidth + .001f)
                    throw new InvalidOperationException(when + ": \"" + text.text + "\" on " + name + " does not sit on the text column ("
                        + start.ToString("0.000") + " to " + end.ToString("0.000") + ").");
            }
        }
    }
}
