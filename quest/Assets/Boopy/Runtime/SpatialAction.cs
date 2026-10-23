#nullable enable
using System.Collections.Generic;
using TMPro;
using UnityEngine;

namespace Boopy.Quest
{
    public enum ConsoleAction { None, Save, Confirm, PreviousItem, NextItem, ToggleDetails, PreviousText, NextText, Size, Options, Sound, Cancel, Review, ToggleIncluded, Motion, PrepareSave, Back, Handoff, Speech, EvidenceSource, CheckCapture, DismissCapture, UseCurrentView, UseSpokenOnly, Actions, Settings, FollowUpOne, FollowUpTwo, ChoiceOne, ChoiceTwo, ChoiceThree, SendChoice, PauseScene, Talk, FinishTalk, AnswerTask, More, ShelfBack }

    /// <summary>A neutral matte action with a horizontal pictogram and label; its target never travels.</summary>
    public sealed class SpatialAction : MonoBehaviour
    {
        private MeshRenderer? plate;
        private MeshFilter? face;
        private Vector2 faceSize;
        private TextMeshPro? text;
        private SpatialActionIcon? pictogram;
        private LineRenderer? outline;
        private readonly List<LineRenderer> symbol = new List<LineRenderer>();
        private bool NavigationIcon => Action == ConsoleAction.PreviousItem || Action == ConsoleAction.NextItem
            || Action == ConsoleAction.PreviousText || Action == ConsoleAction.NextText;
        public bool IconOnly => NavigationIcon;
        public string AccessibleLabel => text?.text ?? "";
        private Transform? visual;
        private BoxCollider? hit;
        private MaterialPropertyBlock? block;
        private float hoverAmount, pressAmount, controlWidth;
        private bool hovered, pressed;
        private bool interactable = true, leftAligned, selected;
        private static Material? satin;
        private static Material Satin => satin != null ? satin : satin = new Material(Resources.Load<Shader>("ControlSatin") ?? Shader.Find("Boopy/ControlSatin"));
        public ConsoleAction Action { get; private set; }

        private void OnDestroy()
        {
            if (face == null || face.sharedMesh == null) return;
            if (Application.isPlaying) Destroy(face.sharedMesh); else DestroyImmediate(face.sharedMesh);
        }

        public static SpatialAction Create(Transform parent, ConsoleAction action, string words, float width)
        {
            if (action == ConsoleAction.Options) width = Mathf.Max(width, .105f);
            var go = new GameObject("Action " + action); go.transform.SetParent(parent, false);
            var control = go.AddComponent<SpatialAction>(); control.Action = action;
            control.block = new MaterialPropertyBlock(); control.controlWidth = width;
            control.visual = new GameObject("Press visual").transform; control.visual.SetParent(go.transform, false);
            var plate = new GameObject("Action surface"); plate.transform.SetParent(control.visual, false);
            plate.transform.localScale = new Vector3(width, SpatialTheme.Target, 1f);
            control.face = plate.AddComponent<MeshFilter>();
            control.plate = plate.AddComponent<MeshRenderer>(); control.plate.sharedMaterial = Satin;
            control.plate.sortingOrder = 1;
            control.text = SpatialTheme.Text(control.visual, "Verb", SpatialTheme.Body, SpatialTheme.Ivory);
            // Every control label is Plex Regular; Medium is the chip's name only.
            control.text.font = BoopyTypography.Load();
            control.text.text = words; control.text.rectTransform.sizeDelta = new Vector2(width - 0.016f, 0.046f);
            control.text.transform.localPosition = new Vector3(0f, 0f, -0.004f);
            control.text.alignment = TextAlignmentOptions.Center;
            if (control.IconOnly)
            {
                control.text.fontSize = SpatialTheme.Utility;
                control.text.rectTransform.sizeDelta = new Vector2(width, .025f);
                control.text.fontSize = SpatialTheme.Utility * .85f;
                control.text.transform.localPosition = new Vector3(0f, -.017f, -.004f);
                control.text.alignment = TextAlignmentOptions.Center;
                if (control.NavigationIcon)
                {
                    var direction = action == ConsoleAction.PreviousItem || action == ConsoleAction.PreviousText ? -1f : 1f;
                    control.Stroke(new Vector3(-direction * .006f, .011f, -.004f), new Vector3(direction * .006f, 0, -.004f));
                    control.Stroke(new Vector3(direction * .006f, 0, -.004f), new Vector3(-direction * .006f, -.011f, -.004f));
                }
                else
                {
                    for (var dot = -1; dot <= 1; dot++)
                        control.Stroke(new Vector3(dot * .009f, 0, -.004f), new Vector3(dot * .009f + .0001f, 0, -.004f), .004f);
                }
            }
            control.pictogram = SpatialActionIcon.Create(control.visual);
            control.pictogram.Configure(action, words);
            var boundary = new GameObject("Action boundary"); boundary.transform.SetParent(control.visual, false);
            control.outline = Visuals.Line(boundary, .0018f, true, Visuals.Solid);
            control.outline.useWorldSpace = false; control.outline.positionCount = 36; control.outline.sortingOrder = 2;
            control.hit = go.AddComponent<BoxCollider>(); control.hit.size = new Vector3(width, SpatialTheme.Target, 0.012f);
            control.LayoutLabel();
            control.Refresh(0f, 1f, true);
            return control;
        }

        private void Stroke(Vector3 start, Vector3 end, float width = .0022f)
        {
            var go = new GameObject(NavigationIcon ? "Navigation stroke" : "More dot");
            go.transform.SetParent(visual, false);
            var line = Visuals.Line(go, width, false, Visuals.Solid);
            line.useWorldSpace = false; line.sortingOrder = 3; line.positionCount = 2;
            line.SetPosition(0, start); line.SetPosition(1, end); symbol.Add(line);
        }

        public void SetLeftAligned(bool on)
        {
            leftAligned = on;
            if (text == null) return;
            LayoutLabel();
        }

        private void LayoutLabel()
        {
            if (text == null) return;
            const float glyphWidth = .018f, gap = .006f;
            var hasGlyph = pictogram != null && pictogram.Drawn || NavigationIcon;
            var inset = hasGlyph ? .006f : .008f;
            text.fontSize = NavigationIcon ? SpatialTheme.Utility : SpatialTheme.Body;
            text.textWrappingMode = hasGlyph ? TextWrappingModes.NoWrap : TextWrappingModes.Normal;
            var available = controlWidth - inset * 2f - (hasGlyph ? glyphWidth + gap : 0f);
            var labelWidth = Mathf.Min(available, text.GetPreferredValues(text.text, Mathf.Infinity, Mathf.Infinity).x);
            var groupWidth = labelWidth + (hasGlyph ? glyphWidth + gap : 0f);
            var start = leftAligned ? -controlWidth / 2f + inset : -groupWidth / 2f;
            text.alignment = hasGlyph || leftAligned ? TextAlignmentOptions.Left : TextAlignmentOptions.Center;
            text.rectTransform.sizeDelta = new Vector2(hasGlyph ? labelWidth : controlWidth - inset * 2f, .046f);
            text.transform.localPosition = new Vector3(hasGlyph ? start + glyphWidth + gap + labelWidth / 2f : 0f, 0f, -.004f);
            var iconPosition = new Vector3(start + glyphWidth / 2f, 0f, -.004f);
            if (pictogram != null) { pictogram.transform.localPosition = iconPosition; pictogram.transform.localScale = Vector3.one * .95f; }
            foreach (var stroke in symbol) { stroke.transform.localPosition = iconPosition; stroke.transform.localScale = Vector3.one * .95f; }
            // Centered as drawn: the label's visible letters and the glyph's strokes, not their layout boxes, as one group.
            if (leftAligned || pictogram == null || !pictogram.Drawn) return;
            text.ForceMeshUpdate(true, true);
            if (text.textInfo.characterCount == 0) return;
            var (iconLow, iconHigh) = pictogram.Extent();
            var letters = text.textBounds;
            var low = Mathf.Min(iconPosition.x + iconLow * .95f, text.transform.localPosition.x + letters.min.x);
            var high = Mathf.Max(iconPosition.x + iconHigh * .95f, text.transform.localPosition.x + letters.max.x);
            var shift = Vector3.right * -(low + high) / 2f;
            text.transform.localPosition += shift;
            pictogram.transform.localPosition = iconPosition + shift;
        }
        public void Label(string words) { if (text != null) text.text = words; pictogram?.Configure(Action, words); LayoutLabel(); }
        public void SetSelected(bool on) { selected = on; }
        public void SetInteractable(bool on)
        {
            interactable = on;
            if (!on) { hovered = pressed = false; hoverAmount = pressAmount = 0f; }
            if (hit != null) hit.enabled = on && hit.enabled;
        }
        public void Focus(bool on) => hovered = on && interactable;
        public void Press(bool on) => pressed = on && interactable;
        public bool Hit(Ray ray, out Vector3 point)
        {
            point = default;
            if (!gameObject.activeInHierarchy || hit == null || !hit.enabled || !hit.Raycast(ray, out var result, 5f)) return false;
            point = result.point; return true;
        }
        public void Refresh(float delta, float opacity, bool reduced)
        {
            if (plate == null || text == null || block == null || visual == null || hit == null) return;
            hit.enabled = interactable && opacity >= .95f;
            hoverAmount = reduced ? (hovered ? 1f : 0f) : Mathf.MoveTowards(hoverAmount, hovered ? 1f : 0f, delta / .12f);
            pressAmount = reduced ? (pressed ? 1f : 0f) : Mathf.MoveTowards(pressAmount, pressed ? 1f : 0f, delta / .09f);
            var size = new Vector2(hit.size.x,hit.size.y);
            if (face != null && faceSize != size)
            {
                var old = face.sharedMesh; face.sharedMesh = RoundedPlate.Create(size.x,size.y,.014f); faceSize=size;
                if (old != null) { if(Application.isPlaying)Destroy(old);else DestroyImmediate(old); }
            }
            // One tile style for every control: the recommended action is the row's first tile, never a different plate.
            var color = selected ? SpatialTheme.Emphasis : SpatialTheme.Control;
            var hover = selected ? Color.Lerp(SpatialTheme.Emphasis,SpatialTheme.Secondary,.12f) : SpatialTheme.Emphasis;
            color = Color.Lerp(color,hover,interactable ? hoverAmount : 0f);
            if (!interactable) color = Color.Lerp(SpatialTheme.Panel,SpatialTheme.Control,.8f);
            color.a = .96f;
            color.a *= opacity; block.SetColor("_Color", color);
            block.SetVector("_SurfaceSize",new Vector4(size.x,size.y,.014f,0));
            block.SetFloat("_Press",interactable ? pressAmount : 0f); plate.SetPropertyBlock(block);
            var reveal = opacity * opacity * (3f - 2f * opacity);
            visual.localPosition = new Vector3(0, reduced ? 0 : -.006f * (1f - reveal), reduced ? 0f : pressAmount * .0015f - hoverAmount * .0005f);
            var words = SpatialTheme.Ivory;
            if (!interactable) words = SpatialTheme.Smoke;
            text.color = new Color(words.r, words.g, words.b, opacity);
            pictogram?.Tint(text.color);
            if (outline != null)
            {
                var half = new Vector2(hit.size.x,hit.size.y)*.5f-Vector2.one*.001f;
                var radius=Mathf.Min(.013f,Mathf.Min(half.x,half.y));
                for(var corner=0;corner<4;corner++)
                {
                    var sign=new Vector2(corner==0||corner==3?1f:-1f,corner<2?1f:-1f);
                    var center=new Vector2(sign.x*(half.x-radius),sign.y*(half.y-radius));
                    for(var step=0;step<=8;step++)
                    {
                        var angle=(corner*90f+step*90f/8f)*Mathf.Deg2Rad;
                        outline.SetPosition(corner*9+step,new Vector3(center.x+Mathf.Cos(angle)*radius,center.y+Mathf.Sin(angle)*radius,-.0035f));
                    }
                }
                outline.enabled = selected;
                var tint=SpatialTheme.TextColor;tint.a=opacity*.78f;outline.startColor=outline.endColor=tint;
            }
            if (IconOnly)
            {
                text.gameObject.SetActive(true);
                foreach (var stroke in symbol) Visuals.Tint(stroke, new Color(SpatialTheme.Ivory.r, SpatialTheme.Ivory.g, SpatialTheme.Ivory.b, opacity));
            }
        }
    }
}
