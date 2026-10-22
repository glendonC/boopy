#nullable enable
using System;
using Boopy.Client;
using UnityEngine;
using UnityEngine.Rendering;

namespace Boopy.Quest
{
    /// <summary>The neutral porcelain companion with detached blob hands. Only supplied application state drives expression.</summary>
    public sealed class CompanionOrb : MonoBehaviour
    {
        private Transform? body;
        private Transform? leftEye, rightEye;
        private Transform? leftHand, rightHand;
        private MeshRenderer? leftLens, rightLens, leftPalm, rightPalm;
        private MaterialPropertyBlock? eyeBlock, bodyBlock;
        private MeshRenderer? shell;
        private Material? shellMaterial, eyeMaterial;
        private Mesh? bodyMesh;
        private string state = "idle";
        private float clock, stateAt, opacity = 1f;
        private float greetingAt = float.NegativeInfinity;
        private bool frozen, visible = true;
        private float speakingActivity;
        private float leftOpening = .92f, rightOpening = .92f;
        private Vector2 attention;
        private readonly Vector3 dimensions = new Vector3(.08f, .08f, .08f);
        private static readonly int Opacity = Shader.PropertyToID("_Opacity");
        private static readonly int EyeOpen = Shader.PropertyToID("_EyeOpen");
        private static readonly int Clock = Shader.PropertyToID("_Clock");
        private static readonly int Activity = Shader.PropertyToID("_Activity");
        private static readonly int Smile = Shader.PropertyToID("_Smile");

        public static CompanionOrb Create(Transform parent)
        {
            var go = new GameObject("Boopy porcelain companion");
            go.transform.SetParent(parent, false);
            var scout = go.AddComponent<CompanionOrb>();
            var shader = Resources.Load<Shader>("CompanionGlass")
                ?? throw new InvalidOperationException("The bundled Boopy companion shader is missing.");
            scout.shellMaterial = Material(shader, "Matte porcelain shell", SpatialTheme.Porcelain, .72f, 0f);
            scout.eyeMaterial = Material(shader, "Dark neutral lenses", new Color(SpatialTheme.Panel.r*.35f,SpatialTheme.Panel.g*.35f,SpatialTheme.Panel.b*.35f), .28f, 1f);
            scout.eyeBlock = new MaterialPropertyBlock();
            scout.bodyBlock = new MaterialPropertyBlock();
            scout.body = new GameObject("Sculptural body rig").transform;
            scout.body.SetParent(go.transform, false);
            var shell = new GameObject("Porcelain body");
            shell.transform.SetParent(scout.body, false);
            shell.transform.localScale = scout.dimensions;
            scout.bodyMesh = SeedMesh();
            shell.AddComponent<MeshFilter>().sharedMesh = scout.bodyMesh;
            scout.shell = Renderer(shell, scout.shellMaterial);
            scout.leftEye = scout.BuildEye(-.024f, "Left eye");
            scout.rightEye = scout.BuildEye(.024f, "Right eye");
            scout.leftLens = scout.leftEye.GetChild(0).GetComponent<MeshRenderer>();
            scout.rightLens = scout.rightEye.GetChild(0).GetComponent<MeshRenderer>();
            scout.leftHand = scout.BuildHand(-1f);
            scout.rightHand = scout.BuildHand(1f);
            scout.leftPalm = scout.leftHand.GetComponent<MeshRenderer>();
            scout.rightPalm = scout.rightHand.GetComponent<MeshRenderer>();
            scout.Refresh(0f, true);
            return scout;
        }

        private static Material Material(Shader shader, string name, Color color, float roughness, float role)
        {
            var material = new Material(shader) { name = name };
            material.SetColor("_BaseColor", color);
            material.SetColor("_LidColor", SpatialTheme.Porcelain);
            material.SetFloat("_Roughness", roughness);
            material.SetFloat("_Role", role);
            return material;
        }

        private Transform BuildEye(float x, string name)
        {
            var eye = new GameObject(name).transform;
            eye.SetParent(body, false);
            // Study rest split 15.46 degrees and face pitch .1 radian, scaled .04 m/unit.
            var angle = Mathf.Sign(x) * 15.46f * Mathf.Deg2Rad;
            var y = Mathf.Sin(.1f); var unitX = Mathf.Sin(angle) * Mathf.Cos(.1f);
            var z = -Mathf.Sqrt(Mathf.Max(0f, 1f - unitX * unitX - y * y));
            eye.localPosition = new Vector3(unitX * 1.08f * (1f + y * .07f), y + .035f * unitX * unitX, z * .86f) * .04f;
            eye.localRotation = Quaternion.LookRotation(new Vector3(unitX / 1.16f, y, z / .7396f));
            Primitive(eye, "Dark expressive eye", new Vector3(0f, 0f, .00065f), new Vector3(.00744f, .01648f, .00224f), eyeMaterial!);
            return eye;
        }

        private Transform BuildHand(float side) => Primitive(body, side < 0f ? "Left detached blob hand" : "Right detached blob hand",
            new Vector3(side * .046f, -.017f, -.0096f), new Vector3(.016f, .020f, .0144f), shellMaterial!);

        private static Transform Primitive(Transform? parent, string name, Vector3 position, Vector3 scale, Material material)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            go.name = name;
            go.transform.SetParent(parent, false);
            go.transform.localPosition = position;
            go.transform.localScale = scale;
            var collider = go.GetComponent<Collider>();
            collider.enabled = false;
            Dispose(collider);
            var renderer = go.GetComponent<MeshRenderer>();
            renderer.sharedMaterial = material;
            renderer.shadowCastingMode = ShadowCastingMode.Off;
            renderer.receiveShadows = false;
            return go.transform;
        }

        private static MeshRenderer Renderer(GameObject go, Material material)
        {
            var renderer = go.AddComponent<MeshRenderer>();
            renderer.sharedMaterial = material;
            renderer.shadowCastingMode = ShadowCastingMode.Off;
            renderer.receiveShadows = false;
            return renderer;
        }

        private static Mesh SeedMesh()
        {
            const int rings = 24, segments = 40;
            var vertices = new Vector3[(rings + 1) * (segments + 1)];
            var indices = new int[rings * segments * 6];
            for (var ring = 0; ring <= rings; ring++)
            {
                var theta = Mathf.PI * ring / rings;
                var y = Mathf.Cos(theta);
                var radius = Mathf.Sin(theta);
                for (var segment = 0; segment <= segments; segment++)
                {
                    var phi = Mathf.PI * 2f * segment / segments;
                    var x = Mathf.Cos(phi) * radius;
                    var z = Mathf.Sin(phi) * radius;
                    vertices[ring * (segments + 1) + segment] = new Vector3(x * 1.08f * (1f + y * .07f), y + .035f * x * x, z * .86f) * .5f;
                }
            }
            var at = 0;
            for (var ring = 0; ring < rings; ring++)
            for (var segment = 0; segment < segments; segment++)
            {
                var a = ring * (segments + 1) + segment;
                var b = a + segments + 1;
                indices[at++] = a; indices[at++] = a + 1; indices[at++] = b;
                indices[at++] = a + 1; indices[at++] = b + 1; indices[at++] = b;
            }
            var mesh = new Mesh { name = "Companion body surface" };
            mesh.vertices = vertices;
            mesh.triangles = indices;
            mesh.RecalculateNormals();
            mesh.RecalculateBounds();
            return mesh;
        }

        public void SetState(string next)
        {
            // Validate without creating Unity objects or relying on inferred model activity.
            CompanionExpression.At(next, 0f, 0f, true);
            if (state == next) return;
            state = next;
            stateAt = clock;
            if (state != "idle") greetingAt = float.NegativeInfinity;
            if (state == "listening" || state == "processing") speakingActivity = 0f;
        }

        /// <summary>Normalized real playback energy; zero ends the speech pose. No text or synthesis inference.</summary>
        public void SetSpeaking(float activity) => speakingActivity = !visible || state == "listening" || state == "processing" || float.IsNaN(activity) || float.IsInfinity(activity)
            ? 0f : Mathf.Clamp01(activity);
        /// <summary>One real visible opening acknowledgment; caller owns first-opening eligibility.</summary>
        public void Greet() { if (visible && state == "idle") greetingAt = clock; }
        public void SetFrozen(bool value) => frozen = value;
        public void SetVisible(bool value)
        {
            if (visible == value) return;
            visible = value;
            if (body != null) body.gameObject.SetActive(value);
            if (!value) { speakingActivity = 0f; greetingAt = float.NegativeInfinity; }
            stateAt = clock - 1f;
        }

        /// <summary>Looks toward real selected evidence without leaving the anchored silhouette.</summary>
        public void FlyToward(Vector3 localDirection)
        {
            SetAttention(localDirection);
        }

        public void ReturnHome()
        {
            attention = Vector2.zero;
        }

        /// <summary>Shared body-and-hand tint; it adds no agent/model identity.</summary>
        public void SetTint(Color color)
        {
            foreach (var material in new[] { shellMaterial })
                if (material != null) { material.SetColor("_BaseColor", color); material.SetColor("_LidColor", color); }
        }
        public void SetOpacity(float value)
        {
            var next = Mathf.Clamp01(value);
            if (Mathf.Approximately(next, opacity)) return;
            opacity = next;
            if (shellMaterial != null) shellMaterial.SetFloat(Opacity, opacity);
            if (eyeMaterial != null) eyeMaterial.SetFloat(Opacity, opacity);
        }

        /// <summary>Direction in companion-local coordinates. Front is local -Z; gaze is bounded.</summary>
        public void SetAttention(Vector3 targetLocal)
        {
            if (!float.IsNaN(targetLocal.x) && !float.IsNaN(targetLocal.y) && !float.IsNaN(targetLocal.z)
                && !float.IsInfinity(targetLocal.x) && !float.IsInfinity(targetLocal.y) && !float.IsInfinity(targetLocal.z))
            {
                var depth = Mathf.Max(.05f, Mathf.Abs(targetLocal.z));
                attention = new Vector2(Mathf.Clamp(targetLocal.x / depth, -1f, 1f),
                    Mathf.Clamp(targetLocal.y / depth, -1f, 1f));
            }
            else attention = Vector2.zero;
        }

        /// <summary>Only collider-free rig parts move; parent placement and interaction targets stay fixed.</summary>
        public void Refresh(float delta, bool reduced)
        {
            if (body == null || shell == null || bodyBlock == null || eyeBlock == null) return;
            if (!visible || opacity <= .001f)
            {
                return;
            }
            if (float.IsNaN(delta) || float.IsInfinity(delta)) delta = 0f;
            delta = Mathf.Max(0f, delta);
            // Consume a reduced-motion opening rather than queue a future animated greeting.
            if (reduced) greetingAt = float.NegativeInfinity;
            if (!reduced) clock += Mathf.Max(0f, delta);
            var pose = CompanionExpression.At(state, clock, clock - stateAt, reduced, attention.x, attention.y, clock - greetingAt, speakingActivity);
            var greetingAge = clock - greetingAt;
            var greeting = state == "idle" && !reduced && greetingAge >= 0f && greetingAge < .65f
                ? Mathf.Sin(greetingAge / .65f * Mathf.PI) : 0f;
            // An outstanding request owns this considering performance. It is not
            // idle decoration, source scanning, speech or a claim of task progress.
            var considering = state == "processing" && !reduced
                ? .5f - .5f * Mathf.Cos(Mathf.Max(0f, clock - stateAt) * (Mathf.PI * 2f / 3.2f)) : 0f;
            var blend = reduced ? 1f : 1f - Mathf.Exp(-Mathf.Max(0f, delta) * 18f);
            // Reading pins translation, not responsiveness. Collider-free pose/eyes/hands
            // still acknowledge real input, requests and playback at the fixed anchor.
            if (!frozen)
                body.localPosition = Vector3.Lerp(body.localPosition, Vector3.up * (pose.Lift + .0015f * considering), blend);
            body.localRotation = Quaternion.Slerp(body.localRotation,
                Quaternion.Euler(pose.Pitch + 2.5f * considering - 6f * greeting, pose.Yaw, pose.Roll + 2f * considering), blend);
            var height = pose.Stretch + .018f * considering + .012f * greeting;
            var stretch = new Vector3(1f / Mathf.Sqrt(height), height, 1f / Mathf.Sqrt(height));
            body.localScale = Vector3.Lerp(body.localScale, stretch, blend);
            leftOpening = reduced ? pose.LeftEye : Mathf.MoveTowards(leftOpening, Mathf.Lerp(pose.LeftEye * (1f - .24f * considering),1f,greeting), delta * 16f);
            rightOpening = reduced ? pose.RightEye : Mathf.MoveTowards(rightOpening, Mathf.Lerp(pose.RightEye * (1f - .10f * considering),1f,greeting), delta * 16f);
            var lookX = Mathf.Lerp(pose.LookX, .02f, considering * .6f);
            var lookY = Mathf.Clamp(pose.LookY + .08f * considering, -.18f, .18f);
            Eye(leftEye, leftLens, leftOpening, lookX, lookY, pose.Smile, blend);
            Eye(rightEye, rightLens, rightOpening, lookX, lookY, pose.Smile, blend);
            Hand(leftHand, -1f, reduced, blend, considering);
            Hand(rightHand, 1f, reduced, blend, considering);
            bodyBlock.SetFloat(Clock, clock);
            bodyBlock.SetFloat(Activity, state == "processing" && !reduced ? 1f : 0f);
            shell.SetPropertyBlock(bodyBlock);
            leftPalm?.SetPropertyBlock(bodyBlock);
            rightPalm?.SetPropertyBlock(bodyBlock);
        }

        private void Eye(Transform? rig, MeshRenderer? renderer, float opening, float x, float y, float smile, float blend)
        {
            if (rig == null || renderer == null || eyeBlock == null) return;
            rig.localRotation = Quaternion.Slerp(rig.localRotation, Quaternion.LookRotation(new Vector3(rig.localPosition.x / 1.16f, rig.localPosition.y, rig.localPosition.z / .7396f)) * Quaternion.Euler(y * -24f, x * -30f, 0f), blend);
            renderer.transform.localPosition = Vector3.Lerp(renderer.transform.localPosition,
                new Vector3(x * .002f, y * .002f, .00065f), blend);
            // Close the small dark surface mesh itself; never paint an opaque lid disk.
            renderer.transform.localScale = new Vector3(.00744f, .01648f * Mathf.Clamp(opening, .035f, 1f), .00224f);
            eyeBlock.SetFloat(EyeOpen, opening);
            eyeBlock.SetFloat(Smile, smile);
            renderer.SetPropertyBlock(eyeBlock);
        }

        private void Hand(Transform? hand, float side, bool reduced, float blend, float considering)
        {
            if (hand == null) return;
            var pose = CompanionBlobPose.At(state, clock - stateAt, clock - greetingAt, reduced, side, attention, speakingActivity);
            var position = state == "processing" && side > 0f
                ? new Vector3(.035f, .012f + .002f * considering, -.029f) : pose.Position;
            var rotation = state == "processing" && side > 0f
                ? Quaternion.Euler(0f, 0f, 26f + 6f * considering) : pose.Rotation;
            hand.localPosition = Vector3.Lerp(hand.localPosition, position, blend);
            hand.localRotation = Quaternion.Slerp(hand.localRotation, rotation, blend);
            hand.localScale = Vector3.Lerp(hand.localScale, pose.Scale, blend);
        }

        private static void Dispose(UnityEngine.Object value)
        {
            if (Application.isPlaying) Destroy(value); else DestroyImmediate(value);
        }

        private void OnDestroy()
        {
            if (bodyMesh != null) Dispose(bodyMesh);
            foreach (var material in new[] { shellMaterial, eyeMaterial })
                if (material != null) Dispose(material);
        }
    }
}
