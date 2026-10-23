#nullable enable
using System.Collections.Generic;
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>
    /// Small code-native pictograms, filled as Meta's buttons are in mixed reality; labels remain the accessible action
    /// names. Every tile carries one, the same for its action in every state: a solid mic with a stroke stand on Talk,
    /// Answer and Finish; two solid bars on Pause and a solid triangle on Resume; a solid square on Stop; three solid dots
    /// on More; a circular arrow on Check; a plus on New; two cards on Context; a gear on Settings; a left chevron on
    /// Back; a cross on Cancel.
    /// </summary>
    public sealed class SpatialActionIcon : MonoBehaviour
    {
        private readonly List<LineRenderer> strokes=new List<LineRenderer>();
        public string Kind {get;private set;}="";
        // The label's color, kept so a glyph rebuilt by a relabel is drawn in it at once, never white for a frame.
        private Color tint=Color.white;
        /// <summary>True when this action's current label carries a glyph.</summary>
        public bool Drawn => strokes.Count>0;
        public static bool Supports(ConsoleAction action)=>action==ConsoleAction.Talk || action==ConsoleAction.FinishTalk || action==ConsoleAction.AnswerTask
            || action==ConsoleAction.PauseScene || action==ConsoleAction.Cancel || action==ConsoleAction.More || action==ConsoleAction.CheckCapture
            || action==ConsoleAction.DismissCapture || action==ConsoleAction.Options || action==ConsoleAction.Settings || action==ConsoleAction.ShelfBack;
        public static SpatialActionIcon Create(Transform parent)
        {
            var host=new GameObject("Action pictogram");host.transform.SetParent(parent,false);
            host.transform.localPosition=new Vector3(0,.012f,-.004f);return host.AddComponent<SpatialActionIcon>();
        }
        public void Configure(ConsoleAction action,string label)
        {
            var kind=action==ConsoleAction.PauseScene?(label.StartsWith("Resume",System.StringComparison.Ordinal)?"resume":"pause")
                :action==ConsoleAction.Cancel?(label.StartsWith("Stop",System.StringComparison.Ordinal)?"stop":"cancel")
                :action==ConsoleAction.Talk || action==ConsoleAction.AnswerTask || action==ConsoleAction.FinishTalk?"talk"
                :action==ConsoleAction.More?"more":action==ConsoleAction.CheckCapture?"check"
                :action==ConsoleAction.DismissCapture?(label=="New"?"new":"")
                :action==ConsoleAction.Options?"context":action==ConsoleAction.Settings?"settings":action==ConsoleAction.ShelfBack?"back":"";
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
                    var ring=new Vector2[13];
                    for(var i=0;i<ring.Length;i++){var a=(60f+i*270f/(ring.Length-1))*Mathf.Deg2Rad;ring[i]=new Vector2(Mathf.Cos(a),Mathf.Sin(a))*.0055f;}
                    Thick(ring);
                    Solid(new Vector2(.0028f,.0048f),new Vector2(.0028f,.0002f),.0055f,false).widthCurve=AnimationCurve.Linear(0f,1f,1f,0f);break;
                case "new":Solid(new Vector2(-.0065f,0),new Vector2(.0065f,0),.003f,false);Solid(new Vector2(0,-.0065f),new Vector2(0,.0065f),.003f,false);break;
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
            }
            Tint(tint);
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
