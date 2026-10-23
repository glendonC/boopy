#nullable enable
using System.Collections.Generic;
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>
    /// Small code-native pictograms, filled as Meta's buttons are in mixed reality; labels remain the accessible action
    /// names. Every tile carries one, one meaning each and the same for its action everywhere: a solid mic with a stroke
    /// stand on Talk, Answer and Finish; two solid bars on Pause and a solid triangle on Resume; a solid square on Stop;
    /// three solid dots on More; a circular arrow on Check and Retry; a plus on New and Include and a minus on Exclude; two
    /// cards on Context; a gear on Settings; a left chevron on Back; a cross on Cancel and Dismiss; a camera on View and a
    /// camera with a slash on No view; a check mark on Choose, Use and Confirm; a speech bubble on Ask; a tray with an up
    /// arrow on Prepare; three short bars on Review; an i in a circle on Status; a framed picture on Source; and on each
    /// setting's Turn on or Turn off its own glyph: a T for Large text, a speaker for Sound, a dot with speed lines for
    /// Reduced motion, a waveform for Voice and the camera for Photo.
    /// </summary>
    public sealed class SpatialActionIcon : MonoBehaviour
    {
        private readonly List<LineRenderer> strokes=new List<LineRenderer>();
        public string Kind {get;private set;}="";
        // The label's color, kept so a glyph rebuilt by a relabel is drawn in it at once, never white for a frame.
        private Color tint=Color.white;
        /// <summary>True when this action's current label carries a glyph.</summary>
        public bool Drawn => strokes.Count>0;
        /// <summary>The glyph an action carries under a label; empty for none.</summary>
        public static string KindFor(ConsoleAction action,string label)=>action switch
        {
            ConsoleAction.PauseScene=>label.StartsWith("Resume",System.StringComparison.Ordinal)?"resume":"pause",
            ConsoleAction.Cancel=>label.StartsWith("Stop",System.StringComparison.Ordinal)?"stop":"cancel",
            ConsoleAction.Talk or ConsoleAction.AnswerTask or ConsoleAction.FinishTalk=>"talk",
            ConsoleAction.More=>"more",
            ConsoleAction.CheckCapture=>"check",
            ConsoleAction.DismissCapture=>label=="New"?"new":label=="Dismiss"?"cancel":"",
            ConsoleAction.Options=>"context",
            ConsoleAction.Settings=>"settings",
            ConsoleAction.ShelfBack or ConsoleAction.Back=>"back",
            ConsoleAction.UseSpokenOnly=>"no-camera",
            ConsoleAction.UseCurrentView or ConsoleAction.EvidenceSource=>"camera",
            ConsoleAction.SendChoice or ConsoleAction.Save or ConsoleAction.Confirm=>"confirm",
            ConsoleAction.FollowUpOne or ConsoleAction.FollowUpTwo=>"ask",
            ConsoleAction.PrepareSave=>"prepare",
            ConsoleAction.Review=>"review",
            ConsoleAction.Handoff=>label=="Check" || label=="Retry"?"check":label=="Prepare"?"prepare":label=="Status"?"status":"",
            ConsoleAction.ToggleIncluded=>label=="Include"?"include":label=="Exclude"?"minus":"",
            ConsoleAction.ToggleDetails=>"source",
            ConsoleAction.Size=>"text",
            ConsoleAction.Sound=>"sound",
            ConsoleAction.Motion=>"motion",
            ConsoleAction.Speech=>"voice",
            _=>"",
        };
        public static SpatialActionIcon Create(Transform parent)
        {
            var host=new GameObject("Action pictogram");host.transform.SetParent(parent,false);
            host.transform.localPosition=new Vector3(0,.012f,-.004f);return host.AddComponent<SpatialActionIcon>();
        }
        public void Configure(ConsoleAction action,string label)
        {
            var kind=KindFor(action,label);
            if(Kind==kind)return;Kind=kind;
            foreach(var stroke in strokes){stroke.gameObject.SetActive(false);if(Application.isPlaying)Destroy(stroke.gameObject);else DestroyImmediate(stroke.gameObject);}strokes.Clear();
            switch(kind)
            {
                case "talk":
                    // A solid capsule head on a stroke stand.
                    Solid(new Vector2(0,.0025f),new Vector2(0,.0055f),.0065f,true);
                    Path(false,new Vector2(-.0055f,.003f),new Vector2(-.0055f,0),new Vector2(-.003f,-.003f),new Vector2(.003f,-.003f),new Vector2(.0055f,0),new Vector2(.0055f,.003f));
                    Path(false,new Vector2(0,-.003f),new Vector2(0,-.0075f));Path(false,new Vector2(-.0035f,-.0075f),new Vector2(.0035f,-.0075f));break;
                case "pause":Solid(new Vector2(-.0035f,-.007f),new Vector2(-.0035f,.007f),.0035f,false);Solid(new Vector2(.0035f,-.007f),new Vector2(.0035f,.007f),.0035f,false);break;
                case "resume":Solid(new Vector2(-.005f,0),new Vector2(.006f,0),.013f,false).widthCurve=AnimationCurve.Linear(0f,1f,1f,0f);break;
                case "stop":Solid(new Vector2(-.0055f,0),new Vector2(.0055f,0),.011f,false);break;
                case "more":foreach(var x in new[]{-.0065f,0f,.0065f})Solid(new Vector2(x-.0001f,0),new Vector2(x+.0001f,0),.0035f,true);break;
                case "check":
                    // Three quarters of a ring, thick, ending in an arrowhead: check again.
                    Thick(Arc(Vector2.zero,.0055f,60f,330f,13));
                    Solid(new Vector2(.0028f,.0048f),new Vector2(.0028f,.0002f),.0055f,false).widthCurve=AnimationCurve.Linear(0f,1f,1f,0f);break;
                case "new":case "include":Solid(new Vector2(-.0065f,0),new Vector2(.0065f,0),.003f,false);Solid(new Vector2(0,-.0065f),new Vector2(0,.0065f),.003f,false);break;
                case "minus":Solid(new Vector2(-.0065f,0),new Vector2(.0065f,0),.003f,false);break;
                case "context":
                    // Two cards: the one behind as a stroke, the one in front solid.
                    Path(true,new Vector2(-.0075f,-.0015f),new Vector2(-.0075f,.0075f),new Vector2(.0015f,.0075f),new Vector2(.0015f,-.0015f));
                    Solid(new Vector2(-.0035f,-.0025f),new Vector2(.0075f,-.0025f),.0095f,false);break;
                case "settings":
                    // A connected eight-tooth gear in a thick stroke, around a hub hole.
                    var teeth=new Vector2[64];
                    for(var i=0;i<teeth.Length;i++){var phase=i%8;var radius=phase>=2 && phase<=5 ? .0072f : .0055f;var a=i*Mathf.PI*2/teeth.Length;teeth[i]=new Vector2(Mathf.Cos(a),Mathf.Sin(a))*radius;}
                    Thick(teeth,true);break;
                case "back":Thick(new[]{new Vector2(.003f,.0065f),new Vector2(-.003f,0),new Vector2(.003f,-.0065f)});break;
                case "cancel":Solid(new Vector2(-.0055f,-.0055f),new Vector2(.0055f,.0055f),.0028f,false);Solid(new Vector2(-.0055f,.0055f),new Vector2(.0055f,-.0055f),.0028f,false);break;
                case "camera":case "no-camera":
                    // A camera body in a thick stroke, its viewfinder bump and its lens ring; No view crosses it out.
                    Thick(new[]{new Vector2(-.0072f,-.0058f),new Vector2(.0072f,-.0058f),new Vector2(.0072f,.0038f),new Vector2(-.0072f,.0038f)},true);
                    Solid(new Vector2(-.0028f,.0052f),new Vector2(.0028f,.0052f),.0026f,false);
                    Thick(Arc(new Vector2(0,-.001f),.0026f,0f,360f,16),true);
                    if(kind=="no-camera")Solid(new Vector2(-.0085f,-.0078f),new Vector2(.0085f,.0072f),.0024f,false);break;
                case "confirm":Thick(new[]{new Vector2(-.0058f,-.0002f),new Vector2(-.0018f,-.0042f),new Vector2(.0062f,.0048f)});break;
                case "ask":
                    // A solid speech bubble with its tail down and left.
                    Solid(new Vector2(-.0035f,.0015f),new Vector2(.0035f,.0015f),.0085f,true);
                    Solid(new Vector2(-.0032f,-.0022f),new Vector2(-.0052f,-.0068f),.0042f,false).widthCurve=AnimationCurve.Linear(0f,1f,1f,0f);break;
                case "prepare":
                    // A tray, and an arrow up out of it.
                    Thick(new[]{new Vector2(-.0068f,-.0012f),new Vector2(-.0068f,-.0068f),new Vector2(.0068f,-.0068f),new Vector2(.0068f,-.0012f)});
                    Thick(new[]{new Vector2(0,-.0035f),new Vector2(0,.0068f)});
                    Thick(new[]{new Vector2(-.0036f,.0032f),new Vector2(0,.0068f),new Vector2(.0036f,.0032f)});break;
                case "review":foreach(var y in new[]{.0048f,0f,-.0048f})Solid(new Vector2(-.0062f,y),new Vector2(.0062f,y),.0026f,false);break;
                case "status":
                    // An i in a ring.
                    Thick(Arc(Vector2.zero,.0068f,0f,360f,24),true);
                    Solid(new Vector2(0,.0033f),new Vector2(.0001f,.0033f),.0026f,true);
                    Solid(new Vector2(0,-.0040f),new Vector2(0,.0008f),.0026f,false);break;
                case "source":
                    // A framed picture: a frame, a ridge and a sun.
                    Thick(new[]{new Vector2(-.0072f,-.0060f),new Vector2(.0072f,-.0060f),new Vector2(.0072f,.0060f),new Vector2(-.0072f,.0060f)},true);
                    Thick(new[]{new Vector2(-.0058f,-.0042f),new Vector2(-.0018f,.0004f),new Vector2(.0008f,-.0020f),new Vector2(.0030f,-.0002f),new Vector2(.0058f,-.0042f)});
                    Solid(new Vector2(.0030f,.0030f),new Vector2(.0031f,.0030f),.0026f,true);break;
                case "text":Solid(new Vector2(-.0065f,.0058f),new Vector2(.0065f,.0058f),.0030f,false);Solid(new Vector2(0,.0058f),new Vector2(0,-.0070f),.0034f,false);break;
                case "sound":
                    // A speaker: a box, its cone, and one wave.
                    Solid(new Vector2(-.0072f,0),new Vector2(-.0042f,0),.0050f,false);
                    Solid(new Vector2(-.0042f,0),new Vector2(-.0002f,0),.0120f,false).widthCurve=AnimationCurve.Linear(0f,.42f,1f,1f);
                    Thick(Arc(new Vector2(.0002f,0),.0058f,-50f,50f,7));break;
                case "motion":
                    // A dot moving right, speed lines behind it.
                    Solid(new Vector2(.0034f,0),new Vector2(.0035f,0),.0068f,true);
                    foreach(var y in new[]{.0026f,-.0026f})Solid(new Vector2(-.0074f,y),new Vector2(-.0016f,y),.0022f,true);break;
                case "voice":
                    // A waveform: five bars, tallest in the middle.
                    var heights=new[]{.0030f,.0080f,.0120f,.0080f,.0030f};
                    for(var i=0;i<heights.Length;i++){var x=(i-2)*.0033f;Solid(new Vector2(x,-heights[i]/2f),new Vector2(x,heights[i]/2f),.0021f,true);}break;
            }
            Tint(tint);
        }
        private static Vector2[] Arc(Vector2 center,float radius,float from,float to,int count)
        {
            var points=new Vector2[count];
            for(var i=0;i<count;i++){var a=(from+i*(to-from)/(count-1))*Mathf.Deg2Rad;points[i]=center+new Vector2(Mathf.Cos(a),Mathf.Sin(a))*radius;}
            return points;
        }
        // A filled shape: one wide stroke, with round caps for a capsule or a dot, square for a bar or a square.
        private LineRenderer Solid(Vector2 from,Vector2 to,float width,bool round)
        {
            var host=new GameObject("Pictogram fill");host.transform.SetParent(transform,false);
            var line=Visuals.Line(host,width,false,Visuals.Solid);line.useWorldSpace=false;line.sortingOrder=3;line.positionCount=2;
            line.numCapVertices=round?8:0;line.SetPosition(0,new Vector3(from.x,from.y,0));line.SetPosition(1,new Vector3(to.x,to.y,0));strokes.Add(line);
            return line;
        }
        // A filled stroke along a path: thick enough to read as solid, with round joints.
        private void Thick(Vector2[] points,bool loop=false)
        {
            var host=new GameObject("Pictogram fill");host.transform.SetParent(transform,false);
            var line=Visuals.Line(host,.0026f,loop,Visuals.Solid);line.useWorldSpace=false;line.sortingOrder=3;line.positionCount=points.Length;
            line.numCapVertices=4;line.numCornerVertices=4;
            for(var i=0;i<points.Length;i++)line.SetPosition(i,new Vector3(points[i].x,points[i].y,0));strokes.Add(line);
        }
        private void Path(bool loop,params Vector2[] points)
        {
            var host=new GameObject("Pictogram stroke");host.transform.SetParent(transform,false);
            var line=Visuals.Line(host,.0016f,loop,Visuals.Solid);line.useWorldSpace=false;line.sortingOrder=3;line.positionCount=points.Length;
            for(var i=0;i<points.Length;i++)line.SetPosition(i,new Vector3(points[i].x,points[i].y,0));strokes.Add(line);
        }
        public void Tint(Color color){tint=color;foreach(var line in strokes)Visuals.Tint(line,color);}
        /// <summary>The drawn glyph's left and right in its own frame, each stroke's half width included.</summary>
        public (float Low,float High) Extent()
        {
            float low=float.PositiveInfinity,high=float.NegativeInfinity;
            foreach(var line in strokes)
                for(var i=0;i<line.positionCount;i++){var x=line.GetPosition(i).x;low=Mathf.Min(low,x-line.widthMultiplier/2f);high=Mathf.Max(high,x+line.widthMultiplier/2f);}
            return (low,high);
        }
    }
}
