#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml;
using System.Xml.Linq;

namespace Boopy.Client
{
    /// <summary>One face of a font family: its file, its index in a collection, its weight and style.</summary>
    public sealed class FontFace
    {
        public string File { get; set; } = "";
        public int Index { get; set; }
        public int Weight { get; set; } = 400;
        public string Style { get; set; } = "normal";
    }

    /// <summary>One family of Android's font configuration, with the languages it is for (empty for the default families).</summary>
    public sealed class FontFamily
    {
        public string? Name { get; set; }
        public IReadOnlyList<string> Languages { get; set; } = Array.Empty<string>();
        public List<FontFace> Faces { get; } = new List<FontFace>();
    }

    /// <summary>
    /// Android's own font configuration (/system/etc/fonts.xml): its families in its order. Boopy takes faces from it by
    /// coverage, the way Android's text stack does, so no script or language has a font path of its own in Boopy's code.
    /// </summary>
    public static class FontConfig
    {
        /// <summary>The families, in the file's order. A file Boopy cannot read gives none.</summary>
        public static IReadOnlyList<FontFamily> Parse(string xml)
        {
            var families = new List<FontFamily>();
            XDocument document;
            try
            {
                using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });
                document = XDocument.Load(reader);
            }
            catch (XmlException) { return families; }
            if (document.Root == null || document.Root.Name.LocalName != "familyset") return families;
            foreach (var element in document.Root.Elements().Where(child => child.Name.LocalName == "family"))
            {
                var family = new FontFamily
                {
                    Name = (string?)element.Attribute("name"),
                    Languages = ((string?)element.Attribute("lang") ?? "").Split(new[] { ' ', ',' }, StringSplitOptions.RemoveEmptyEntries),
                };
                foreach (var font in element.Elements().Where(child => child.Name.LocalName == "font"))
                {
                    // The file name is the element's own text; axis settings are child elements.
                    var file = string.Concat(font.Nodes().OfType<XText>().Select(text => text.Value)).Trim();
                    if (file.Length == 0 || file.Contains('/') || file.Contains('\\') || file.StartsWith(".", StringComparison.Ordinal)) continue;
                    family.Faces.Add(new FontFace
                    {
                        File = file,
                        Index = int.TryParse((string?)font.Attribute("index"), out var index) && index >= 0 ? index : 0,
                        Weight = int.TryParse((string?)font.Attribute("weight"), out var weight) ? weight : 400,
                        Style = (string?)font.Attribute("style") ?? "normal",
                    });
                }
                if (family.Faces.Count > 0) families.Add(family);
            }
            return families;
        }

        /// <summary>
        /// One regular face per family, in Android's order, for finding a face that covers a character. Families for the
        /// text's <paramref name="language"/> come first, so Han in Korean text takes the Korean face.
        /// </summary>
        public static IReadOnlyList<FontFace> Candidates(IReadOnlyList<FontFamily> families, string? language)
        {
            var primary = language?.Split('-', '_')[0].ToLowerInvariant();
            bool Matches(FontFamily family) => primary != null && family.Languages.Any(tag => tag.Split('-', '_')[0].ToLowerInvariant() == primary);
            return families.Where(Matches).Concat(families.Where(family => !Matches(family)))
                .Select(family => family.Faces.FirstOrDefault(face => face.Weight == 400 && face.Style == "normal") ?? family.Faces[0])
                .ToList();
        }
    }
}
