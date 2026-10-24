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
    public static class ControlBarValidation
    {
        public static void Validate()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            HangulFont.Install();
            ValidateConnectionAndRecording();
            ValidateDialoguePresentation();
            var root = new GameObject("Synthetic unified control bar");
            try
            {
                var eyes = new GameObject("Synthetic viewer").transform; eyes.SetParent(root.transform);
                var console = ContextConsole.Create(root.transform, eyes);
                var follow = root.AddComponent<FollowConsole>(); follow.Initialize(eyes, console.transform);
                console.Place(follow.DesiredPosition);
                Require(Mathf.Abs(console.transform.position.x) < .001f && console.transform.position.y < -.2f, "Control bar is not below center.");
                var bar = console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Control bar");
                var anchor = bar.transform.position;
                var pause = Control(console, ConsoleAction.PauseScene);
                // Settings sits under More; the held-target check uses More, which is on the idle shelf.
                var settings = Control(console, ConsoleAction.More);
                Ready(console);
                Require(Active(console).SequenceEqual(new[] { ConsoleAction.Talk, ConsoleAction.PauseScene, ConsoleAction.More }.OrderBy(action => action)), "Idle bar contains unrelated workflow controls.");
                Require(console.GetComponentsInChildren<CompanionOrb>(true).Length == 1, "Conversation has duplicate companions.");
                CheckBar(console, eyes, bar);
                console.Activate(ConsoleAction.Settings); Ready(console);
                var sheet = console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Comfort options");
                Require(sheet.gameObject.activeInHierarchy && sheet.transform.position.y > bar.transform.position.y, "Settings do not unfold above the bar.");
                Require(bar.transform.position == anchor, "Opening settings moves the control bar.");
                console.Activate(ConsoleAction.Settings); Ready(console);
                Require(!sheet.gameObject.activeInHierarchy, "Settings cannot close from its original control.");
                var box = pause.GetComponent<BoxCollider>(); var size = box.size; var point = pause.transform.position;
                console.SetScenePaused(true); Ready(console);
                Require(pause.AccessibleLabel == "Resume" && box.size == size && pause.transform.position == point, "Pause changes its target geometry.");
                CheckBar(console, eyes, bar);
                console.SetScenePaused(false);
                var view = new SessionView { Id = "synthetic-bar", State = "review" };
                view.Items.Add(new Item { Id = "synthetic-item", Kind = "object", Label = "Synthetic object", Statement = "A proposed source", Status = "proposed", Grounding = new Grounding { Kind = "scene" } });
                console.Render(view); Ready(console);
                Require(Control(console, ConsoleAction.Options).AccessibleLabel == "Context", "Bar context control has an arbitrary label.");
                CheckBar(console, eyes, bar);
                console.Activate(ConsoleAction.Options); Ready(console);
                Require(sheet.gameObject.activeInHierarchy && console.Reading, "Context summary does not pin companion travel while being read.");
                console.ShowControlsOnly(console.transform.position); Ready(console);
                Require(!sheet.gameObject.activeInHierarchy, "Protected-source fallback exposes Context summary.");
                Require(!Active(console).Any(action => action == ConsoleAction.Review || action == ConsoleAction.PrepareSave || action == ConsoleAction.Handoff), "Protected-source fallback exposes context actions.");
                console.Activate(ConsoleAction.Options); console.Activate(ConsoleAction.Options); Ready(console);
                Require(!sheet.gameObject.activeInHierarchy, "Context reopened during protected-source fallback.");
                console.Activate(ConsoleAction.Settings); console.NextPage(); Ready(console);
                Require(sheet.gameObject.activeInHierarchy && Active(console).Contains(ConsoleAction.Size), "Explicit protected settings are inaccessible.");
                console.Activate(ConsoleAction.Settings); Ready(console);
                Require(!sheet.gameObject.activeInHierarchy, "Protected settings cannot close.");
                console.Activate(ConsoleAction.Settings); Ready(console);
                Require(sheet.gameObject.activeInHierarchy, "Protected settings cannot reopen.");
                console.Activate(ConsoleAction.Options); Ready(console);
                Require(!sheet.gameObject.activeInHierarchy, "Switching protected settings to Context exposes conversation content.");
                console.Place(console.transform.position); Ready(console);
                Require(sheet.gameObject.activeInHierarchy && Active(console).Contains(ConsoleAction.Review), "Clear placement did not restore requested Context.");
                console.ShowProcessing(); Ready(console);
                Require(Active(console).SequenceEqual(new[] { ConsoleAction.Cancel, ConsoleAction.PauseScene }.OrderBy(action => action)), "Working bar loses cancellation or exposes disabled settings.");
                Require(Control(console, ConsoleAction.Cancel).AccessibleLabel == "Stop", "Cancellation does not use the bar action.");
                CheckBar(console, eyes, bar);
                var caption=DialogueStrip.Create(root.transform,eyes);console.DockDialogue(caption);
                caption.Show(DialogueStage.Working,"Thinking…");caption.SetCancelableWait(true);
                console.ShowControlsOnly(console.transform.position);caption.SetFallback(true);Ready(console);
                Require(console.HasVisibleBar && !console.GetComponentsInChildren<CompanionOrb>().Any(),"Protected-source fallback hides the bar or leaves conversation content visible.");
                CheckBar(console,eyes,bar);
                Require(!caption.GetComponentsInChildren<SpatialAction>().Any(),"Fallback duplicates the bar Stop action.");
                console.ShowCapture();console.Activate(ConsoleAction.Settings);Ready(console);
                Require(sheet.gameObject.activeInHierarchy,"Settings inaccessible with protected conversation content.");
                caption.Show(DialogueStage.Response, string.Concat(Enumerable.Repeat("Synthetic exact answer. 기록된 그림이에요. ", 12)));
                var exact = caption.FullText; caption.NextPage(); var selectedPage = caption.VisibleText;
                foreach (var large in new[] { false, true })
                {
                    if (large) { console.Activate(ConsoleAction.Size); Ready(console); }
                    caption.RefreshVisuals(1f); CheckFallback(console, caption, eyes);
                    console.Activate(ConsoleAction.Settings); Ready(console); caption.RefreshVisuals(1f);
                    CheckFallback(console, caption, eyes);
                    console.Activate(ConsoleAction.Settings); Ready(console); caption.RefreshVisuals(1f);
                    CheckFallback(console, caption, eyes);
                    Require(caption.FullText == exact && caption.VisibleText == selectedPage, "Fallback layout changed exact answer or selected page.");
                }
                console.Hide(); caption.SetFallback(false); caption.SetFallback(true);
                caption.RefreshVisuals(0f);
                Require(caption.gameObject.activeInHierarchy && caption.FullText == exact, "Whole-console fallback lost the exact response.");
                console.Place(console.transform.position);caption.SetFallback(false);
                if (console.ComfortScale <= 1f) console.Activate(ConsoleAction.Size); Ready(console);
                Require(console.ComfortScale > 1f, "Large-text fixture was not exercised.");
                CheckBar(console, eyes, bar);
                console.SetScenePaused(true); Ready(console); CheckBar(console, eyes, bar);
                console.SetScenePaused(false); Ready(console);
                var held = settings.transform.position;
                console.SetInteractionLocked(true); eyes.rotation = Quaternion.Euler(0,35,0); console.RefreshVisuals(.1f);
                Require(settings.transform.position == held && follow.Advance(follow.DesiredPosition,true) == console.transform.position, "A targeted bar moved under the hand.");
                Debug.Log("Boopy unified control bar validation passed: stable slots, upward settings, pause/stop hits, large text and one companion.");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }

        public static void ValidateConnectionAndRecording()
        {
            var root=new GameObject("Synthetic connection and recording controls");
            try
            {
                var eyes=new GameObject("Synthetic connection viewer").transform;eyes.SetParent(root.transform,false);
                var console=ContextConsole.Create(root.transform,eyes);console.Place(new Vector3(0,-.342f,.94f));
                var bar=console.GetComponentsInChildren<SpatialSurface>(true).Single(surface=>surface.name=="Control bar");
                Require(!bar.GetComponentsInChildren<TextMeshPro>(true).Any(text=>text.name=="Connection status"),"Rejected connection strip remains above the controls.");
                foreach(var state in new[]{"checking","connected","unavailable"})
                {
                    console.SetConnectionStatus(state,state=="connected");Ready(console);
                    Require(!bar.GetComponentsInChildren<TextMeshPro>(true).Any(text=>text.text.Contains("Mac") || text.text.Contains("Muse")),"Control bar exposes connection implementation details.");
                    console.Activate(ConsoleAction.Settings);Ready(console);
                    var sheet=console.GetComponentsInChildren<SpatialSurface>(true).Single(surface=>surface.name=="Comfort options");
                    Require(sheet.BodyText.Contains(state=="connected"?"answers through your Mac":state=="unavailable"?"can’t reach your Mac":"Checking the connection"),"Settings lose actual connection state.");
                    Require(!sheet.BodyText.Contains("Muse"),"Settings imply a Muse connection.");
                    CheckBar(console,eyes,bar);console.Activate(ConsoleAction.Settings);Ready(console);
                }
                console.SetConnectionStatus("connected",true);console.Activate(ConsoleAction.Settings);Ready(console);
                // Voice is the fourth setting, one per page after the status page.
                for(var page=0;page<4;page++)console.NextPage();Ready(console);
                Require(Control(console,ConsoleAction.Speech).gameObject.activeInHierarchy,"Voice unavailable before the first conversation turn despite health capability.");
                if(!console.VoiceEnabled)console.Activate(ConsoleAction.Speech);
                console.Activate(ConsoleAction.Speech);Require(!console.VoiceEnabled,"Synthetic mute was not applied.");
                console.SetConnectionStatus("checking",false);Require(!console.VoiceEnabled,"Health checking overrides explicit mute.");
                console.SetConnectionStatus("connected",true);Require(!console.VoiceEnabled,"New health capabilities override explicit mute.");
                console.Render(new SessionView {Id="synthetic-capability-refresh",State="review",SpeechOutputAvailable=true});
                Require(!console.VoiceEnabled,"First-turn capability update overrides explicit mute.");
                console.ShowListening();console.SetButtonRecording(true);Ready(console);
                Require(Active(console).SequenceEqual(new[]{ConsoleAction.FinishTalk,ConsoleAction.PauseScene,ConsoleAction.Cancel}.OrderBy(action=>action)),"Button recording lacks Finish/Cancel or retains competing idle actions.");
                Require(Control(console,ConsoleAction.FinishTalk).AccessibleLabel=="Finish" && Control(console,ConsoleAction.Cancel).AccessibleLabel=="Cancel","Recording actions have unclear names.");CheckBar(console,eyes,bar);
                console.SetButtonRecording(false);console.ShowCapture();Ready(console);CheckBar(console,eyes,bar);
                Require(Control(console,ConsoleAction.Talk).gameObject.activeInHierarchy && !Control(console,ConsoleAction.FinishTalk).gameObject.activeInHierarchy,"Recording completion did not restore Talk.");
                Debug.Log("Boopy truthful connection, pre-turn voice preference and recording controls validation passed.");
            }
            finally{UnityEngine.Object.DestroyImmediate(root);}
        }

        public static void ValidateDialoguePresentation()
        {
            var root=new GameObject("Synthetic exact dialogue presentation");
            try
            {
                var eyes=new GameObject("Synthetic dialogue viewer").transform;eyes.SetParent(root.transform,false);
                var dialogue=DialogueStrip.Create(root.transform,eyes);
                var text=dialogue.GetComponentsInChildren<TextMeshPro>(true).Single(label=>label.name=="Actual response");
                var entrance=dialogue.transform.Find("Caption entrance");
                dialogue.Show(DialogueStage.Working,"Thinking");dialogue.RefreshVisuals(.35f);
                Require(!dialogue.GetComponentsInChildren<Transform>(true).Any(child=>child.name=="Pending reply dot"),"Rejected waiting dots remain in the dialogue.");
                var before=GlyphColors(text);dialogue.RefreshVisuals(.55f);var after=GlyphColors(text);
                Require(!before.SequenceEqual(after),"Real pending text has no moving brightness band.");
                Require(dialogue.FullText=="Thinking" && dialogue.VisibleText=="Thinking","Shimmer rewrites actual waiting text.");
                const string answer="Exact synthetic answer. 그림이에요.";
                dialogue.Show(DialogueStage.Response,answer);dialogue.RefreshVisuals(.09f);
                Require(Mathf.Abs(text.alpha-.5f)<.01f && entrance.localPosition.y<0,"Answer does not enter over 180ms.");
                dialogue.RefreshVisuals(.09f);Require(text.alpha>.99f && entrance.localPosition==Vector3.zero,"Answer reveal does not finish at its exact pose.");
                var settled=GlyphColors(text);dialogue.RefreshVisuals(.6f);
                Require(settled.SequenceEqual(GlyphColors(text)) && dialogue.FullText==answer,"Settled response retains shimmer or changes text.");
                dialogue.SetComfort(1f,true);dialogue.Show(DialogueStage.Working,"Thinking");dialogue.RefreshVisuals(.12f);
                var reduced=GlyphColors(text);var position=entrance.localPosition;dialogue.RefreshVisuals(1f);
                Require(position==Vector3.zero && entrance.localPosition==position && reduced.SequenceEqual(GlyphColors(text)),"Reduced waiting retains motion or shimmer.");
                Debug.Log("Boopy exact dialogue validation passed: text-only waiting, 180ms answer reveal and static reduced motion.");
            }
            finally{UnityEngine.Object.DestroyImmediate(root);}
        }
        private static Color32[] GlyphColors(TextMeshPro text)=>text.textInfo.characterInfo.Where(glyph=>glyph.isVisible).Select(glyph=>text.textInfo.meshInfo[glyph.materialReferenceIndex].colors32[glyph.vertexIndex]).ToArray();

        public static void ValidateAll() { Validate(); HudMotionValidation.ValidateAll(); ModularUiValidation.Validate(); }

        public static void ValidateAndRender() { Validate(); Render(); }

        public static void Render()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single); HangulFont.Install();
            var root = new GameObject("Synthetic control bar preview");
            var eyes = new GameObject("Synthetic viewer").transform; eyes.SetParent(root.transform);
            var camera = eyes.gameObject.AddComponent<Camera>(); camera.fieldOfView=64; camera.nearClipPlane=.05f; camera.clearFlags=CameraClearFlags.SolidColor; camera.backgroundColor=new Color(.15f,.17f,.19f);
            var console = ContextConsole.Create(root.transform,eyes);
            var follow=root.AddComponent<FollowConsole>();follow.Initialize(eyes,console.transform); console.Place(follow.DesiredPosition);
            var output=Path.GetFullPath(Path.Combine(Application.dataPath,"..","Builds","control-bar")); Directory.CreateDirectory(output);
            var target=new RenderTexture(1600,1200,24);target.Create();camera.targetTexture=target;
            var prior=RenderTexture.active; var pixels=new Texture2D(1600,1200,TextureFormat.RGB24,false);
            try
            {
                foreach(var state in new[]{"idle","settings","working","fallback","fallback-settings","fallback-large","fallback-settings-large"})
                {
                    if(state=="settings")console.Activate(ConsoleAction.Settings);
                    if(state=="working")console.ShowProcessing();
                    if(state == "fallback")
                    {
                        console.ShowCapture(); console.ShowControlsOnly(console.transform.position);
                        var reply = DialogueStrip.Create(root.transform,eyes); console.DockDialogue(reply);
                        reply.Show(DialogueStage.Response,string.Concat(Enumerable.Repeat("Synthetic exact answer. 기록된 그림이에요. ",12))); reply.SetFallback(true);
                    }
                    if(state == "fallback-settings" || state == "fallback-settings-large") console.Activate(ConsoleAction.Settings);
                    if(state == "fallback-large") { console.Activate(ConsoleAction.Settings); console.Activate(ConsoleAction.Size); }
                    Ready(console);
                    foreach(var reply in root.GetComponentsInChildren<DialogueStrip>())reply.RefreshVisuals(1f);
                    foreach(var text in root.GetComponentsInChildren<TextMeshPro>())text.ForceMeshUpdate();
                    camera.Render();RenderTexture.active=target;pixels.ReadPixels(new Rect(0,0,1600,1200),0,0);pixels.Apply();
                    File.WriteAllBytes(Path.Combine(output,state+".png"),pixels.EncodeToPNG());
                }
                Debug.Log("Boopy unified control bar synthetic preview: "+output);
            }
            finally {camera.targetTexture=null; RenderTexture.active=prior; UnityEngine.Object.DestroyImmediate(pixels);UnityEngine.Object.DestroyImmediate(target);UnityEngine.Object.DestroyImmediate(root);}
        }

        private static void CheckFallback(ContextConsole console, DialogueStrip caption, Transform eyes)
        {
            Physics.SyncTransforms();
            var page = caption.GetComponent<BoxCollider>();
            var subtitle = Project(eyes, caption.transform, page.center, page.size);
            foreach (var surface in console.GetComponentsInChildren<SpatialSurface>())
            {
                var area = Project(eyes, surface.transform, Vector3.zero, new Vector3(surface.Size.x, surface.Size.y, 0));
                Require(!subtitle.Overlaps(area), "Fallback paging target overlaps a visible console surface.");
            }
            var ray = new Ray(eyes.position, caption.transform.position - eyes.position);
            Require(caption.HitPage(ray) && console.HitAction(ray, out _) == ConsoleAction.None, "Fallback paging is obscured by controls.");
            var prior = caption.transform.position; var rotation = caption.transform.rotation;
            console.SetInteractionLocked(true); eyes.rotation = Quaternion.Euler(9, 20, 0);
            console.RefreshVisuals(.1f); caption.RefreshVisuals(.1f);
            Require(caption.transform.position == prior && caption.transform.rotation == rotation, "Fallback detached from the locked bar pose.");
            eyes.rotation = Quaternion.identity; console.SetInteractionLocked(false); console.RefreshVisuals(0); caption.RefreshVisuals(0);
        }
        private static Rect Project(Transform eyes, Transform target, Vector3 center, Vector3 size)
        {
            var lo = new Vector2(float.PositiveInfinity, float.PositiveInfinity);
            var hi = new Vector2(float.NegativeInfinity, float.NegativeInfinity);
            foreach (var x in new[] { -1f, 1f }) foreach (var y in new[] { -1f, 1f })
            {
                var point = eyes.InverseTransformPoint(target.TransformPoint(center + new Vector3(size.x*x/2f,size.y*y/2f,0)));
                Require(point.z > .05f, "Synthetic footprint crossed the near plane.");
                var projected = new Vector2(point.x/point.z,point.y/point.z);
                lo = Vector2.Min(lo,projected); hi = Vector2.Max(hi,projected);
            }
            return Rect.MinMaxRect(lo.x,lo.y,hi.x,hi.y);
        }

        private static ConsoleAction[] Active(ContextConsole console) => console.GetComponentsInChildren<SpatialAction>().Select(control=>control.Action).OrderBy(action=>action).ToArray();
        private static SpatialAction Control(ContextConsole console,ConsoleAction action)=>console.GetComponentsInChildren<SpatialAction>(true).Single(control=>control.Action==action);
        private static void Ready(ContextConsole console) {console.RefreshVisuals(1f);Physics.SyncTransforms();}
        private static void CheckBar(ContextConsole console,Transform eyes,SpatialSurface bar)
        {
            var controls=bar.GetComponentsInChildren<SpatialAction>().OrderBy(control=>control.transform.localPosition.x).ToArray();
            for(var i=0;i<controls.Length;i++)
            {
                var control=controls[i];var box=control.GetComponent<BoxCollider>();var text=control.GetComponentsInChildren<TextMeshPro>().Single();text.ForceMeshUpdate();
                Require(console.HitAction(new Ray(eyes.position,control.transform.position-eyes.position),out _)==control.Action,"Bar action is not reachable at rest.");
                Require(!text.isTextOverflowing && text.textInfo.lineCount==1,"Bar label wraps or clips.");
                foreach(var glyph in text.textInfo.characterInfo.Where(glyph=>glyph.isVisible))
                {
                    var lo=control.transform.InverseTransformPoint(text.transform.TransformPoint(glyph.bottomLeft));var hi=control.transform.InverseTransformPoint(text.transform.TransformPoint(glyph.topRight));
                    Require(lo.x>=-box.size.x/2f && hi.x<=box.size.x/2f && lo.y>=-box.size.y/2f && hi.y<=box.size.y/2f,"Bar glyph escapes its target.");
                }
                if(i>0)Require(controls[i-1].transform.localPosition.x+controls[i-1].GetComponent<BoxCollider>().size.x/2f+.0119f <= control.transform.localPosition.x-box.size.x/2f,"Bar targets overlap or lose their 12 mm separation.");
                Require(Mathf.Abs(control.transform.localPosition.x)+box.size.x/2f <=bar.Size.x/2f,"Bar target escapes its shared surface.");
            }
        }
        private static void Require(bool value,string message) {if(!value)throw new InvalidOperationException(message);}
    }
}
