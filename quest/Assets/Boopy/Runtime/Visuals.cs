#nullable enable
using Boopy.Client;
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>
    /// The look of everything Boopy draws, in one place. Sprites/Default is among the shaders this
    /// project always includes, so materials made at runtime never render magenta in a build.
    /// Shared ink/ivory/sand tokens keep annotations consistent with the instruments. Opaque
    /// readability plates protect text in passthrough; written states remain authoritative.
    /// </summary>
    public static class Visuals
    {
        public static readonly Color Plate = SpatialTheme.Ink;
        public static readonly Color Text = SpatialTheme.Ivory;
        public static readonly Color Proposed = new Color(0.62f, 0.67f, 0.74f, 1f);
        public static readonly Color Confirmed = new Color(0.31f, 0.82f, 0.77f, 1f);
        public static readonly Color Intent = SpatialTheme.Sand;
        public static readonly Color Question = new Color(0.98f, 0.62f, 0.33f, 1f);
        public static readonly Color Muted = new Color(0.45f, 0.5f, 0.56f, 1f);
        public static readonly Color Reticle = new Color(1f, 1f, 1f, 0.9f);
        public static readonly Color Outline = new Color(0.31f, 0.82f, 0.77f, 0.95f);

        private static Material? solid;
        private static Material? dashed;
        private static Material? softEdge;

        /// <summary>For the attended subject's edge, rim and sweep: whole across the middle of the line, fading to clear at its sides.</summary>
        public static Material SoftEdge
        {
            get
            {
                if (softEdge != null) return softEdge;
                const int size = 16;
                var texture = new Texture2D(1, size, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Clamp, filterMode = FilterMode.Bilinear };
                for (var y = 0; y < size; y++)
                {
                    var across = Mathf.Abs((y + .5f) / size * 2f - 1f);
                    texture.SetPixel(0, y, new Color(1f, 1f, 1f, 1f - Mathf.SmoothStep(.45f, 1f, across)));
                }
                texture.Apply(false, true);
                softEdge = new Material(Shader.Find("Sprites/Default")) { mainTexture = texture };
                return softEdge;
            }
        }

        /// <summary>For plates, solid lines and rings; tinted per renderer through vertex or material colour.</summary>
        public static Material Solid => solid != null ? solid : solid = new Material(Shader.Find("Sprites/Default"));

        /// <summary>For the dashed border of a model's proposal: a short repeating gap along the line.</summary>
        public static Material Dashed
        {
            get
            {
                if (dashed != null) return dashed;
                var texture = new Texture2D(8, 1, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Repeat, filterMode = FilterMode.Point };
                for (var x = 0; x < 8; x++) texture.SetPixel(x, 0, x < 5 ? Color.white : Color.clear);
                texture.Apply(false, true);
                dashed = new Material(Shader.Find("Sprites/Default")) { mainTexture = texture };
                return dashed;
            }
        }

        public static Color Border(ChipTone tone) => tone switch
        {
            ChipTone.Confirmed => Confirmed,
            ChipTone.Intent => Intent,
            ChipTone.Question => Question,
            ChipTone.Proposed => Proposed,
            _ => Muted,
        };

        public static LineRenderer Line(GameObject host, float width, bool loop, Material material)
        {
            var line = host.AddComponent<LineRenderer>();
            line.sharedMaterial = material;
            line.useWorldSpace = true;
            line.loop = loop;
            line.widthMultiplier = width;
            line.numCapVertices = 2;
            line.numCornerVertices = 2;
            line.textureMode = LineTextureMode.Tile;
            line.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            line.receiveShadows = false;
            return line;
        }

        public static void Tint(LineRenderer line, Color color)
        {
            line.startColor = color;
            line.endColor = color;
        }

        /// <summary>A unit quad facing +Z, for backplates.</summary>
        public static Mesh Quad()
        {
            var mesh = new Mesh { name = "Boopy plate" };
            mesh.vertices = new[]
            {
                new Vector3(-0.5f, -0.5f, 0f), new Vector3(0.5f, -0.5f, 0f),
                new Vector3(0.5f, 0.5f, 0f), new Vector3(-0.5f, 0.5f, 0f),
            };
            mesh.uv = new[] { Vector2.zero, Vector2.right, Vector2.one, Vector2.up };
            mesh.triangles = new[] { 0, 2, 1, 0, 3, 2 };
            mesh.RecalculateBounds();
            return mesh;
        }
    }
}
