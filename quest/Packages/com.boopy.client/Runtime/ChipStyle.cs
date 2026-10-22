#nullable enable
namespace Boopy.Client
{
    /// <summary>The tone of a chip: what it is, and what the person has done to it.</summary>
    public enum ChipTone
    {
        /// <summary>A model's proposal nobody has touched: hollow, dashed.</summary>
        Proposed,

        /// <summary>The person said yes, renamed it, or said it themselves: solid.</summary>
        Confirmed,

        /// <summary>The person said no: struck through and fading.</summary>
        Rejected,

        /// <summary>The person said it doesn't matter: faded.</summary>
        Ignored,

        /// <summary>The person already knows it: dimmed.</summary>
        Known,

        /// <summary>Something the model could not tell and asks about.</summary>
        Question,

        /// <summary>What the person wants: the anchor of the whole interpretation.</summary>
        Intent,
    }

    public readonly struct ChipStyle
    {
        public ChipStyle(ChipTone tone, bool emphasis, float opacity, string tag)
        {
            Tone = tone;
            Emphasis = emphasis;
            Opacity = opacity;
            Tag = tag;
        }

        public ChipTone Tone { get; }

        /// <summary>The person said this matters: a glow.</summary>
        public bool Emphasis { get; }

        public float Opacity { get; }

        /// <summary>
        /// A small word under the label saying what state it is in, so state never rests on colour
        /// alone: how sure the model is for proposals, or what the person did.
        /// </summary>
        public string Tag { get; }
    }

    /// <summary>State shown by shape and words, not by colour alone (Meta's accessibility guidance).</summary>
    public static class ChipStyles
    {
        public static ChipStyle For(Item item, bool isIntent)
        {
            if (item.Kind == "question" && item.Status == "proposed")
            {
                return new ChipStyle(ChipTone.Question, false, 1f, "question");
            }
            switch (item.Status)
            {
                case "rejected":
                    return new ChipStyle(ChipTone.Rejected, false, 0.45f, "not this");
                case "ignored":
                    return new ChipStyle(ChipTone.Ignored, false, 0.35f, "set aside");
                case "known":
                    return new ChipStyle(ChipTone.Known, item.Emphasis, 0.7f, "you know this");
                case "confirmed":
                    var tag = item.Origin == "person" ? "yours" : item.ProposedLabel != null ? "renamed" : "confirmed";
                    return new ChipStyle(isIntent ? ChipTone.Intent : ChipTone.Confirmed, item.Emphasis, 1f,
                        item.Emphasis ? $"{tag}, matters" : tag);
                default:
                    var certainty = Certainty(item.Confidence) ?? "proposed";
                    return new ChipStyle(isIntent ? ChipTone.Intent : ChipTone.Proposed, item.Emphasis, 0.92f,
                        item.Emphasis ? $"{certainty}, matters" : certainty);
            }
        }

        /// <summary>
        /// Coarse words for a model's confidence. A score of 1.00 has been wrong, so the top
        /// word stays "likely" rather than certain.
        /// </summary>
        public static string? Certainty(float? confidence)
        {
            if (confidence == null) return null;
            if (confidence >= 0.85f) return "likely";
            if (confidence >= 0.6f) return "maybe";
            return "unsure";
        }

        /// <summary>The words on a chip: the label, the gloss, then the state tag, smaller.</summary>
        public static string Caption(Item item, ChipStyle style)
        {
            var gloss = string.IsNullOrWhiteSpace(item.Gloss) ? "" : $"\n<size=85%>{item.Gloss}</size>";
            var label = style.Tone == ChipTone.Rejected ? $"<s>{item.Label}</s>" : item.Label;
            return $"{label}{gloss}\n<size=60%><alpha=#99>{style.Tag}</size>";
        }

        /// <summary>What an expanded chip adds: the statement, the text as written, the person's note, why.</summary>
        public static string Detail(Item item)
        {
            var detail = item.Statement;
            if (item.Text != null && item.Text.Count > 0) detail += $"\n\"{string.Join(" / ", item.Text)}\"";
            if (!string.IsNullOrWhiteSpace(item.Note)) detail += $"\nYou said: {item.Note}";
            if (item.Origin == "model" && !string.IsNullOrWhiteSpace(item.Why)) detail += $"\nWhy: {item.Why}";
            return detail;
        }
    }
}
