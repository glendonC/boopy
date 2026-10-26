#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Boopy.Client;
using TMPro;
using UnityEngine;
using UnityEngine.TextCore.LowLevel;

namespace Boopy.Quest
{
    /// <summary>
    /// Faces for every script Boopy shows, found by coverage rather than by language. The bundled IBM Plex Sans draws
    /// Latin and the bundled IBM Plex Sans KR Hangul (BoopyTypography); a character they lack is drawn by the first face
    /// that has it: on the headset Android's own families in the order /system/etc/fonts.xml gives them (a family for the
    /// text's language first, so Han in Korean text takes the Korean face), and in the editor the Mac's font folders in
    /// name order. A face is checked by its character map before it becomes a fallback. What no face draws truthfully shows
    /// DESIGN's line, "(can't show Arabic text yet)", instead of empty boxes (TextScripts). Only the string drawn is
    /// prepared; the words themselves never change. The log names each face taken, never the text.
    /// </summary>
    public static class ScriptCoverage
    {
        private const string AndroidConfig = "/system/etc/fonts.xml", AndroidFonts = "/system/fonts";
        private static readonly string[] MacFonts = { "/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts" };
        private static readonly HashSet<int> Missing = new HashSet<int>();
        private static readonly Dictionary<string, TMP_FontAsset?> Loaded = new Dictionary<string, TMP_FontAsset?>();
        private static readonly HashSet<string> StandIns = new HashSet<string>();
        private static IReadOnlyList<FontFamily>? android;

        /// <summary>Loads Boopy's faces and readies the search. Safe to call again after a scene reset.</summary>
        public static void Install()
        {
            BoopyTypography.Load();
            Missing.Clear();
        }

        /// <summary>The string to draw for <paramref name="text"/>, after taking any face it needs.</summary>
        public static string Prepare(string? text, string? language = null)
        {
            if (string.IsNullOrEmpty(text)) return text ?? "";
            var main = BoopyTypography.Load();
            return TextScripts.Display(text, code => Covers(main, code, language));
        }

        // HasCharacters takes a string, so a character outside the first plane (Han extension B) is checked whole.
        private static bool Covers(TMP_FontAsset main, int code, string? language)
        {
            if (code < 0x20 || main.HasCharacters(char.ConvertFromUtf32(code), out _, true, true)) return true;
            if (Missing.Contains(code) || TextScripts.ShapedScript(code) != null) return false;
            foreach (var (path, index) in Candidates(language))
            {
                if (!FaceHas(path, index, code)) continue;
                var face = Face(path, index);
                if (face == null || !face.HasCharacters(char.ConvertFromUtf32(code), out _, false, true)) continue;
                if (BoopyTypography.AddFallback(face)) Debug.Log($"Boopy: script face {path} index {index}.");
                return true;
            }
            Missing.Add(code);
            return false;
        }

        private static IEnumerable<(string Path, int Index)> Candidates(string? language)
        {
            if (File.Exists(AndroidConfig))
            {
                android ??= FontConfig.Parse(File.ReadAllText(AndroidConfig));
                foreach (var face in FontConfig.Candidates(android, language)) yield return (Path.Combine(AndroidFonts, face.File), face.Index);
                yield break;
            }
            foreach (var folder in MacFonts.Where(Directory.Exists))
                foreach (var path in Directory.GetFiles(folder).Where(IsFont).OrderBy(name => name, StringComparer.Ordinal))
                    yield return (path, 0);
        }

        private static bool IsFont(string path) => path.EndsWith(".ttf", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".otf", StringComparison.OrdinalIgnoreCase) || path.EndsWith(".ttc", StringComparison.OrdinalIgnoreCase);

        private static bool FaceHas(string path, int index, int code)
        {
            var key = path + "#" + index;
            if (StandIns.Contains(key) || !File.Exists(path) || FontEngine.LoadFontFace(path, 90, index) != FontEngineError.Success) return false;
            // A face that maps unassigned code points draws a stand-in box for everything (the Mac's LastResort): that is not
            // the text, so it never serves.
            if ((FontEngine.TryGetGlyphIndex(0x0378, out var unassigned) && unassigned != 0) || (FontEngine.TryGetGlyphIndex(0xFFFF, out var nonCharacter) && nonCharacter != 0))
            {
                StandIns.Add(key);
                return false;
            }
            return FontEngine.TryGetGlyphIndex((uint)code, out var glyph) && glyph != 0;
        }

        private static TMP_FontAsset? Face(string path, int index)
        {
            var key = path + "#" + index;
            // A face Unity destroyed (a domain or scene reset in the editor) is made again.
            if (!Loaded.TryGetValue(key, out var face) || face == null)
            {
                Loaded[key] = face = TMP_FontAsset.CreateFontAsset(path, index, 90, 9, GlyphRenderMode.SDFAA, 1024, 1024);
                if (face != null) face.name = Path.GetFileNameWithoutExtension(path) + " #" + index + " (system)";
            }
            return face;
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void Reset() { Missing.Clear(); Loaded.Clear(); StandIns.Clear(); android = null; }
    }
}
