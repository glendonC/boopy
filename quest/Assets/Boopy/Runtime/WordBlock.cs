#nullable enable
using Boopy.Client;
using TMPro;
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>
    /// The word on the subject, in a recorded picture's plane: the outside word for Boopy's guess (the task's term) in the
    /// large line, the guess in a small line under it, and where the word came from in a tiny line; when the person's last
    /// attempt at the word was not heard, "Didn't hear it last time" under them and an Ember underline under the word.
    /// Without a term the guess alone is the large line. No box: the word sits on the thing, as a pickup's name sits by it in
    /// Dead Space and a door's prompt on its panel in Star Citizen (DESIGN's references). Its ink is chosen once from the
    /// picture under it: Graphite on bright footage, Frost on dark, with a thin halo of the other tone, and a Graphite scrim
    /// only where neither ink reaches 4.5:1. The words themselves are the service's fields, never composed here.
    /// </summary>
    public sealed class WordBlock : MonoBehaviour
    {
        // Angular em sizes (DESIGN): the word about 2 degrees, the guess 1, the source 0.8, the memory line as the guess.
        public const float TermDegrees = 2.0f, GuessDegrees = 1.0f, SourceDegrees = .8f;
        public const string Memory = "Didn't hear it last time", HeardMemory = "Heard it last time";
        // The scrim is the caption's shading (DESIGN): behind each line, full over the line's own extent and fading to clear
        // this much of its height beyond it on every side, so no edge or corner shows.
        private const float ScrimReach = .3f, ScrimStrength = .7f;
        public static readonly Color Graphite = new Color(20f / 255f, 27f / 255f, 33f / 255f, 1f);
        public static readonly Color Frost = new Color(241f / 255f, 245f / 255f, 245f / 255f, 1f);
        private const float Minimum = 4.5f, BrightenSeconds = .4f;

        private TextMeshPro? term, guess, source, memory;
        private LineRenderer? underline;
        private MeshRenderer? scrim;
        private Mesh? scrimMesh;
        private float brightenAge = float.PositiveInfinity;
        private bool reduced;

        public string Term => term != null && term.gameObject.activeSelf ? term.text : "";
        public string Guess => guess != null && guess.gameObject.activeSelf ? guess.text : "";
        public string Source => source != null && source.gameObject.activeSelf ? source.text : "";
        public bool Remembers => memory != null && memory.gameObject.activeSelf;
        public Color Ink { get; private set; } = Frost;
        public bool Scrimmed => scrim != null && scrim.enabled;
        /// <summary>The block's size in meters, its lines stacked; its center is its transform's position.</summary>
        public Vector2 Size { get; private set; }
        /// <summary>Each shown line's rectangle in the block's own meters (x right, y up from its center).</summary>
        public System.Collections.Generic.IReadOnlyList<Rect> Lines => lines;
        private readonly System.Collections.Generic.List<Rect> lines = new System.Collections.Generic.List<Rect>();
        /// <summary>How strong the Ember glow behind the word is, 0 at rest, up to 1 at the height of a brighten.</summary>
        public float Brightness => brightenAge < BrightenSeconds ? Mathf.Sin(brightenAge / BrightenSeconds * Mathf.PI) : 0f;
        /// <summary>The large line's center, where Boopy points.</summary>
        public Vector3 WordPosition => term != null ? term.transform.position : transform.position;

        /// <summary>Whether a point lies on the shown block, or within <paramref name="margin"/> meters of it.</summary>
        public bool Covers(Vector3 point, float margin)
        {
            if (!gameObject.activeInHierarchy) return false;
            var local = transform.InverseTransformPoint(point);
            return Mathf.Abs(local.x) <= Size.x / 2f + margin && Mathf.Abs(local.y) <= Size.y / 2f + margin;
        }

        public static WordBlock Create(Transform parent)
        {
            var go = new GameObject("Word on the subject");
            go.transform.SetParent(parent, false);
            var block = go.AddComponent<WordBlock>();
            var plate = new GameObject("Word scrim"); plate.transform.SetParent(go.transform, false);
            plate.transform.localPosition = new Vector3(0f, 0f, .001f);
            block.scrimMesh = new Mesh { name = "Word scrim" };
            plate.AddComponent<MeshFilter>().sharedMesh = block.scrimMesh;
            block.scrim = plate.AddComponent<MeshRenderer>(); block.scrim.sharedMaterial = Visuals.Solid; block.scrim.sortingOrder = 1;
            block.scrim.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            block.scrim.enabled = false;
            var tint = new MaterialPropertyBlock(); tint.SetColor("_Color", new Color(Graphite.r, Graphite.g, Graphite.b, ScrimStrength)); block.scrim.SetPropertyBlock(tint);
            block.term = block.Line("Term", true);
            block.guess = block.Line("Guess", false);
            block.source = block.Line("Source", false);
            block.memory = block.Line("Memory", false);
            block.underline = Visuals.Line(new GameObject("Memory underline"), .002f, false, Visuals.Solid);
            block.underline.transform.SetParent(go.transform, false);
            block.underline.useWorldSpace = false; block.underline.positionCount = 2; block.underline.sortingOrder = 4;
            go.SetActive(false);
            return block;
        }

        private TextMeshPro Line(string name, bool emphasized)
        {
            var text = SpatialTheme.Text(transform, name, emphasized ? SpatialTheme.Title : SpatialTheme.Utility, Frost);
            text.alignment = TextAlignmentOptions.Center;
            text.textWrappingMode = TextWrappingModes.NoWrap;
            text.rectTransform.sizeDelta = new Vector2(4f, .1f);
            // Each line keeps its own material, so its halo can take the other tone.
            text.fontMaterial = new Material(text.fontSharedMaterial);
            return text;
        }

        /// <summary>
        /// Shows the block's words at <paramref name="distance"/> meters from the eyes: the term (or, with none, the guess)
        /// large, the guess small under a term, the source only with a term, and the memory line when given: <see cref="Memory"/>
        /// with its Ember underline, or <see cref="HeardMemory"/> with none.
        /// </summary>
        public void Show(string? termText, string guessText, string? sourceText, string? memoryLine, float distance, bool reducedMotion)
        {
            if (term == null || guess == null || source == null || memory == null || underline == null) return;
            reduced = reducedMotion;
            var hasTerm = !string.IsNullOrWhiteSpace(termText);
            var lines = new (TextMeshPro Text, string Words, float Degrees, bool Shown)[]
            {
                (term, ScriptCoverage.Prepare(hasTerm ? termText : guessText), TermDegrees, true),
                (guess, ScriptCoverage.Prepare(guessText), GuessDegrees, hasTerm),
                (source, ScriptCoverage.Prepare(sourceText), SourceDegrees, hasTerm && !string.IsNullOrWhiteSpace(sourceText)),
                (memory, memoryLine ?? "", GuessDegrees, hasTerm && memoryLine != null),
            };
            var top = 0f; var width = 0f; var gap = .2f * Em(GuessDegrees, distance);
            foreach (var (text, words, degrees, shown) in lines)
            {
                text.gameObject.SetActive(shown);
                if (!shown) continue;
                text.text = words;
                text.transform.localScale = Vector3.one;
                text.ForceMeshUpdate(true, true);
                // One em at the asked angle. A TextMeshPro em is a tenth of its font size in its own units.
                var em = Mathf.Max(1e-5f, text.fontSize / 10f);
                var scale = Em(degrees, distance) / em;
                text.transform.localScale = Vector3.one * scale;
                var size = text.GetPreferredValues(words) * scale;
                text.transform.localPosition = new Vector3(0f, -(top + size.y / 2f), -.002f);
                top += size.y + gap;
                width = Mathf.Max(width, size.x);
            }
            top -= gap;
            // Center the stack on the transform.
            this.lines.Clear();
            foreach (var (text, words, _, shown) in lines)
            {
                if (!shown) continue;
                text.transform.localPosition += new Vector3(0f, top / 2f, 0f);
                var size = text.GetPreferredValues(words) * text.transform.localScale.x;
                this.lines.Add(new Rect(-size.x / 2f, text.transform.localPosition.y - size.y / 2f, size.x, size.y));
            }
            Size = new Vector2(width, top);
            underline.enabled = memory.gameObject.activeSelf && memoryLine == Memory;
            if (underline.enabled)
            {
                var below = term.transform.localPosition.y - term.GetPreferredValues(term.text).y * term.transform.localScale.y / 2f - .1f * gap;
                var half = term.GetPreferredValues(term.text).x * term.transform.localScale.x / 2f;
                underline.widthMultiplier = .0012f * distance;
                underline.SetPosition(0, new Vector3(-half, below, -.002f)); underline.SetPosition(1, new Vector3(half, below, -.002f));
                Visuals.Tint(underline, SpatialTheme.Ember);
            }
            Shade();
            gameObject.SetActive(true);
            Paint();
        }

        // The scrim's soft shading behind each shown line, in the block's own meters.
        private void Shade()
        {
            if (scrimMesh == null) return;
            var vertices = new System.Collections.Generic.List<Vector3>(); var colors = new System.Collections.Generic.List<Color>();
            var triangles = new System.Collections.Generic.List<int>();
            foreach (var line in lines)
            {
                var reach = ScrimReach * line.height;
                float[] xs = { line.xMin - reach, line.xMin, line.xMax, line.xMax + reach }, ys = { line.yMin - reach, line.yMin, line.yMax, line.yMax + reach };
                var first = vertices.Count;
                for (var row = 0; row < 4; row++)
                    for (var column = 0; column < 4; column++)
                    {
                        vertices.Add(new Vector3(xs[column], ys[row], 0f));
                        colors.Add(new Color(1f, 1f, 1f, row is 1 or 2 && column is 1 or 2 ? 1f : 0f));
                    }
                for (var row = 0; row < 3; row++)
                    for (var column = 0; column < 3; column++)
                    {
                        var at = first + row * 4 + column;
                        triangles.AddRange(new[] { at, at + 4, at + 5, at, at + 5, at + 1 });
                    }
            }
            scrimMesh.Clear();
            scrimMesh.SetVertices(vertices); scrimMesh.SetColors(colors); scrimMesh.SetTriangles(triangles, 0);
            scrimMesh.RecalculateBounds();
        }

        /// <summary>Takes the ink for the picture under the block: its darkest and brightest luminance (5th and 95th percentile).</summary>
        public void Read(float darkest, float brightest)
        {
            var (ink, needsScrim) = Choose(darkest, brightest);
            Ink = ink;
            if (scrim != null) scrim.enabled = needsScrim;
            Paint();
        }

        /// <summary>The word brightens once, about 400 ms; reduced motion shows no change.</summary>
        public void Brighten() { if (!reduced) brightenAge = 0f; Paint(); }

        public void Hide() => gameObject.SetActive(false);

        private void LateUpdate() => Refresh(Time.unscaledDeltaTime);

        /// <summary>Explicit elapsed time keeps editor checks deterministic.</summary>
        public void Refresh(float elapsed)
        {
            if (brightenAge >= BrightenSeconds || float.IsNaN(elapsed) || elapsed < 0f) return;
            brightenAge += elapsed;
            Paint();
        }

        private void Paint()
        {
            var halo = Ink == Graphite ? Frost : Graphite;
            foreach (var text in new[] { term, guess, source, memory })
            {
                if (text == null) continue;
                // The ink never changes, so the word keeps its contrast; a brighten is an Ember glow behind the term
                // (DESIGN: an Ember term on pale sky fell to 1.14:1).
                text.color = text == source ? new Color(Ink.r, Ink.g, Ink.b, .75f) : Ink;
                var glow = text == term ? Brightness : 0f;
                var behind = Color.Lerp(new Color(halo.r, halo.g, halo.b, .5f), new Color(SpatialTheme.Ember.r, SpatialTheme.Ember.g, SpatialTheme.Ember.b, .9f), glow);
                var material = text.fontMaterial;
                material.SetColor(ShaderUtilities.ID_UnderlayColor, behind);
                material.SetFloat(ShaderUtilities.ID_UnderlayOffsetX, 0f);
                material.SetFloat(ShaderUtilities.ID_UnderlayOffsetY, 0f);
                material.SetFloat(ShaderUtilities.ID_UnderlayDilate, .25f + .5f * glow);
                material.SetFloat(ShaderUtilities.ID_UnderlaySoftness, .06f + .5f * glow);
            }
        }

        private static float Em(float degrees, float distance) => 2f * distance * Mathf.Tan(degrees * Mathf.Deg2Rad / 2f);

        /// <summary>WCAG contrast of two relative luminances.</summary>
        public static float Contrast(float a, float b) => (Mathf.Max(a, b) + .05f) / (Mathf.Min(a, b) + .05f);

        /// <summary>The relative luminance of an sRGB color.</summary>
        public static float Luminance(Color color)
        {
            static float Linear(float c) => c <= .04045f ? c / 12.92f : Mathf.Pow((c + .055f) / 1.055f, 2.4f);
            return .2126f * Linear(color.r) + .7152f * Linear(color.g) + .0722f * Linear(color.b);
        }

        /// <summary>
        /// The ink for a block over picture luminances from <paramref name="darkest"/> to <paramref name="brightest"/>: the
        /// ink with the better worst case, and a scrim (with Frost) when even that one is under 4.5:1.
        /// </summary>
        public static (Color Ink, bool Scrim) Choose(float darkest, float brightest)
        {
            var light = Contrast(Luminance(Frost), brightest);
            var dark = Contrast(Luminance(Graphite), darkest);
            if (Mathf.Max(light, dark) < Minimum) return (Frost, true);
            return light >= dark ? (Frost, false) : (Graphite, false);
        }
    }
}
