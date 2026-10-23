#nullable enable
using System;
using System.Linq;
using TMPro;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    public static class ActionIconValidation
    {
        public static void Validate()
        {
            var root=new GameObject("Synthetic recognizable action pictograms");
            try
            {
                // A filled glyph on every tile, the same for its action in every state: the mic on Talk, Finish and Answer,
                // Pause's bars and Resume's triangle, More's dots, Context's cards, Settings' gear, Back's chevron, Stop's
                // square, Cancel's cross, Check's circular arrow, New's plus. Every tile is one slot wide.
                foreach(var fixture in new[]{(ConsoleAction.Talk,"Talk","talk"),(ConsoleAction.FinishTalk,"Finish","talk"),(ConsoleAction.AnswerTask,"Answer","talk"),
                    (ConsoleAction.PauseScene,"Pause","pause"),(ConsoleAction.PauseScene,"Resume","resume"),(ConsoleAction.More,"More","more"),
                    (ConsoleAction.Options,"Context","context"),(ConsoleAction.Settings,"Settings","settings"),(ConsoleAction.ShelfBack,"Back","back"),
                    (ConsoleAction.Cancel,"Stop","stop"),(ConsoleAction.Cancel,"Cancel","cancel"),
                    (ConsoleAction.CheckCapture,"Check","check"),(ConsoleAction.DismissCapture,"New","new")})
                {
                    var control=SpatialAction.Create(root.transform,fixture.Item1,fixture.Item2,SpatialTheme.ShelfSlot);
                    var target=control.GetComponent<BoxCollider>();var size=target.size;var center=target.center;
                    var icon=control.GetComponentInChildren<SpatialActionIcon>();
                    Require(fixture.Item3=="" ? icon==null || !icon.Drawn : icon!=null && icon.Kind==fixture.Item3,"Pictogram does not describe its current action.");
                    Require(icon==null || icon.GetComponentsInChildren<Collider>().Length==0,"Pictogram creates a competing target.");
                    var text=control.GetComponentsInChildren<TextMeshPro>().Single();text.ForceMeshUpdate();
                    var preferred=text.GetPreferredValues(text.text,text.rectTransform.sizeDelta.x,float.PositiveInfinity);
                    var diagnostics=$"action={fixture.Item1}, label={fixture.Item2}, actual={text.text}, rect={text.rectTransform.sizeDelta.ToString("F5")}, preferred={preferred.ToString("F5")}, font={text.fontSize}, lines={text.textInfo.lineCount}, overflow={text.isTextOverflowing}, target={target.size.ToString("F5")}";
                    Debug.Log("Boopy action glyph metrics: "+diagnostics);
                    Require(text.text==fixture.Item2 && !text.isTextOverflowing && text.textInfo.lineCount==1,"Short action label changed or clips: "+diagnostics);
                    foreach(var scale in new[]{1f,1.2f})
                    {
                        root.transform.localScale=Vector3.one*scale;control.Refresh(.2f,1f,false);Physics.SyncTransforms();
                        var rightmostIcon=float.NegativeInfinity;
                        var leftmostIcon=float.PositiveInfinity;
                        foreach(var line in icon==null ? Array.Empty<LineRenderer>() : icon.GetComponentsInChildren<LineRenderer>())
                            for(var point=0;point<line.positionCount;point++)
                            {
                                var local=control.transform.InverseTransformPoint(line.transform.TransformPoint(line.GetPosition(point)));
                                var radius=line.widthMultiplier/2f;
                                Require(Mathf.Abs(local.x)+radius<size.x/2f && Mathf.Abs(local.y)+radius<size.y/2f,"Pictogram escapes the fixed control target: "+diagnostics+", scale="+scale+", point="+local.ToString("F5"));
                                rightmostIcon=Mathf.Max(rightmostIcon,local.x+radius);
                                leftmostIcon=Mathf.Min(leftmostIcon,local.x-radius);
                            }
                        if(fixture.Item3!="")
                            Require(rightmostIcon-leftmostIcon>=.008f,"Action glyph is too small to read: "+diagnostics);
                        foreach(var glyph in text.textInfo.characterInfo.Where(glyph=>glyph.isVisible))
                        {
                            var lo=control.transform.InverseTransformPoint(text.transform.TransformPoint(glyph.bottomLeft));
                            var hi=control.transform.InverseTransformPoint(text.transform.TransformPoint(glyph.topRight));
                            Require(lo.x>=-size.x/2f && hi.x<=size.x/2f && lo.y>=-size.y/2f && hi.y<=size.y/2f,"Label escapes the fixed control target: "+diagnostics+", scale="+scale+", glyph="+glyph.character+", lo="+lo.ToString("F5")+", hi="+hi.ToString("F5"));
                            Require(lo.x>rightmostIcon+.002f,"Pictogram is not horizontally separated from its label: "+diagnostics);
                        }
                    }
                    control.Focus(true);control.Press(true);control.Refresh(.2f,1f,false);
                    Require(target.size==size && target.center==center,"Icon interaction changes collider geometry.");
                    var surface=control.GetComponentsInChildren<MeshRenderer>().Single(renderer=>renderer.gameObject.name=="Action surface");
                    Require(surface.sharedMaterial.shader.name=="Boopy/ControlSatin","Control lost its dedicated matte material.");
                    control.SetInteractable(false);control.Refresh(.2f,1f,true);
                    Require(!target.enabled && text.color==SpatialTheme.Smoke,"Disabled action is still active or illegible.");
                    control.SetInteractable(true);control.Refresh(.2f,1f,true);
                    Require(target.enabled,"Restored action never recovered its target.");
                    if(fixture.Item1==ConsoleAction.PauseScene)
                    {control.Label("Resume");Require(icon!.Kind=="resume","Pause label changed without a play glyph.");control.Label("Pause");Require(icon.Kind=="pause","Resume label changed without pause bars.");}
                    if(fixture.Item1==ConsoleAction.Cancel)
                    {control.Label("Cancel");Require(icon!.Kind=="cancel","Recording cancellation retains Stop glyph.");control.Label("Stop");Require(icon.Kind=="stop","Pending wait lost its Stop glyph.");}
                    control.Refresh(1,.2f,false);Require(!target.enabled,"Invisible icon control retains a target.");
                    UnityEngine.Object.DestroyImmediate(control.gameObject);
                }
                Debug.Log("Boopy action pictogram validation passed: code-native filled glyphs matching states, label-only actions, labels, normal/large bounds and stable targets.");
            }
            finally{UnityEngine.Object.DestroyImmediate(root);}
        }
        private static void Require(bool condition,string message){if(!condition)throw new InvalidOperationException(message);}
    }
}
