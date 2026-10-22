#nullable enable
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>Normalized rounded face; its visible bounds never exceed the measured target.</summary>
    public static class RoundedPlate
    {
        public static Mesh Create(float width, float height, float radius)
        {
            width = Mathf.Max(.001f, width); height = Mathf.Max(.001f, height);
            radius = Mathf.Min(radius, Mathf.Min(width,height) * .5f);
            const int steps = 8;
            var vertices = new Vector3[1 + 4 * (steps + 1)];
            var triangles = new int[(vertices.Length - 1) * 3];
            vertices[0] = Vector3.zero;
            var index = 1;
            for (var corner=0;corner<4;corner++)
            {
                var angle = corner * 90f;
                var cx = corner == 0 || corner == 3 ? width/2f-radius : -width/2f+radius;
                var cy = corner < 2 ? height/2f-radius : -height/2f+radius;
                for(var step=0;step<=steps;step++)
                {
                    var a=(angle+step*90f/steps)*Mathf.Deg2Rad;
                    vertices[index++]=new Vector3((cx+Mathf.Cos(a)*radius)/width,(cy+Mathf.Sin(a)*radius)/height,0);
                }
            }
            for(var edge=0;edge<vertices.Length-1;edge++)
            { triangles[edge*3]=0;triangles[edge*3+1]=1+(edge+1)%(vertices.Length-1);triangles[edge*3+2]=edge+1; }
            var mesh=new Mesh {name="Boopy rounded face"};mesh.vertices=vertices;mesh.triangles=triangles;mesh.RecalculateBounds();return mesh;
        }
    }
}
