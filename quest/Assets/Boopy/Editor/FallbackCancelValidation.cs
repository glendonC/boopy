#nullable enable
using System;
using System.Reflection;
using System.Threading;
using Boopy.Client;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>Production fallback collider and guarded application release, synthetic wait only.</summary>
    public static class FallbackCancelValidation
    {
        public static void Validate()
        {
            var root = new GameObject("Synthetic fallback stop wait");
            try
            {
                var eyes = new GameObject("Synthetic eyes").transform; eyes.SetParent(root.transform, false);
                var console = ContextConsole.Create(root.transform, eyes); console.Place(Vector3.forward);
                var caption = DialogueStrip.Create(root.transform, eyes); console.DockDialogue(caption);
                caption.Show(DialogueStage.Working, "Thinking…"); caption.SetCancelableWait(true);
                console.Hide(); caption.SetFallback(true);
                var action = (SpatialAction)Read(caption, "fallbackStop")!;
                Require(action.gameObject.activeInHierarchy && action.AccessibleLabel == "Stop waiting", "Hidden console lost its actual stop-wait control.");
                var ray = new Ray(eyes.position, (action.transform.position - eyes.position).normalized);
                Physics.SyncTransforms();
                Require(caption.HitFallbackAction(ray, out _) == ConsoleAction.Cancel && !caption.HitPage(ray), "Fallback action cannot be reached or pages the reply instead.");
                Require(console.HitAction(ray, out _) == ConsoleAction.None && console.HitTarget(ray, out _) == null, "Fallback stop targets hidden context.");
                var app = root.AddComponent<BoopyApp>();
                var prior = new SessionView { Id = "synthetic-prior", State = "review" };
                using var request = new CancellationTokenSource();
                Set(app, "head", eyes); Set(app, "console", console); Set(app, "dialogue", caption);
                Set(app, "session", prior); Set(app, "captureRequest", request); Set(app, "busy", true);
                Set(app, "unresolvedStartId", "031c8f0d-a8b5-44e8-8085-c8f6ba455216");
                var hitArgs = new object[] { ray, Vector3.zero };
                Require((ConsoleAction)Invoke(app, "ControlHit", hitArgs)! == ConsoleAction.Cancel, "Application does not route fallback action.");
                var hand = new HandInput(false, null, null);
                Set(app, "pendingControl", ConsoleAction.Cancel); Set(app, "pendingUsesHandRay", false);
                eyes.rotation = Quaternion.LookRotation(Vector3.left);
                Invoke(app, "ReleaseControl", new object[] { hand });
                Require(!request.IsCancellationRequested, "Release away from stop-wait cancelled the request.");
                eyes.rotation = Quaternion.LookRotation(ray.direction);
                Set(app, "pendingControl", ConsoleAction.Cancel);
                Invoke(app, "ReleaseControl", new object[] { hand });
                Require(request.IsCancellationRequested, "Targeted fallback release did not stop the local wait.");
                Require(ReferenceEquals(Read(app, "session"), prior) && Read(app, "unresolvedStartId") != null, "Stopping wait mutated context or discarded uncertain first-capture identity.");
                Require(!((Voice)Read(app, "voice")!).Recording && Read(app, "client") == null, "Stop action started microphone or created a transport.");
                caption.SetCancelableWait(false);
                Require(caption.HitFallbackAction(ray, out _) == ConsoleAction.None, "Completed wait retained stop action.");
                var exact = "Exact synthetic answer. 한글 원문.";
                caption.Show(DialogueStage.Response, exact); caption.SetCancelableWait(true);
                Require(caption.FullText == exact && caption.HitFallbackAction(ray, out _) == ConsoleAction.None, "Response was rewritten or offered cancellation without active work.");
                caption.Show(DialogueStage.Working, "Checking…"); caption.SetFallback(false);
                Require(caption.HitFallbackAction(ray, out _) == ConsoleAction.None, "Docked caption duplicated normal stop control.");
                Debug.Log("Boopy fallback stop-wait validation passed (synthetic local cancellation; no capture, request replay or room claim).");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }
        private static object? Invoke(object value, string name, object[] args) => value.GetType().GetMethod(name, BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(value, args);
        private static object? Read(object value, string name) => value.GetType().GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(value);
        private static void Set(object value, string name, object? item) => value.GetType().GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(value, item);
        private static void Require(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
    }
}
