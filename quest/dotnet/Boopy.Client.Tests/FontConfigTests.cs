using System.Linq;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests;

public sealed class FontConfigTests
{
    // A hand-written configuration in Android's shape, with synthetic file names.
    private const string Synthetic = @"<?xml version=""1.0"" encoding=""utf-8""?>
<familyset version=""23"">
    <family name=""sans-serif"">
        <font weight=""400"" style=""normal"">Synthetic-Regular.ttf</font>
        <font weight=""700"" style=""normal"">Synthetic-Bold.ttf</font>
    </family>
    <alias name=""arial"" to=""sans-serif"" />
    <family lang=""und-Arab"" variant=""elegant"">
        <font weight=""700"" style=""normal"">SyntheticNaskh-Bold.ttf</font>
        <font weight=""400"" style=""normal"">SyntheticNaskh-Regular.ttf</font>
    </family>
    <family lang=""zh-Hans"">
        <font weight=""400"" style=""normal"" index=""2"">SyntheticCJK-Regular.ttc</font>
    </family>
    <family lang=""ja"">
        <font weight=""400"" style=""normal"" index=""0"">SyntheticCJK-Regular.ttc</font>
    </family>
    <family lang=""ko"">
        <font weight=""400"" style=""normal"" index=""1"">SyntheticCJK-Regular.ttc
            <axis tag=""wght"" stylevalue=""400"" />
        </font>
    </family>
    <family lang=""und-Tfng"">
        <font weight=""400"" style=""normal"">SyntheticTifinagh-Regular.otf</font>
    </family>
    <family>
        <font weight=""400"" style=""normal"">../outside.ttf</font>
    </family>
</familyset>";

    [Test] public void ReadsAndroidsFamiliesInItsOrderWithTheirLanguagesAndFaces()
    {
        var families = FontConfig.Parse(Synthetic);
        Assert.That(families.Select(family => family.Languages.FirstOrDefault() ?? family.Name), Is.EqualTo(new[] { "sans-serif", "und-Arab", "zh-Hans", "ja", "ko", "und-Tfng" }));
        var korean = families[4].Faces.Single();
        Assert.That((korean.File, korean.Index, korean.Weight), Is.EqualTo(("SyntheticCJK-Regular.ttc", 1, 400)));
        Assert.That(families[0].Faces.Select(face => face.File), Is.EqualTo(new[] { "Synthetic-Regular.ttf", "Synthetic-Bold.ttf" }));
    }

    [Test] public void AFileNameThatIsAPathIsNeverTaken()
    {
        Assert.That(FontConfig.Parse(Synthetic).SelectMany(family => family.Faces).Any(face => face.File.Contains("outside")), Is.False);
    }

    [Test] public void CandidatesAreOneRegularFacePerFamilyWithTheTextsLanguageFirst()
    {
        var families = FontConfig.Parse(Synthetic);
        var any = FontConfig.Candidates(families, null);
        Assert.That(any.Select(face => face.File + "#" + face.Index), Is.EqualTo(new[] { "Synthetic-Regular.ttf#0", "SyntheticNaskh-Regular.ttf#0",
            "SyntheticCJK-Regular.ttc#2", "SyntheticCJK-Regular.ttc#0", "SyntheticCJK-Regular.ttc#1", "SyntheticTifinagh-Regular.otf#0" }));
        Assert.That(FontConfig.Candidates(families, "ko-KR")[0].Index, Is.EqualTo(1), "Han in Korean text takes the Korean face.");
        Assert.That(FontConfig.Candidates(families, "ja")[0].Index, Is.EqualTo(0));
        Assert.That(FontConfig.Candidates(families, "fr").Count, Is.EqualTo(6));
    }

    [TestCase("")]
    [TestCase("<html/>")]
    [TestCase("<familyset><family><font>")]
    [TestCase("<!DOCTYPE familyset [<!ENTITY x \"y\">]><familyset><family><font>&x;.ttf</font></family></familyset>")]
    public void AConfigurationItCannotReadGivesNoFaces(string xml) => Assert.That(FontConfig.Parse(xml), Is.Empty);
}
