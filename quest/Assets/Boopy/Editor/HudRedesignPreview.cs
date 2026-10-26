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
    /// <summary>Production components with synthetic content/time; not provider latency or headset evidence.</summary>
    public static class HudRedesignPreview
    {
        private const string Output="/tmp/boopy-hud-redesign";
        private const string Reply="This looks like a painting. 그림 means painting in Korean. The label is unclear, so I can't confirm its title.";
        public static void RenderAll() { Render(); RenderMotion(); CompanionPreview.Render(); }
        public static void Render()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);
            ScriptCoverage.Install();Directory.CreateDirectory(Output);
            foreach(var large in new[]{false,true})
                foreach(var state in new[]{"checking","connected","unavailable","listening","thinking","response","settings","context","fallback","fallback-settings"})
                    RenderState(state,large);
            File.WriteAllText(Path.Combine(Output,"README.txt"),
                "Synthetic production-component previews. 1600x1000, vertical FOV 64 degrees, neutral eyes.\n"+
                "No private frames/audio/transcripts, live provider timing, stereo comfort or wearer acceptance.\n"+
                "Opening and transition suffixes are synthetic elapsed milliseconds. Thinking phases use actual visual refresh clocks.\n");
            Debug.Log("Boopy HUD redesign production synthetic previews: "+Output);
        }
        public static void RenderMotion()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);ScriptCoverage.Install();
            var output=Path.Combine(Output,"motion");Directory.CreateDirectory(output);
            var root=new GameObject("Synthetic production HUD motion");
            RenderTexture? target=null;Texture2D? pixels=null;var prior=RenderTexture.active;
            try
            {
                var eyes=new GameObject("Synthetic motion viewer").transform;eyes.SetParent(root.transform,false);
                var camera=eyes.gameObject.AddComponent<Camera>();camera.fieldOfView=64;camera.aspect=1.6f;
                camera.nearClipPlane=.05f;camera.clearFlags=CameraClearFlags.SolidColor;camera.backgroundColor=new Color(.15f,.17f,.19f);
                var console=ContextConsole.Create(root.transform,eyes);
                var follow=root.AddComponent<FollowConsole>();follow.Initialize(eyes,console.transform);console.Place(follow.DesiredPosition);
                var dialogue=DialogueStrip.Create(root.transform,eyes);console.DockDialogue(dialogue);
                console.SetConnectionStatus("checking",false);
                var watermark=SpatialTheme.Text(eyes,"Synthetic preview disclosure",SpatialTheme.Utility,SpatialTheme.Smoke);
                watermark.text="Synthetic UI sequence · no live model or audio playback";
                watermark.alignment=TextAlignmentOptions.Center;watermark.rectTransform.sizeDelta=new Vector2(.9f,.04f);
                watermark.transform.localPosition=new Vector3(0,.46f,1.1f);
                // A synthetic 22050 Hz PCM waveform feeds the production RMS activity function.
                // Its cursor advances with the renderer; no AudioSource, microphone or voice provider runs.
                const int sampleRate=22050;var samples=new float[sampleRate*2];
                for(var i=0;i<samples.Length;i++)
                {
                    var t=i/(float)sampleRate;
                    var envelope=Mathf.Pow(Mathf.Max(0,Mathf.Sin(t*2.7f*Mathf.PI)),2f)*.30f;
                    samples[i]=Mathf.Sin(2*Mathf.PI*180*t)*envelope;
                }
                target=new RenderTexture(1200,750,24);target.Create();camera.targetTexture=target;
                pixels=new Texture2D(1200,750,TextureFormat.RGB24,false);
                var metrics=new System.Text.StringBuilder("frame,synthetic_seconds,stage,pcm_activity\n");
                var previous=-1;
                for(var frame=0;frame<240;frame++)
                {
                    var t=frame/30f;
                    var stage=t<.5f?0:t<1.3f?1:t<2.5f?2:t<4f?3:t<5.7f?4:t<6.5f?5:t<7.2f?6:t<7.7f?7:8;
                    if(stage!=previous)
                    {
                        console.SetSpeaking(0);
                        if(stage==1)console.SetConnectionStatus("connected",true);
                        if(stage==2 || stage==5)
                        {console.ShowListening();console.SetButtonRecording(true);dialogue.Show(DialogueStage.Listening,"Listening");}
                        if(stage==3 || stage==6)
                        {console.SetButtonRecording(false);console.ShowProcessing();dialogue.Show(DialogueStage.Working,"Thinking");dialogue.SetCancelableWait(true);}
                        if(stage==4)
                        {console.Render(View());dialogue.SetCancelableWait(false);dialogue.Show(DialogueStage.Response,Reply);}
                        if(stage==7)
                        {console.SetButtonRecording(false);dialogue.SetCancelableWait(false);console.ShowError("Synthetic connection failure. Try Talk again.");dialogue.Show(DialogueStage.Error,"Synthetic connection failure. Try Talk again.");}
                        if(stage==8)
                        {dialogue.Hide();console.ShowCapture();console.SetConnectionStatus("connected",true);}
                        previous=stage;
                    }
                    var activity=stage==4?SpeechPlayback.EnergyAt(samples,Mathf.RoundToInt((t-4f)*sampleRate)):0;
                    console.SetSpeaking(activity);
                    foreach(var text in root.GetComponentsInChildren<TextMeshPro>())text.ForceMeshUpdate();
                    // Production render paths use a capped timestep; use two real visual updates per frame.
                    var delta=frame==0?0:1f/60f;
                    console.RefreshVisuals(delta);dialogue.RefreshVisuals(delta);
                    console.RefreshVisuals(delta);dialogue.RefreshVisuals(delta);Physics.SyncTransforms();
                    camera.Render();RenderTexture.active=target;pixels.ReadPixels(new Rect(0,0,1200,750),0,0);pixels.Apply();
                    File.WriteAllBytes(Path.Combine(output,"frame"+frame.ToString("D4")+".png"),pixels.EncodeToPNG());
                    metrics.Append(frame).Append(',').Append(t.ToString("F4",System.Globalization.CultureInfo.InvariantCulture)).Append(',').Append(stage).Append(',').Append(activity.ToString("F5",System.Globalization.CultureInfo.InvariantCulture)).Append('\n');
                }
                File.WriteAllText(Path.Combine(output,"activity.csv"),metrics.ToString());
                File.WriteAllText(Path.Combine(output,"README.txt"),
                    "SYNTHETIC production-component UI sequence. 240 frames,30fps,8 seconds,1200x750,64-degree vertical FOV.\n"+
                    "0-.5 checking entrance;.5-1.3 connected;1.3-2.5 button listening with Finish/Cancel;2.5-4 Thinking;4-5.7 exact reply with measured synthetic PCM activity;5.7-6.5 interruption/new listening;6.5-7.2 Thinking;7.2-7.7 synthetic error/retry;7.7-8 recovered opening.\n"+
                    "All phase durations are authored demonstration timing, not measured provider work. No fake progress stages/percentages.\n"+
                    "Speech activity is production SpeechPlayback.EnergyAt RMS from an in-memory synthetic22050Hz180Hz tone with amplitude envelope; activity.csv records the actual values. No audio playback, real voice/microphone, model request, private capture or wearer comfort evidence.\n");
                camera.targetTexture=null;Debug.Log("Boopy synthetic production HUD motion frames: "+output);
            }
            finally
            {RenderTexture.active=prior;if(pixels!=null)UnityEngine.Object.DestroyImmediate(pixels);if(target!=null)UnityEngine.Object.DestroyImmediate(target);UnityEngine.Object.DestroyImmediate(root);}
        }

        private static void RenderState(string state,bool large)
        {
            var root=new GameObject("Synthetic HUD redesign "+state);
            RenderTexture? target=null;Texture2D? pixels=null;var prior=RenderTexture.active;
            try
            {
                var eyes=new GameObject("Synthetic viewer").transform;eyes.SetParent(root.transform,false);
                var camera=eyes.gameObject.AddComponent<Camera>();camera.fieldOfView=64;camera.aspect=1.6f;
                camera.nearClipPlane=.05f;camera.clearFlags=CameraClearFlags.SolidColor;
                camera.backgroundColor=new Color(.15f,.17f,.19f);
                var console=ContextConsole.Create(root.transform,eyes);
                var follow=root.AddComponent<FollowConsole>();follow.Initialize(eyes,console.transform);console.Place(follow.DesiredPosition);
                console.SetConnectionStatus(state=="checking"?"checking":state=="unavailable"?"unavailable":"connected",state!="checking" && state!="unavailable");
                if(large)console.Activate(ConsoleAction.Size);
                var dialogue=DialogueStrip.Create(root.transform,eyes);console.DockDialogue(dialogue);
                if(state=="listening")
                {console.ShowListening();console.SetButtonRecording(true);dialogue.Show(DialogueStage.Listening,"Listening");}
                if(state=="thinking")
                {console.ShowProcessing();dialogue.Show(DialogueStage.Working,"Thinking");dialogue.SetCancelableWait(true);}
                if(state=="response" || state=="context" || state.StartsWith("fallback",StringComparison.Ordinal))
                {
                    console.Render(View());dialogue.Show(DialogueStage.Response,Reply);
                    if(state=="context")console.Activate(ConsoleAction.Options);
                    if(state.StartsWith("fallback",StringComparison.Ordinal))
                    {console.ShowControlsOnly(console.transform.position);dialogue.SetFallback(true);}
                }
                if(state=="settings" || state=="fallback-settings")console.Activate(ConsoleAction.Settings);
                target=new RenderTexture(1600,1000,24);target.Create();camera.targetTexture=target;
                pixels=new Texture2D(1600,1000,TextureFormat.RGB24,false);
                var times=state=="connected" || state=="response" ? new[]{0f,.08f,.16f,.32f}
                    : state=="thinking" ? new[]{.32f,.82f,1.32f,1.82f}:new[]{.32f};
                // All surfaces share the same reveal start; no fake frame-counted backend stages.
                foreach(var surface in console.GetComponentsInChildren<SpatialSurface>())surface.Assemble(0,false);
                var elapsed=0f;
                foreach(var time in times)
                {
                    foreach(var text in root.GetComponentsInChildren<TextMeshPro>())text.ForceMeshUpdate();
                    var delta=time-elapsed;elapsed=time;
                    // Small deterministic steps exercise the production animation, not a redrawn mockup.
                    while(delta>.00001f)
                    {var step=Mathf.Min(delta,1f/120f);console.RefreshVisuals(step);dialogue.RefreshVisuals(step);delta-=step;}
                    console.RefreshVisuals(0);dialogue.RefreshVisuals(0);
                    Physics.SyncTransforms();camera.Render();RenderTexture.active=target;
                    pixels.ReadPixels(new Rect(0,0,1600,1000),0,0);pixels.Apply();
                    File.WriteAllBytes(Path.Combine(Output,state+(large?"-large":"-standard")+"-"+Mathf.RoundToInt(time*1000).ToString("D4")+"ms.png"),pixels.EncodeToPNG());
                }
                camera.targetTexture=null;
            }
            finally
            {
                RenderTexture.active=prior;if(pixels!=null)UnityEngine.Object.DestroyImmediate(pixels);
                if(target!=null)UnityEngine.Object.DestroyImmediate(target);UnityEngine.Object.DestroyImmediate(root);
            }
        }
        private static SessionView View()
        {
            var view=new SessionView {Id="synthetic-redesign",State="review",ReferentId="synthetic-painting",SpeechOutputAvailable=true,
                Model=new ModelRef {Provider="fixture",Id="synthetic"},
                Dialogue=new DialogueView {Speaker="boopy",UtteranceId="synthetic-turn",At="1970-01-01T12:00:00Z",Text=Reply}};
            view.Utterances.Add(new UtteranceRef {Id="synthetic-turn",Text="What is this called in Korean?",Kind="ask"});
            view.Items.Add(new Item {Id="synthetic-painting",Kind="object",Label="Painting",Statement="A painting is proposed; the title is unknown.",Origin="model",Status="proposed",Confidence=.6f,Grounding=new Grounding {Kind="scene"}});
            return view;
        }
    }
}
