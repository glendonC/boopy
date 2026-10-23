#nullable enable
using System.Collections.Generic;
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>Small code-native pictograms; labels remain the accessible action names.</summary>
    public sealed class SpatialActionIcon : MonoBehaviour
    {
        private readonly List<LineRenderer> strokes=new List<LineRenderer>();
        public string Kind {get;private set;}="";
        public static bool Supports(ConsoleAction action)=>action==ConsoleAction.Talk || action==ConsoleAction.FinishTalk
            || action==ConsoleAction.PauseScene || action==ConsoleAction.Options || action==ConsoleAction.Settings || action==ConsoleAction.Cancel
            || action==ConsoleAction.AnswerTask;
        public static SpatialActionIcon Create(Transform parent)
        {
            var host=new GameObject("Action pictogram");host.transform.SetParent(parent,false);
            host.transform.localPosition=new Vector3(0,.012f,-.004f);return host.AddComponent<SpatialActionIcon>();
        }
        public void Configure(ConsoleAction action,string label)
        {
            var kind=action==ConsoleAction.PauseScene?(label.StartsWith("Resume",System.StringComparison.Ordinal)?"resume":"pause")
                :action==ConsoleAction.Cancel?(label.StartsWith("Cancel",System.StringComparison.Ordinal)?"cancel":"stop")
                :action==ConsoleAction.Talk || action==ConsoleAction.AnswerTask?"talk":action==ConsoleAction.FinishTalk?"finish":action==ConsoleAction.Options?"context":"settings";
            if(Kind==kind)return;Kind=kind;
            foreach(var stroke in strokes){stroke.gameObject.SetActive(false);if(Application.isPlaying)Destroy(stroke.gameObject);else DestroyImmediate(stroke.gameObject);}strokes.Clear();
            switch(kind)
            {
                case "talk":
                    Path(true,new Vector2(-.003f,.002f),new Vector2(-.003f,.006f),new Vector2(-.002f,.008f),new Vector2(.002f,.008f),new Vector2(.003f,.006f),new Vector2(.003f,.002f),new Vector2(.002f,0),new Vector2(-.002f,0));
                    Path(false,new Vector2(-.006f,.003f),new Vector2(-.006f,-.001f),new Vector2(-.003f,-.004f),new Vector2(.003f,-.004f),new Vector2(.006f,-.001f),new Vector2(.006f,.003f));
                    Path(false,new Vector2(0,-.004f),new Vector2(0,-.008f));Path(false,new Vector2(-.004f,-.008f),new Vector2(.004f,-.008f));break;
                case "finish":Path(false,new Vector2(-.007f,0),new Vector2(-.002f,-.005f),new Vector2(.008f,.006f));break;
                case "pause":Path(false,new Vector2(-.0035f,-.007f),new Vector2(-.0035f,.007f));Path(false,new Vector2(.0035f,-.007f),new Vector2(.0035f,.007f));break;
                case "resume":Path(true,new Vector2(-.005f,-.008f),new Vector2(-.005f,.008f),new Vector2(.008f,0));break;
                case "context":
                    Path(false,new Vector2(-.008f,-.004f),new Vector2(-.008f,.008f),new Vector2(.004f,.008f));
                    Path(true,new Vector2(-.004f,-.008f),new Vector2(-.004f,.004f),new Vector2(.008f,.004f),new Vector2(.008f,-.008f));break;
                case "settings":
                    // Connected eight-tooth perimeter and a separate hub hole: a gear, not rays.
                    var teeth=new Vector2[64];
                    for(var i=0;i<teeth.Length;i++)
                    {
                        var phase=i%8;
                        var radius=phase>=2 && phase<=5 ? .008f : .006f;
                        var angle=i*Mathf.PI*2/teeth.Length;
                        teeth[i]=new Vector2(Mathf.Cos(angle),Mathf.Sin(angle))*radius;
                    }
                    Path(true,teeth);Circle(.0025f);break;
                case "cancel":Path(false,new Vector2(-.006f,-.006f),new Vector2(.006f,.006f));Path(false,new Vector2(-.006f,.006f),new Vector2(.006f,-.006f));break;
                default:Path(true,new Vector2(-.006f,-.006f),new Vector2(-.006f,.006f),new Vector2(.006f,.006f),new Vector2(.006f,-.006f));break;
            }
        }
        private void Circle(float radius)
        {var points=new Vector2[16];for(var i=0;i<points.Length;i++){var a=i*Mathf.PI*2/points.Length;points[i]=new Vector2(Mathf.Cos(a),Mathf.Sin(a))*radius;}Path(true,points);}
        private void Path(bool loop,params Vector2[] points)
        {
            var host=new GameObject("Pictogram stroke");host.transform.SetParent(transform,false);
            var line=Visuals.Line(host,.0018f,loop,Visuals.Solid);line.useWorldSpace=false;line.sortingOrder=3;line.positionCount=points.Length;
            for(var i=0;i<points.Length;i++)line.SetPosition(i,new Vector3(points[i].x,points[i].y,0));strokes.Add(line);
        }
        public void Tint(Color color){foreach(var line in strokes)Visuals.Tint(line,color);}
    }
}
