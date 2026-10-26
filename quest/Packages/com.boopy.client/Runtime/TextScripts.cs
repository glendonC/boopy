#nullable enable
using System;
using System.Text;

namespace Boopy.Client
{
    /// <summary>
    /// What text the headset can draw. TextMesh Pro draws one glyph after another, left to right, with no shaping, so a
    /// script that joins its letters, runs right to left or reorders its marks cannot be drawn truthfully, and a character
    /// no face covers would show as an empty box. Such a run shows a short line in its place instead, never boxes and never
    /// a transliteration. This makes a display string only: the text itself, as said, read or sent, never changes.
    /// </summary>
    public static class TextScripts
    {
        // Blocks whose script needs shaping or right-to-left order, with the script's English name; and emoji, which need a
        // color face (drawn outlines only, a system emoji face would draw nothing), with no name.
        private static readonly (int First, int Last, string Name)[] Shaped =
        {
            (0x0590, 0x05FF, "Hebrew"), (0x0600, 0x06FF, "Arabic"), (0x0700, 0x074F, "Syriac"), (0x0750, 0x077F, "Arabic"),
            (0x0780, 0x07BF, "Thaana"), (0x07C0, 0x07FF, "N'Ko"), (0x0800, 0x083F, "Samaritan"), (0x0840, 0x085F, "Mandaic"),
            (0x0860, 0x086F, "Syriac"), (0x0870, 0x08FF, "Arabic"), (0x0900, 0x097F, "Devanagari"), (0x0980, 0x09FF, "Bengali"),
            (0x0A00, 0x0A7F, "Gurmukhi"), (0x0A80, 0x0AFF, "Gujarati"), (0x0B00, 0x0B7F, "Odia"), (0x0B80, 0x0BFF, "Tamil"),
            (0x0C00, 0x0C7F, "Telugu"), (0x0C80, 0x0CFF, "Kannada"), (0x0D00, 0x0D7F, "Malayalam"), (0x0D80, 0x0DFF, "Sinhala"),
            (0x0E00, 0x0E7F, "Thai"), (0x0E80, 0x0EFF, "Lao"), (0x0F00, 0x0FFF, "Tibetan"), (0x1000, 0x109F, "Myanmar"),
            (0x1780, 0x17FF, "Khmer"), (0x1800, 0x18AF, "Mongolian"), (0x1900, 0x194F, "Limbu"), (0x1A20, 0x1AAF, "Tai Tham"),
            (0x1B00, 0x1B7F, "Balinese"), (0x1B80, 0x1BBF, "Sundanese"), (0x1BC0, 0x1BFF, "Batak"), (0x1C00, 0x1C4F, "Lepcha"),
            (0x19E0, 0x19FF, "Khmer"), (0xA800, 0xA82F, "Syloti Nagri"), (0xA840, 0xA87F, "Phags-pa"), (0xA880, 0xA8DF, "Saurashtra"),
            (0xA8E0, 0xA8FF, "Devanagari"), (0xA980, 0xA9DF, "Javanese"), (0xA9E0, 0xA9FF, "Myanmar"), (0xAA00, 0xAA5F, "Cham"),
            (0xAA60, 0xAA7F, "Myanmar"), (0xAA80, 0xAADF, "Tai Viet"), (0xABC0, 0xABFF, "Meetei Mayek"), (0xFB1D, 0xFB4F, "Hebrew"),
            (0xFB50, 0xFDFF, "Arabic"), (0xFE70, 0xFEFF, "Arabic"), (0x10800, 0x10FFF, ""), (0x11000, 0x11FFF, ""),
            (0x1E800, 0x1E8DF, ""), (0x1E900, 0x1E95F, "Adlam"), (0x1EC70, 0x1EEFF, "Arabic"), (0x1F000, 0x1FAFF, ""),
        };

        /// <summary>The name of the script a code point belongs to when Boopy cannot draw that script truthfully; empty for
        /// such a script with no common name; null when one glyph after another draws it.</summary>
        public static string? ShapedScript(int codePoint)
        {
            foreach (var (first, last, name) in Shaped)
                if (codePoint >= first && codePoint <= last) return name;
            return null;
        }

        /// <summary>
        /// The text to draw: each run Boopy cannot draw becomes "(can't show Arabic text yet)", or "(can't show this text
        /// yet)" when its script has no name here or no face covers it. <paramref name="covered"/> says whether a face draws
        /// a code point.
        /// </summary>
        public static string Display(string text, Func<int, bool> covered)
        {
            if (string.IsNullOrEmpty(text)) return text;
            var shown = new StringBuilder(text.Length);
            // The run being hidden (its script's name, empty for no name), and the spaces seen since its last character.
            string? run = null;
            var gap = new StringBuilder();
            for (var at = 0; at < text.Length;)
            {
                var code = char.ConvertToUtf32(text, at);
                var piece = text.Substring(at, char.IsSurrogatePair(text, at) ? 2 : 1);
                at += piece.Length;
                if (run != null)
                {
                    // A mark belongs to the letter before it; a space stays inside a run if the same script follows it.
                    if (IsMark(code)) continue;
                    if (char.IsWhiteSpace(piece, 0)) { gap.Append(piece); continue; }
                }
                var hidden = Hidden(code, piece, covered);
                if (hidden != null && hidden == run) { gap.Clear(); continue; }
                if (run != null) { shown.Append(Line(run)).Append(gap); gap.Clear(); run = null; }
                if (hidden != null) run = hidden;
                else shown.Append(piece);
            }
            if (run != null) shown.Append(Line(run)).Append(gap);
            return shown.ToString();
        }

        // Why a character cannot be drawn: its script's name, empty when no face covers it, null when it can be drawn.
        private static string? Hidden(int code, string piece, Func<int, bool> covered) =>
            ShapedScript(code) ?? (covered(code) || char.IsWhiteSpace(piece, 0) || char.IsControl(piece, 0) ? null : "");

        private static string Line(string script) => script.Length > 0 ? "(can't show " + script + " text yet)" : "(can't show this text yet)";

        // Combining marks and joiners attach to the letter before them.
        private static bool IsMark(int code) => code == 0x200C || code == 0x200D
            || (code <= 0xFFFF && (char.GetUnicodeCategory((char)code) == System.Globalization.UnicodeCategory.NonSpacingMark
                || char.GetUnicodeCategory((char)code) == System.Globalization.UnicodeCategory.SpacingCombiningMark
                || char.GetUnicodeCategory((char)code) == System.Globalization.UnicodeCategory.EnclosingMark));
    }
}
