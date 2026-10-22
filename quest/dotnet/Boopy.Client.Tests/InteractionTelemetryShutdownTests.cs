using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.CompilerServices;
using NUnit.Framework;

// Compile the actual editor hook against a minimal lifecycle surface. The fake vendor
// wrapper models the verified SDK's guarded ownership of native shutdown.
namespace UnityEngine
{
    public enum RuntimePlatform { OSXEditor }
    public static class Application
    {
        public static bool isBatchMode = true;
        public static RuntimePlatform platform = RuntimePlatform.OSXEditor;
    }
    public static class Debug
    {
        public static readonly List<string> Messages = new();
        public static void Log(string message) => Messages.Add(message);
        public static readonly List<string> Warnings = new();
        public static readonly List<string> Errors = new();
        public static void LogWarning(string message) => Warnings.Add(message);
        public static void LogError(string message) => Errors.Add(message);
    }
}
namespace UnityEditor
{
    public sealed class InitializeOnLoadAttribute : Attribute { }
    // Unity also defines this legacy name; keep it present to catch ambiguous imports.
    public sealed class PackageInfo { }
    public static class EditorApplication
    {
        public static event Action? quitting;
        public static void Quit() => quitting?.Invoke();
    }
}
namespace UnityEditor.PackageManager
{
    public sealed class PackageInfo
    {
        public string name = "com.meta.xr.sdk.interaction";
        public string version = "207.0.0";
        public static PackageInfo Current = new();
        public static PackageInfo FindForAssembly(Assembly assembly) => Current;
    }
}
namespace Oculus.Interaction.Telemetry
{
    internal static class ISDKEngineTelemetryNative
    {
        public const string ExpectedNativeVersion = "1.207.0";
        public static bool Initialized;
        public static int NativeShutdownCalls;
        public static bool Throw;
        public static void ShutDown()
        {
            if (!Initialized) return;
            if (Throw) throw new InvalidOperationException("private diagnostic text");
            NativeShutdownCalls++;
            Initialized = false;
        }
    }
}
namespace Boopy.Client.Tests
{
    using Wrapper = Oculus.Interaction.Telemetry.ISDKEngineTelemetryNative;
    using Package = UnityEditor.PackageManager.PackageInfo;
    using Editor = UnityEditor.EditorApplication;
    using Log = UnityEngine.Debug;

    [NonParallelizable]
    public class InteractionTelemetryShutdownTests
    {
        [SetUp]
        public void Setup()
        {
            RuntimeHelpers.RunClassConstructor(typeof(Boopy.Quest.Editor.InteractionTelemetryShutdown).TypeHandle);
            Package.Current = new Package();
            Wrapper.Initialized = true; Wrapper.NativeShutdownCalls = 0; Wrapper.Throw = false;
            Log.Messages.Clear(); Log.Warnings.Clear(); Log.Errors.Clear();
        }
        [Test]
        public void EditorQuitShutsDownInitializedTelemetryExactlyOnce()
        {
            Editor.Quit(); Editor.Quit();
            Assert.That(Wrapper.NativeShutdownCalls, Is.EqualTo(1));
            Assert.That(Wrapper.Initialized, Is.False);
            Assert.That(Log.Messages, Has.All.EqualTo("Boopy: Interaction SDK editor telemetry shutdown requested."));
            Assert.That(Log.Messages, Has.Count.EqualTo(2));
            Assert.That(Log.Errors, Is.Empty);
        }
        [Test]
        public void PriorRuntimeShutdownPreventsSecondNativeShutdown()
        {
            Wrapper.ShutDown(); Editor.Quit();
            Assert.That(Wrapper.NativeShutdownCalls, Is.EqualTo(1));
        }
        [TestCase("207.0.1", "com.meta.xr.sdk.interaction")]
        [TestCase("207.0.0", "other.package")]
        public void UnverifiedPackageIsLeftAloneWithDiagnostic(string version, string name)
        {
            Package.Current.version = version; Package.Current.name = name;
            Editor.Quit();
            Assert.That(Wrapper.NativeShutdownCalls, Is.Zero);
            Assert.That(Log.Warnings, Has.Count.EqualTo(1));
            Assert.That(Log.Messages, Is.Empty);
        }
        [Test]
        public void InvocationFailureIsReportedWithoutExceptionText()
        {
            Wrapper.Throw = true; Editor.Quit();
            Assert.That(Log.Messages, Is.Empty);
            Assert.That(Log.Errors, Is.EqualTo(new[] { "Boopy: Interaction SDK editor telemetry shutdown failed." }));
        }
    }
}
