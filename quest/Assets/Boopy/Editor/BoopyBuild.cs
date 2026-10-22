#nullable enable
using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>
    /// Builds Boopy's one scene from Meta's prefabs and the development APK, without clicking
    /// through the editor. In the editor: Boopy > Build
    /// Scene and Boopy > Build Quest APK. In batch mode, see quest/README.md.
    /// </summary>
    public static class BoopyBuild
    {
        public const string ScenePath = "Assets/Boopy/Scenes/Boopy.unity";
        public const string ApkPath = "Builds/Boopy.apk";

        /// <summary>OVRCameraRig.prefab in com.meta.xr.sdk.core 207.0.0.</summary>
        private const string CameraRigGuid = "126d619cf4daa52469682f85c1378b4a";

        /// <summary>OVRHandPrefab.prefab in com.meta.xr.sdk.core 207.0.0.</summary>
        private const string HandPrefabGuid = "835e735ca71bf78459fb2cababd74112";

        [MenuItem("Boopy/Build Scene")]
        public static void BuildScene()
        {
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var rig = (GameObject)PrefabUtility.InstantiatePrefab(Load(CameraRigGuid, "OVRCameraRig"), scene);
            rig.name = "OVRCameraRig";
            var hand = Load(HandPrefabGuid, "OVRHandPrefab");
            AddHand(rig, hand, "TrackingSpace/LeftHandAnchor", true);
            AddHand(rig, hand, "TrackingSpace/RightHandAnchor", false);
            var app = new GameObject("Boopy");
            app.AddComponent<BoopyApp>();
            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath) ?? "Assets");
            if (!EditorSceneManager.SaveScene(scene, ScenePath)) throw new InvalidOperationException($"Could not save {ScenePath}.");
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
            AssetDatabase.SaveAssets();
            Debug.Log($"Boopy: built {ScenePath}.");
        }

        /// <summary>
        /// A tracked hand under its anchor: OVRHand for the pinch, OVRSkeleton for the joints the
        /// seated ray needs, with the OpenXR skeleton this project uses. The person sees their real
        /// hands in passthrough, so nothing draws a virtual one.
        /// </summary>
        private static void AddHand(GameObject rig, GameObject prefab, string anchorPath, bool left)
        {
            var anchor = rig.transform.Find(anchorPath)
                ?? throw new InvalidOperationException($"The camera rig has no {anchorPath}.");
            var instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab, anchor);
            // Unpacked, so every value below is written into the scene. As a prefab instance, a value
            // equal to the prefab's in-editor default records no override, and that default is changed
            // in memory by OVRHand.OnValidate, which never runs in a player.
            PrefabUtility.UnpackPrefabInstance(instance, PrefabUnpackMode.Completely, InteractionMode.AutomatedAction);
            instance.name = left ? "LeftHand" : "RightHand";
            Set(instance.GetComponent<OVRHand>(), "HandType", (int)(left ? OVRHand.Hand.HandLeft : OVRHand.Hand.HandRight));
            Set(instance.GetComponent<OVRSkeleton>(), "_skeletonType",
                (int)(left ? OVRSkeleton.SkeletonType.XRHandLeft : OVRSkeleton.SkeletonType.XRHandRight));
            var mesh = instance.GetComponent<OVRMesh>();
            if (mesh != null)
            {
                Set(mesh, "_meshType", (int)(left ? OVRMesh.MeshType.XRHandLeft : OVRMesh.MeshType.XRHandRight));
                mesh.enabled = false;
            }
            foreach (var renderer in instance.GetComponentsInChildren<OVRMeshRenderer>(true)) renderer.enabled = false;
            foreach (var renderer in instance.GetComponentsInChildren<OVRSkeletonRenderer>(true)) renderer.enabled = false;
            foreach (var renderer in instance.GetComponentsInChildren<Renderer>(true)) renderer.enabled = false;
        }

        private static void Set(UnityEngine.Object? target, string property, int value)
        {
            if (target == null) throw new InvalidOperationException($"OVRHandPrefab is missing the component that holds {property}.");
            var serialized = new SerializedObject(target);
            var field = serialized.FindProperty(property)
                ?? throw new InvalidOperationException($"{target.GetType().Name} has no serialized {property}.");
            field.intValue = value;
            serialized.ApplyModifiedPropertiesWithoutUndo();
        }

        private static GameObject Load(string guid, string name)
        {
            var path = AssetDatabase.GUIDToAssetPath(guid);
            return AssetDatabase.LoadAssetAtPath<GameObject>(path)
                ?? throw new InvalidOperationException($"Meta's {name} prefab is missing (guid {guid}); is com.meta.xr.sdk.core 207.0.0 installed?");
        }

        [MenuItem("Boopy/Build Quest APK")]
        public static void BuildApk()
        {
            BuildScene();
            EditorUserBuildSettings.buildAppBundle = false;
            Directory.CreateDirectory(Path.GetDirectoryName(ApkPath) ?? "Builds");
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = new[] { ScenePath },
                locationPathName = ApkPath,
                target = BuildTarget.Android,
                targetGroup = BuildTargetGroup.Android,
                options = BuildOptions.Development,
            });
            var summary = report.summary;
            if (summary.result != BuildResult.Succeeded)
            {
                Fail($"Boopy: the Quest build ended {summary.result} with {summary.totalErrors} errors.");
                return;
            }
            Debug.Log($"Boopy: built {summary.outputPath} ({new FileInfo(summary.outputPath).Length} bytes) in {summary.totalTime}.");
        }

        /// <summary>For batch mode: -executeMethod Boopy.Quest.Editor.BoopyBuild.BuildApkInBatch.</summary>
        public static void BuildApkInBatch()
        {
            try
            {
                BuildApk();
            }
            catch (Exception error)
            {
                Fail($"Boopy: {error.Message}");
            }
        }

        private static void Fail(string message)
        {
            Debug.LogError(message);
            if (Application.isBatchMode) EditorApplication.Exit(1);
            else throw new BuildFailedException(message);
        }
    }
}
