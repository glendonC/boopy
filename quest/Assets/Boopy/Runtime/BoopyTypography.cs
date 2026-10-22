#nullable enable
using System;
using System.Collections.Generic;
using TMPro;
using UnityEngine;
using UnityEngine.TextCore.LowLevel;

namespace Boopy.Quest
{
    /// <summary>Bundled, licensed IBM Plex Sans faces with the existing system Hangul fallback chain.</summary>
    public static class BoopyTypography
    {
        private static TMP_FontAsset? regular;
        private static TMP_FontAsset? medium;

        public static TMP_FontAsset Load()
        {
            if (regular != null) return regular;
            var previous = TMP_Settings.defaultFontAsset;
            var fallbacks = previous != null
                ? previous.fallbackFontAssetTable ??= new List<TMP_FontAsset>()
                : new List<TMP_FontAsset>();
            regular = Create("IBMPlexSans-Regular");
            medium = Create("IBMPlexSans-Medium");
            // Share the list: HangulFont.Install may add the CJK face after UI construction.
            regular.fallbackFontAssetTable = fallbacks;
            medium.fallbackFontAssetTable = fallbacks;
            TMP_Settings.defaultFontAsset = regular;
            return regular;
        }

        public static TMP_FontAsset Medium
        {
            get { Load(); return medium!; }
        }

        private static TMP_FontAsset Create(string name)
        {
            var source = Resources.Load<Font>("Fonts/" + name)
                ?? throw new InvalidOperationException("The bundled Boopy font is missing: " + name);
            var asset = TMP_FontAsset.CreateFontAsset(source, 90, 9, GlyphRenderMode.SDFAA,
                1024, 1024, AtlasPopulationMode.Dynamic, true);
            if (asset == null) throw new InvalidOperationException("Could not create Boopy's font atlas: " + name);
            asset.name = name + " (Boopy dynamic SDF)";
            // A restrained shadow protects white glyphs on bright passthrough without a plate.
            var material = asset.material;
            material.EnableKeyword("UNDERLAY_ON");
            material.SetColor(ShaderUtilities.ID_UnderlayColor, new Color(0f, 0f, 0f, .90f));
            material.SetFloat(ShaderUtilities.ID_UnderlayOffsetX, .15f);
            material.SetFloat(ShaderUtilities.ID_UnderlayOffsetY, -.35f);
            material.SetFloat(ShaderUtilities.ID_UnderlayDilate, .16f);
            material.SetFloat(ShaderUtilities.ID_UnderlaySoftness, .06f);
            ShaderUtilities.UpdateShaderRatios(material);
            // ASCII, explicit ellipsis and common interface punctuation are verified before use.
            if (!asset.TryAddCharacters("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,:;!?/()-+…·", out var missing)
                && !string.IsNullOrEmpty(missing))
                throw new InvalidOperationException("The bundled Boopy font lacks required interface glyphs.");
            return asset;
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void Reset() { regular = null; medium = null; }
    }
}
