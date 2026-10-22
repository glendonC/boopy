#nullable enable
using System;
using System.IO;
using System.Reflection;
using Boopy.Client;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    public static class CharacterValidation
    {
        [MenuItem("Boopy/Validate Neutral Character")]
        public static void Validate()
        {
            var root = new GameObject("Synthetic character validation");
            var oldReflection = RenderSettings.customReflectionTexture;
            var oldMode = RenderSettings.defaultReflectionMode;
            Cubemap? cube = null;
            try
            {
                var first = CompanionOrb.Create(root.transform);
                var second = CompanionOrb.Create(root.transform);
                second.transform.localPosition = new Vector3(.18f, 0, 0);
                var renderers = first.GetComponentsInChildren<MeshRenderer>(true);
                var lenses = renderers.Where(r => r.name == "Dark expressive eye").ToArray();
                Require(lenses.Length == 2 && lenses.All(r => Mathf.Abs(r.transform.localScale.x - .00744f) < .00001f && r.transform.localScale.z < .0023f), "Eyes no longer match study dimensions.");
                Require(lenses.All(r => Mathf.Abs(r.transform.parent.localPosition.x) < .013f), "Eyes retain oversized lateral placement.");
                Require(!ShaderUtil.ShaderHasError(renderers[0].sharedMaterial.shader), "Character shader has compile errors.");
                Require(renderers.Length == 5, "Expected body, two eyes and two detached blobs only.");
                Require(first.GetComponentsInChildren<Collider>(true).All(c => !c.enabled), "Character has live interaction colliders.");
                var hands = renderers.Where(r => r.name.Contains("detached blob hand")).ToArray();
                Require(hands.Length == 2 && hands.All(h => h.transform.parent == renderers.Single(r => r.name == "Porcelain body").transform.parent), "Hands are not two independent body children.");
                Require(hands.All(h => h.sharedMaterial == renderers.Single(r => r.name == "Porcelain body").sharedMaterial), "Hands and body do not share one material.");
                Require(hands.All(h => h.transform.childCount == 0), "Hands contain anatomy children.");
                var mesh = renderers.Single(r => r.name == "Porcelain body").GetComponent<MeshFilter>().sharedMesh;
                var shellMaterial=renderers.Single(r=>r.name=="Porcelain body").sharedMaterial;
                Require(shellMaterial.GetColor("_BaseColor")==SpatialTheme.Porcelain && shellMaterial.GetColor("_LidColor")==SpatialTheme.Porcelain,"Shell or eyelids retain an independent color cast.");
                Require(shellMaterial.GetFloat("_Roughness")>=.7f,"Porcelain shell retains glossy material intent.");
                Require(mesh.vertexCount == 1025 && mesh.triangles.Length == 5760, "Procedural body topology changed unexpectedly.");
                Require(mesh.vertices.All(v => Finite(v)), "Body has invalid coordinates.");
                var eyeMethod = typeof(CompanionOrb).GetMethod("Eye", BindingFlags.NonPublic | BindingFlags.Instance)!;
                eyeMethod.Invoke(first, new object[] { lenses[0].transform.parent, lenses[0], .035f, 0f, 0f, 0f, 1f });
                Require(lenses[0].transform.localScale.y < .0006f && lenses[0].transform.localScale.x == .00744f, "Blink leaves a large visible lens or lid patch.");
                first.Refresh(0f, true);
                var independent = second.GetComponentsInChildren<MeshRenderer>().Single(r => r.name == "Right detached blob hand").transform;
                var untouched = independent.localPosition;
                foreach (var state in new[] { "idle", "listening", "processing", "review", "saved", "error" })
                {
                    first.SetState(state); first.Refresh(.1f, false);
                    Require(hands.All(h => Finite(h.transform.localPosition) && h.transform.localPosition.magnitude < .09f), "Hand exceeds local comfort envelope.");
                    first.Refresh(0, true);
                    var position = hands.Select(h => h.transform.localPosition).ToArray();
                    var rotation = hands.Select(h => h.transform.localRotation).ToArray();
                    first.Refresh(1, true);
                    Require(hands.Select((h, i) => h.transform.localPosition == position[i] && h.transform.localRotation == rotation[i]).All(v => v), "Reduced motion did not hold hand pose.");
                }
                Require(independent.localPosition == untouched, "One instance changed another instance.");
                first.SetState("idle"); first.ReturnHome(); first.Refresh(0, true);
                var rest = hands.Select(h => h.transform.localPosition).ToArray();
                first.Greet(); first.Refresh(.12f, false);
                Require(hands.Select((h, i) => Vector3.Distance(h.transform.localPosition, rest[i]) < .003f).All(v => v), "Greeting created an unrelated hand wave.");
                // An actual synthetic reflection environment, not screen-space refraction.
                cube = new Cubemap(16, TextureFormat.RGBA32, false);
                for (var face = 0; face < 6; face++) cube.SetPixels(Enumerable.Repeat(face % 2 == 0 ? new Color(.8f,.85f,1f) : new Color(.2f,.16f,.32f), 256).ToArray(), (CubemapFace)face);
                cube.Apply(); RenderSettings.defaultReflectionMode = UnityEngine.Rendering.DefaultReflectionMode.Custom; RenderSettings.customReflectionTexture = cube;
                first.SetState("listening"); first.Refresh(0, true); second.SetState("saved"); second.Refresh(0, true);
                first.SetFrozen(true);
                var body = (Transform)typeof(CompanionOrb).GetField("body", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(first)!;
                var frozenPosition = body.localPosition;
                first.SetState("error"); first.Refresh(.1f, false);
                Require(body.localPosition == frozenPosition, "Targeting freeze moved the character.");
                first.SetFrozen(false);
                var reflected = Render(root);
                // Changing a chromatic environment must not tint the neutral matte character.
                for (var face = 0; face < 6; face++) cube.SetPixels(Enumerable.Repeat(new Color(.01f,.08f,.01f),256).ToArray(),(CubemapFace)face);
                cube.Apply();
                var alternate = Render(root);
                Require(reflected.SequenceEqual(alternate), "Matte neutral companion inherits a chromatic reflection tint.");
                File.WriteAllBytes(Path.Combine(Path.GetTempPath(),"boopy-neutral-character.png"), reflected);
                first.SetState("processing"); first.Refresh(.1f, false);
                var bodyRenderer = renderers.Single(r => r.name == "Porcelain body");
                var activity = new MaterialPropertyBlock(); bodyRenderer.GetPropertyBlock(activity);
                Require(activity.GetFloat("_Activity") == 1f, "Actual processing lacks activity signal.");
                var shimmerBefore = Render(root);
                activity.SetFloat("_Clock", activity.GetFloat("_Clock") + 1.2f); bodyRenderer.SetPropertyBlock(activity);
                var shimmerAfter = Render(root);
                Require(shimmerBefore.SequenceEqual(shimmerAfter), "Processing material contains unrelated periodic glints.");
                first.Refresh(0f, true); bodyRenderer.GetPropertyBlock(activity);
                Require(activity.GetFloat("_Activity") == 0f, "Reduced motion retains animated shimmer.");
                var stillBefore = Render(root); first.Refresh(1f, true);
                Require(stillBefore.SequenceEqual(Render(root)), "Reduced motion render changes over time.");
                first.SetVisible(false); second.SetVisible(false);
                RenderStates(root);

                Debug.Log("Boopy character validation passed: five meshes, detached hands, actual states, independent instances, reduced motion and neutral material and adversarial chromatic-environment render. Device stereo/comfort unverified.");
            }
            finally
            {
                RenderSettings.customReflectionTexture = oldReflection; RenderSettings.defaultReflectionMode = oldMode;
                UnityEngine.Object.DestroyImmediate(root); if (cube != null) UnityEngine.Object.DestroyImmediate(cube);
            }
        }
        private static void RenderStates(GameObject parent)
        {
            var sheet = new GameObject("Synthetic labelled states"); sheet.transform.SetParent(parent.transform);
            var states = new[] { "idle", "listening", "processing", "review", "saved", "error" };
            for (var i = 0; i < states.Length; i++)
            {
                var orb = CompanionOrb.Create(sheet.transform);
                orb.transform.localPosition = new Vector3((i % 3 - 1) * .17f, i < 3 ? .075f : -.075f, 0);
                orb.SetState(states[i]); orb.Refresh(.28f, false);
                var labelObject = new GameObject(states[i] + " label"); labelObject.transform.SetParent(sheet.transform);
                labelObject.transform.localPosition = orb.transform.localPosition + Vector3.down * .06f;
                var label = labelObject.AddComponent<TextMesh>(); label.text = states[i]; label.fontSize = 48; label.characterSize = .002f; label.anchor = TextAnchor.MiddleCenter; label.color = Color.white;
            }
            var cameraObject = new GameObject("State sheet camera"); cameraObject.transform.SetParent(sheet.transform);
            var camera = cameraObject.AddComponent<Camera>(); camera.transform.position = new Vector3(0,0,-.60f); camera.transform.LookAt(Vector3.zero); camera.fieldOfView = 35;
            camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = new Color(.075f,.075f,.10f);
            var target = new RenderTexture(1500,1000,24); var image = new Texture2D(1500,1000,TextureFormat.RGB24,false); var previous = RenderTexture.active;
            try { camera.targetTexture = target; camera.Render(); RenderTexture.active = target; image.ReadPixels(new Rect(0,0,1500,1000),0,0); image.Apply(); File.WriteAllBytes(Path.Combine(Path.GetTempPath(),"boopy-character-states.png"),image.EncodeToPNG()); }
            finally { camera.targetTexture = null; RenderTexture.active = previous; UnityEngine.Object.DestroyImmediate(image); UnityEngine.Object.DestroyImmediate(target); UnityEngine.Object.DestroyImmediate(sheet); }
        }

        private static bool Finite(Vector3 v) => !float.IsNaN(v.x + v.y + v.z) && !float.IsInfinity(v.x + v.y + v.z);
        private static void Require(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
        private static byte[] Render(GameObject root)
        {
            var cameraObject = new GameObject("Synthetic character camera"); cameraObject.transform.SetParent(root.transform);
            var camera = cameraObject.AddComponent<Camera>(); camera.transform.position = new Vector3(.09f, .005f, -.48f); camera.transform.LookAt(new Vector3(.09f,0,0));
            camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = new Color(.075f,.075f,.10f); camera.fieldOfView = 32;
            var target = new RenderTexture(1024, 768, 24); var image = new Texture2D(1024,768,TextureFormat.RGB24,false);
            var previous = RenderTexture.active;
            try { camera.targetTexture = target; camera.Render(); RenderTexture.active = target; image.ReadPixels(new Rect(0,0,1024,768),0,0); image.Apply(); return image.EncodeToPNG(); }
            finally { camera.targetTexture = null; RenderTexture.active = previous; UnityEngine.Object.DestroyImmediate(image); UnityEngine.Object.DestroyImmediate(target); }
        }
    }
}
