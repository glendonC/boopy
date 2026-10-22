#nullable enable
using System;
using System.IO;
using System.Linq;
using Boopy.Client;
using TMPro;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    public static class ManualHandoffValidation
    {
        private const string PreparationId = "11111111-1111-4111-8111-111111111111";
        public static void Validate()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            HangulFont.Install();
            var root = new GameObject("Synthetic manual handoff");
            try
            {
                var eyes = new GameObject("Synthetic eyes").transform; eyes.SetParent(root.transform, false);
                var console = ContextConsole.Create(root.transform, eyes); console.Place(new Vector3(0, 0, 1));
                var view = new SessionView { Id = "synthetic-saved", State = "committed", Committed = new Committed { PackageId = "ctx_mgpun9ab1z2x3y", Summary = "Synthetic saved account" } };
                console.Render(view); console.Activate(ConsoleAction.Options); console.RefreshVisuals(1f); Physics.SyncTransforms();
                var handoff = console.GetComponentsInChildren<SpatialAction>(true).Single(action => action.Action == ConsoleAction.Handoff);
                Require(handoff.gameObject.activeInHierarchy, "Saved receipt lacks manual handoff entry.");
                var ray = new Ray(eyes.position, handoff.transform.position - eyes.position);
                Require(console.HitAction(ray, out _) == ConsoleAction.Handoff && console.CanRelease(ConsoleAction.Handoff, ray), "Manual handoff hit bounds overlap or disappear.");
                console.Activate(ConsoleAction.Handoff); console.SetHandoffState("prepared-local", PreparationId); console.RefreshVisuals(1f);
                var card = console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Evidence instrument");
                Require(card.gameObject.activeInHierarchy && card.BodyText.Contains("Context ID: ctx_mgpun9ab1z2x3y"), "Full exact selected receipt ID absent from handoff card.");
                Require(card.BodyText.Contains("Prepared on your Mac") && card.BodyText.Contains("Not sent yet") && !card.BodyText.Contains("export this context"), "Prepared path implies delivery or still requires CLI export.");
                Require(card.GetComponentsInChildren<TextMeshPro>(true).Single(text=>text.name=="Title").text == "Ready on your Mac",
                    "Prepared handoff lacks its local destination title.");
                Require(!card.BodyText.Contains("latest context") && !card.BodyText.Contains("Connect Boopy"), "Unverified connector instruction survived.");
                foreach (var state in new[] { "prepared-local", "changed" })
                {
                    console.SetHandoffState(state, PreparationId);
                    foreach (var large in new[] { false, true })
                    {
                        if ((console.ComfortScale > 1f) != large) console.Activate(ConsoleAction.Size);
                        console.RefreshVisuals(1f);
                        ValidateFullCopy(card, view.Committed.PackageId, console.HandoffStatusWords, PreparationId);
                        Render(console, eyes, state + "-" + (large ? "large" : "standard"));
                    }
                }
                var originalPackage = view.Committed.PackageId;
                var otherView = new SessionView { Id = "synthetic-other-saved", State = "committed", Committed = new Committed { PackageId = "ctx_mgpun9ab9q8w7e", Summary = "Different synthetic saved account" } };
                console.Render(otherView); console.Activate(ConsoleAction.Handoff); console.RefreshVisuals(1f);
                ValidateFullCopy(card, otherView.Committed.PackageId, console.HandoffStatusWords);
                Require(!card.BodyText.Contains(originalPackage), "Handoff displays a previous package instead of the selected receipt.");
                console.Render(view); console.Activate(ConsoleAction.Handoff); console.RefreshVisuals(1f);
                ValidateFullCopy(card, originalPackage, console.HandoffStatusWords);

                foreach (var text in card.GetComponentsInChildren<TextMeshPro>()) Require(!text.isTextOverflowing, "Manual handoff text exceeds its rendered bounds.");
                Require(view.Committed.PackageId == "ctx_mgpun9ab1z2x3y" && view.State == "committed", "Opening handoff mutated the receipt.");
                console.Activate(ConsoleAction.Back);
                Require(!card.gameObject.activeInHierarchy && !handoff.gameObject.activeInHierarchy, "Back failed to restore quiet conversation tools.");
                view.Committed.PackageId = new string('x', 1000); console.Render(view); console.Activate(ConsoleAction.Handoff);
                Require(card.BodyText.Contains("ID unavailable") && !card.BodyText.Contains(new string('x', 100)), "Unbounded ID was fitted or silently truncated as usable.");
                Debug.Log("Boopy manual handoff validation passed (synthetic local receipt; no delivery claimed).");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }
        private static void ValidateFullCopy(SpatialSurface card, string packageId, string statusWords, string? requestId = null)
        {
            var preparation = requestId == null ? "" : $"Preparation ID: {requestId}\n";
            var expected = $"Context ID: {packageId}\n{preparation}{statusWords}";
            Require(card.BodyText == expected, "Manual handoff silently truncates its exact ID or full instructions.");
            var body = card.GetComponentsInChildren<TextMeshPro>(true).Single(text => text.name == "Body");
            body.ForceMeshUpdate(true, true);
            Require(!body.isTextOverflowing && body.fontSize == SpatialTheme.Body, "Manual handoff overflows or shrinks the reading font.");
            var glyphs = body.textInfo.characterInfo.Take(body.textInfo.characterCount).ToArray();
            Require(glyphs.Length == expected.Length, "Full handoff copy lacks glyph entries.");
            foreach (var glyph in glyphs.Where(glyph => !char.IsWhiteSpace(glyph.character)))
                Require(glyph.isVisible && glyph.textElement != null && glyph.textElement.unicode == glyph.character && (glyph.topRight-glyph.bottomLeft).sqrMagnitude > 0,
                    "Manual handoff contains missing or invisible glyph geometry.");
            var finalStart = expected.IndexOf("Not sent yet.", StringComparison.Ordinal);
            Require(glyphs.Where(glyph => glyph.index >= finalStart && !char.IsWhiteSpace(glyph.character)).All(glyph => glyph.isVisible), "Final no-delivery/advisory copy is not visibly rendered.");
        }

        private static void Render(ContextConsole console, Transform eyes, string scale)
        {
            var camera = eyes.GetComponent<Camera>();
            if (camera == null) camera = eyes.gameObject.AddComponent<Camera>();
            camera.fieldOfView = 58; camera.aspect = 1f; camera.nearClipPlane = .05f;
            camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = new Color(.15f, .17f, .19f); camera.allowHDR = false; camera.allowMSAA = false;
            foreach (var text in console.GetComponentsInChildren<TextMeshPro>()) text.ForceMeshUpdate(true, true);
            var body = console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Evidence instrument").GetComponentsInChildren<TextMeshPro>(true).Single(text => text.name == "Body");
            foreach (var glyph in body.textInfo.characterInfo.Take(body.textInfo.characterCount).Where(glyph => glyph.isVisible))
                foreach (var corner in new[] { glyph.bottomLeft, glyph.topRight })
                {
                    var at = camera.WorldToViewportPoint(body.transform.TransformPoint(corner));
                    Require(at.z > 0 && at.x >= 0 && at.x <= 1 && at.y >= 0 && at.y <= 1, "Actual-scale handoff glyph falls outside the rendered viewport.");
                }
            var bodyArea = GlyphArea(body, camera);
            var title = body.transform.parent.GetComponentsInChildren<TextMeshPro>().Single(text => text.name == "Title");
            Require(!bodyArea.Overlaps(GlyphArea(title, camera)), "Handoff body overlaps its title.");
            foreach (var action in console.GetComponentsInChildren<SpatialAction>())
            {
                var box = action.GetComponent<BoxCollider>();
                if (!box.enabled) continue;
                var corners = new System.Collections.Generic.List<Vector2>();
                foreach (var x in new[] { -1f, 1f }) foreach (var y in new[] { -1f, 1f }) foreach (var z in new[] { -1f, 1f })
                {
                    var world = box.transform.TransformPoint(box.center + Vector3.Scale(box.size / 2f, new Vector3(x, y, z)));
                    var point = camera.WorldToViewportPoint(world); corners.Add(new Vector2(point.x, point.y));
                }
                var targetArea = Rect.MinMaxRect(corners.Min(point => point.x), corners.Min(point => point.y), corners.Max(point => point.x), corners.Max(point => point.y));
                Require(!bodyArea.Overlaps(targetArea), "Handoff reading text overlaps the " + action.Action + " control target.");
            }
            var target = new RenderTexture(1000, 1000, 24); target.Create(); var image = new Texture2D(1000, 1000, TextureFormat.RGB24, false); var prior = RenderTexture.active;
            try { camera.targetTexture = target; camera.Render(); RenderTexture.active = target; image.ReadPixels(new Rect(0, 0, 1000, 1000), 0, 0); image.Apply(); var path = Path.Combine(Path.GetTempPath(), "boopy-manual-handoff-" + scale + ".png"); File.WriteAllBytes(path, image.EncodeToPNG()); Debug.Log("Boopy manual handoff synthetic render: " + path); }
            finally { camera.targetTexture = null; RenderTexture.active = prior; UnityEngine.Object.DestroyImmediate(target); UnityEngine.Object.DestroyImmediate(image); }
        }
        private static Rect GlyphArea(TextMeshPro text, Camera camera)
        {
            var points = text.textInfo.characterInfo.Take(text.textInfo.characterCount).Where(glyph => glyph.isVisible)
                .SelectMany(glyph => new[] { glyph.bottomLeft, glyph.topRight })
                .Select(point => camera.WorldToViewportPoint(text.transform.TransformPoint(point))).ToArray();
            Require(points.Length > 0, "Handoff text has no visible glyph bounds.");
            return Rect.MinMaxRect(points.Min(point => point.x), points.Min(point => point.y), points.Max(point => point.x), points.Max(point => point.y));
        }
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
