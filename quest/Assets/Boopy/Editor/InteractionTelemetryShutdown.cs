#nullable enable
using System;
using System.Reflection;
using UnityEditor;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    // SDK 207 initializes native telemetry in edit mode without registering its shutdown.
    // On batch-mode macOS, drop that telemetry when the editor quits. Check the SDK before changing this.
    [InitializeOnLoad]
    internal static class InteractionTelemetryShutdown
    {
        static InteractionTelemetryShutdown()
        {
            if (Application.isBatchMode && Application.platform == RuntimePlatform.OSXEditor)
                EditorApplication.quitting += OnQuitting;
        }

        private static void OnQuitting()
        {
            const string name = "Oculus.Interaction.Telemetry.ISDKEngineTelemetryNative";
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                var wrapper = assembly.GetType(name, false);
                if (wrapper == null) continue;
                try
                {
                    var package = UnityEditor.PackageManager.PackageInfo.FindForAssembly(assembly);
                    var version = wrapper.GetField("ExpectedNativeVersion", BindingFlags.Public | BindingFlags.Static);
                    if (package?.name != "com.meta.xr.sdk.interaction" || package.version != "207.0.0"
                        || version?.IsLiteral != true || !Equals(version.GetRawConstantValue(), "1.207.0"))
                    {
                        Debug.LogWarning("Boopy: Interaction SDK editor shutdown workaround requires version review.");
                        return;
                    }
                    var shutdown = wrapper.GetMethod("ShutDown", BindingFlags.Public | BindingFlags.Static,
                        null, Type.EmptyTypes, null);
                    if (shutdown == null || shutdown.ReturnType != typeof(void))
                        throw new MissingMethodException();
                    // The SDK checks and clears its own _initialized flag. Calling this after
                    // its play-mode quit handler is therefore a no-op; never bypass that guard.
                    shutdown.Invoke(null, null);
                    Debug.Log("Boopy: Interaction SDK editor telemetry shutdown requested.");
                }
                catch (Exception)
                {
                    // Keep diagnostics bounded; exception text can contain local paths.
                    Debug.LogError("Boopy: Interaction SDK editor telemetry shutdown failed.");
                }
                return;
            }
        }
    }
}
