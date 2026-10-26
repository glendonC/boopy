#nullable enable
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Boopy.Client;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>Production UI, synthetic data only. A render is not a wearer acceptance result.</summary>
    public static class PeripheralHudValidation
    {
        public static void Validate()
        {
            ScriptCoverage.Install();
            var root = new GameObject("Synthetic unified HUD validation");
            try
            {
                var head = new GameObject("Eyes").transform; head.SetParent(root.transform);
                var console = ContextConsole.Create(root.transform, head);
                var caption = DialogueStrip.Create(root.transform, head);
                console.DockDialogue(caption); console.SetReducedMotion(true);
                console.Place(new Vector3(.32f, -.08f, 1));
                var view = Session(); console.Render(view);
                caption.Show(DialogueStage.Response, "A proposed place.");
                console.RefreshVisuals(.4f);
                var header = console.GetComponentsInChildren<SpatialSurface>().Single(s => s.name == "Intent instrument");
                Require(caption.transform.parent == header.transform, "Caption has an independent anchor.");
                Require(console.Reviewing, "HUD fixture must exercise an active review intent collider.");
                Require(!header.GetComponentsInChildren<TextMeshPro>().Where(t => !t.transform.IsChildOf(caption.transform)).Any(t => t.GetComponent<MeshRenderer>().enabled), "Duplicate header copy is still rendered.");
                var ray = new Ray(head.position, caption.transform.position - head.position);
                Require(console.HitTarget(ray, out _) == null, "Caption can confirm an invisible intent.");
                Require(!caption.HitPage(ray), "Single-page caption exposes a false next-page action.");
                console.SetReducedMotion(false);
                var companion = console.GetComponentInChildren<CompanionOrb>();
                foreach (var state in new[] { "idle", "listening", "processing", "review", "saved", "error" })
                {
                    companion.SetState(state);
                    for (var tick = 0; tick < 90; tick++)
                    {
                        companion.Refresh(1f / 60f, false);
                        foreach (var renderer in companion.GetComponentsInChildren<MeshRenderer>())
                        {
                            var bounds = renderer.localBounds;
                            foreach (var x in new[] { -1f, 1f }) foreach (var y in new[] { -1f, 1f }) foreach (var z in new[] { -1f, 1f })
                            {
                                var center = console.transform.position + console.transform.up * console.LayoutCenterOffset;
                                var corner = Quaternion.Inverse(console.transform.rotation) * (renderer.transform.TransformPoint(bounds.center + Vector3.Scale(bounds.extents, new Vector3(x,y,z))) - center);
                                Require(Mathf.Abs(corner.x) <= console.LayoutSize.x / 2f && Mathf.Abs(corner.y) <= console.LayoutSize.y / 2f,
                                    "Animated companion escapes reserved object keepout footprint.");
                            }
                        }
                    }
                }
                console.SetReducedMotion(true);
                var localPosition = caption.transform.localPosition;
                var localRotation = caption.transform.localRotation;
                var late = typeof(DialogueStrip).GetMethod("LateUpdate", BindingFlags.NonPublic | BindingFlags.Instance)!;
                for (var index = 0; index < 30; index++)
                {
                    head.position = new Vector3(index * .01f, 0, 0);
                    head.rotation = Quaternion.Euler(0, index * 3f, 0);
                    console.Place(head.position + head.forward + head.right * .32f);
                    late.Invoke(caption, null);
                    Require(caption.transform.localPosition == localPosition && caption.transform.localRotation == localRotation,
                        "Caption drifts relative to companion while head moves.");
                }
                ValidateWaiting(console, caption, head, header);
                console.Render(view);
                var full = string.Concat(Enumerable.Repeat("사하라 여행, 제 경험. ", 25));
                caption.Show(DialogueStage.Response, full);
                Require(caption.PageCount > 1, "Long response did not page.");
                ray = new Ray(head.position, caption.transform.position - head.position);
                Physics.SyncTransforms();
                Require(caption.HitPage(ray), "Docked pages cannot be reached.");
                var exact = "";
                for (var index = 0; index < caption.PageCount; index++) { exact += caption.VisibleText; caption.NextPage(); }
                Require(exact == full, "Docking lost exact response text.");
                caption.ShowNotice("Voice unavailable. The text response is still here.", 5);
                caption.ShowNotice("Keep your hand in view.", 5);
                caption.ClearNotice();
                Require(caption.FullText == full && caption.Stage == DialogueStage.Response, "Transient notices erased the exact response.");
                caption.ShowNotice("Temporary notice.", 5);
                typeof(DialogueStrip).GetField("noticeExpires", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(caption, -1f);
                late.Invoke(caption, null);
                Require(caption.FullText == full, "Notice expiry did not restore the response.");
                caption.ShowNotice("Old notice.", 5); caption.Show(DialogueStage.Response, full);
                caption.ClearNotice(); Require(caption.FullText == full, "Old notice replaced a new response.");
                Require(console.HitTarget(ray, out _) == null, "Paged caption exposes hidden intent target.");
                caption.SetComfort(1.2f, true);
                Require(caption.transform.localScale == Vector3.one, "Comfort scale applied twice to caption.");
                console.Hide(); Require(!caption.gameObject.activeInHierarchy && !caption.HitPage(ray), "Hidden HUD leaves caption active.");
                console.Place(Vector3.forward); caption.Hide(); console.ShowCapture();
                caption.ShowNotice(full, 5); console.Activate(ConsoleAction.More); console.Activate(ConsoleAction.More); console.RefreshVisuals(.4f); Physics.SyncTransforms();
                var options = console.GetComponentsInChildren<SpatialAction>().Single(a => a.Action == ConsoleAction.Settings);
                var optionsRay = new Ray(head.position, options.transform.position - head.position);
                Require(console.HitAction(optionsRay, out _) == ConsoleAction.Settings && !caption.HitPage(optionsRay), "Long idle notice steals Settings input.");
                caption.Hide(); console.ShowCapture();
                Require(header.GetComponentsInChildren<TextMeshPro>().Where(t => !t.transform.IsChildOf(caption.transform)).Any(t => t.GetComponent<MeshRenderer>().enabled), "Default instruction did not return.");
                Debug.Log("Boopy peripheral HUD validation passed: shared anchor, hidden target guard, exact paging, no double scale or orphan captions.");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }

        private static void ValidateWaiting(ContextConsole console, DialogueStrip caption, Transform head, SpatialSurface header)
        {
            console.ShowProcessing(); caption.Show(DialogueStage.Working, "Thinking…");
            console.SetReducedMotion(true); console.RefreshVisuals(.4f); caption.RefreshVisuals(.4f); Physics.SyncTransforms();
            var controls = (System.Collections.Generic.Dictionary<ConsoleAction, SpatialAction>)typeof(ContextConsole).GetField("actions", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(console)!;
            var cancel = controls[ConsoleAction.Cancel];
            Require(cancel.gameObject.activeInHierarchy, "Stop waiting is not a visible text action.");
            var words = cancel.GetComponentsInChildren<TextMeshPro>(true).Where(text => text.gameObject.activeInHierarchy && text.GetComponent<MeshRenderer>().enabled).ToArray();
            Require(words.Length == 1 && words[0].text == "Stop", "Cancel lacks its plain text label.");
            Require(!cancel.GetComponentsInChildren<LineRenderer>(true).Any(line => line.name == "Cancel cross"), "Giant cancel cross geometry remains.");
            Require(cancel.transform.parent != header.transform && !console.CaptionHasTrailingAction, "Cancel still occupies the caption header.");
            var cancelRay = new Ray(head.position, cancel.transform.position - head.position);
            Require(console.HitAction(cancelRay, out _) == ConsoleAction.Cancel && console.CanRelease(ConsoleAction.Cancel, cancelRay), "Stop waiting cannot be targeted and released while busy.");
            Require(!caption.HitPage(cancelRay) && console.HitTarget(cancelRay, out _) == null, "Cancel pinch is stolen by caption or evidence.");
            Require(caption.VisibleText == "Thinking…" && string.IsNullOrEmpty(caption.SpeakerText), "Wait line repeats working status or speaker title.");
            Require(!header.GetComponentsInChildren<TextMeshPro>().Where(text => !text.transform.IsChildOf(caption.transform)).Any(text => text.GetComponent<MeshRenderer>().enabled), "Wait state shows duplicate header copy.");
            var visible = caption.GetComponentsInChildren<TextMeshPro>(true).Single(text => text.text == "Thinking…");
            visible.ForceMeshUpdate();
            Require(visible.alpha > 0f && visible.textInfo.characterInfo.Take(visible.textInfo.characterCount).Any(character => character.isVisible), "Reduced-motion wait has no visible glyph geometry.");
            caption.RefreshVisuals(3f);
            Require(caption.VisibleText == "Thinking…" && cancel.gameObject.activeInHierarchy, "Reduced motion hides the wait line or cancel action.");
            typeof(DialogueStrip).GetField("stageStartedAt", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(caption, Time.unscaledTime - 12f);
            caption.RefreshVisuals(0f);
            Require(caption.VisibleText == "Thinking…" && caption.FullText == "Thinking…", "A slow wait adds a second line or a timer to the working words.");
            caption.ShowNotice("Synthetic temporary notice.", 5f); caption.ClearNotice(); caption.RefreshVisuals(0f);
            Require(caption.VisibleText == "Thinking…" && caption.FullText == "Thinking…", "Notice restoration changed the working words.");
            caption.Show(DialogueStage.Working, string.Concat(Enumerable.Repeat("Synthetic waiting detail ", 50)));
            Require(caption.PageCount > 1 && !caption.HitPage(cancelRay), "Long waiting caption steals cancellation hit ownership.");
            caption.Hide();
        }

        public static void ValidateAll()
        {
            FontLifecycleValidation.Validate();
            Validate();
            SceneDensityValidation.Validate();
            CharacterValidation.Validate();
            ModularUiValidation.Validate();
            DialogueValidation.Validate();
            ManualRecoveryValidation.Validate();
            StartRecoveryValidation.Validate();
            RestartRecoveryValidation.Validate();
            EvidenceChoiceValidation.Validate();
            TargetedQuestionValidation.Validate();
            ManualHandoffValidation.Validate();
            Render();
            Debug.Log("Boopy combined peripheral HUD validation passed.");
        }

        public static void Render()
        {
            Validate();
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            ScriptCoverage.Install();
            var root = new GameObject("Synthetic HUD render");
            var camera = new GameObject("Synthetic camera").AddComponent<Camera>(); camera.transform.SetParent(root.transform);
            camera.fieldOfView = 58; camera.nearClipPlane = .05f; camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(.67f, .70f, .71f);
            // High-contrast synthetic room pattern exercises text legibility without private camera frames.
            for (var index = 0; index < 12; index++)
            {
                var wall = new GameObject("Synthetic wall stripe"); wall.transform.SetParent(root.transform);
                wall.transform.position = new Vector3(-1.65f + index * .3f, 0, 2);
                wall.transform.localScale = new Vector3(.15f, 3f, 1f);
                wall.AddComponent<MeshFilter>().sharedMesh = Visuals.Quad();
                var renderer = wall.AddComponent<MeshRenderer>(); renderer.sharedMaterial = Visuals.Solid;
                var block = new MaterialPropertyBlock(); block.SetColor("_Color", index % 2 == 0 ? new Color(.36f,.41f,.43f) : new Color(.85f,.84f,.80f)); renderer.SetPropertyBlock(block);
            }
            var console = ContextConsole.Create(root.transform, camera.transform);
            var caption = DialogueStrip.Create(root.transform, camera.transform); console.DockDialogue(caption);
            console.SetReducedMotion(true); console.Place(new Vector3(.32f, -.08f, 1f));
            var directory = Path.Combine(Path.GetTempPath(), "boopy-peripheral-hud"); Directory.CreateDirectory(directory);
            var target = new RenderTexture(1200, 800, 24); var pixels = new Texture2D(1200, 800, TextureFormat.RGB24, false);
            var previous = RenderTexture.active;
            try
            {
                foreach (var state in new[] { "idle", "listening", "processing", "slow-wait", "response", "reader", "error" })
                {
                    caption.Hide();
                    switch (state)
                    {
                        case "idle": console.ShowCapture(); break;
                        case "listening": console.ShowListening(); caption.Show(DialogueStage.Listening, "Listening…\nLet go when you’re done."); break;
                        case "processing": console.ShowProcessing(); caption.Show(DialogueStage.Working, "Thinking…"); break;
                        case "slow-wait": console.ShowProcessing(); caption.Show(DialogueStage.Working, "Thinking…"); typeof(DialogueStrip).GetField("stageStartedAt", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(caption, Time.unscaledTime - 12f); caption.RefreshVisuals(0f); break;
                        case "response": console.Render(Session()); caption.Show(DialogueStage.Response, "I kept your words with this view. The location is still proposed."); break;
                        case "reader": console.Render(Session()); console.Activate(ConsoleAction.Options); console.Activate(ConsoleAction.Review); Require(console.ReaderOpen, "Reader render fixture did not open a reader."); caption.Show(DialogueStage.Response, "Review your captured context."); break;
                        case "error": console.ShowError("The Mac is unavailable. Check the USB connection."); caption.Show(DialogueStage.Error, "The Mac is unavailable. Check the USB connection."); break;
                    }
                    console.RefreshVisuals(.4f);
                    camera.targetTexture = target; camera.Render(); RenderTexture.active = target;
                    pixels.ReadPixels(new Rect(0,0,1200,800),0,0); pixels.Apply();
                    File.WriteAllBytes(Path.Combine(directory,state+".png"),pixels.EncodeToPNG());
                }
                console.ShowProcessing(); console.SetReducedMotion(false);
                caption.Show(DialogueStage.Working, "Thinking…");
                var motion = new ViewFollow();
                var frames = Path.Combine(directory, "motion"); Directory.CreateDirectory(frames);
                for (var frame = 0; frame < 72; frame++)
                {
                    var time = frame / 24f;
                    camera.transform.position = new Vector3(.10f * Mathf.Sin(time * 2f), 0, 0);
                    camera.transform.rotation = Quaternion.Euler(0, 32f * Mathf.Sin(time * 1.8f), 0);
                    var head = new HeadPose(new System.Numerics.Vector3(camera.transform.position.x,0,0),
                        new System.Numerics.Vector3(camera.transform.forward.x,camera.transform.forward.y,camera.transform.forward.z));
                    var current = console.transform.position;
                    var next = motion.Step(head, new System.Numerics.Vector3(current.x,current.y,current.z), ViewFollow.Target(head), false, 1f / 24f);
                    console.Place(new Vector3(next.X,next.Y,next.Z)); console.RefreshVisuals(1f / 24f); caption.RefreshVisuals(1f / 24f);
                    camera.Render(); RenderTexture.active = target;
                    pixels.ReadPixels(new Rect(0,0,1200,800),0,0); pixels.Apply();
                    File.WriteAllBytes(Path.Combine(frames, $"frame-{frame:000}.png"), pixels.EncodeToPNG());
                }
                Debug.Log("Boopy peripheral HUD production renders: " + directory);
            }
            finally
            {
                camera.targetTexture = null; RenderTexture.active = previous;
                UnityEngine.Object.DestroyImmediate(pixels); UnityEngine.Object.DestroyImmediate(target); UnityEngine.Object.DestroyImmediate(root);
            }
        }
        private static SessionView Session()
        {
            var view = new SessionView { Id="synthetic-hud", State="review", IntentId="intent", Model=new ModelRef {Provider="fixture", Id="synthetic-model"} };
            view.Items.Add(new Item { Id="intent", Kind="intent", Label="Practice my travel account", Statement="Prepare for Korean conversation.", Status="proposed" });
            view.Items.Add(new Item { Id="dunes", Kind="object", Label="Dunes", Statement="A proposed desert scene. Location remains unknown.", Status="proposed" });
            return view;
        }
        private static void Require(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
    }
}
