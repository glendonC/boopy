#nullable enable
using System.Collections.Generic;
using System.IO;
using TMPro;
using UnityEngine.TextCore.LowLevel;

namespace Boopy.Quest
{
    /// <summary>
    /// TextMeshPro's default font has no Hangul. Unity 6.3 can build a dynamic font asset from a
    /// font file at runtime, so Boopy borrows the system's CJK font and adds it as a fallback,
    /// rather than shipping one. Whether Horizon OS has one at these paths has to be checked
    /// on a headset.
    /// </summary>
    public static class HangulFont
    {
        private static readonly (string Path, int Face)[] Candidates =
        {
            // Android's Noto Sans CJK collection; face 1 is the Korean cut.
            ("/system/fonts/NotoSansCJK-Regular.ttc", 1),
            ("/system/fonts/NotoSansKR-Regular.otf", 0),
            ("/system/fonts/NotoSerifCJK-Regular.ttc", 1),
            // The editor on a Mac.
            ("/System/Library/Fonts/AppleSDGothicNeo.ttc", 0),
        };

        /// <summary>Adds the first font found as a fallback; returns its path, or null when none was found.</summary>
        public static string? Install()
        {
            var main = BoopyTypography.Load();
            foreach (var (path, face) in Candidates)
            {
                if (!File.Exists(path)) continue;
                var font = TMP_FontAsset.CreateFontAsset(path, face, 90, 9, GlyphRenderMode.SDFAA, 1024, 1024);
                if (font == null) continue;
                main.fallbackFontAssetTable ??= new List<TMP_FontAsset>();
                main.fallbackFontAssetTable.RemoveAll(fallback => fallback == null);
                main.fallbackFontAssetTable.Add(font);
                return path;
            }
            return null;
        }
    }
}
