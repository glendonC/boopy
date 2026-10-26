using System;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests;

public sealed class TextScriptsTests
{
    // A face set that covers Latin, Hangul, kana, Han and Tifinagh, and not the private use area.
    private static bool Covered(int code) => code < 0x2000 || (code >= 0x2D30 && code <= 0x2D7F) || (code >= 0x3000 && code <= 0x9FFF)
        || (code >= 0xAC00 && code <= 0xD7A3) || (code >= 0x20000 && code <= 0x2A6DF) || (code >= 0xFE70 && code <= 0xFEFF)
        || (code >= 0x0590 && code <= 0x06FF);

    [TestCase("Le chameau, déjà là : œuvre à l'oasis.")]
    [TestCase("낙타 사막")]
    [TestCase("らくだ ラクダ 駱駝")]
    [TestCase("骆驼和沙漠")]
    [TestCase("ⴰⵍⵖⵎ")]
    [TestCase("𠀋 extension B")]
    [TestCase("é combining acute")]
    public void ScriptsOneGlyphAfterAnotherDrawsShowAsTheyAre(string text) => Assert.That(TextScripts.Display(text, Covered), Is.EqualTo(text));

    [Test] public void AJoiningOrRightToLeftScriptShowsItsHonestLineEvenWhenAFaceHasItsGlyphs()
    {
        Assert.That(TextScripts.Display("جمل", Covered), Is.EqualTo("(can't show Arabic text yet)"));
        Assert.That(TextScripts.Display("camel: جمل صغير, 낙타", Covered), Is.EqualTo("camel: (can't show Arabic text yet), 낙타"));
        Assert.That(TextScripts.Display("גמל", Covered), Is.EqualTo("(can't show Hebrew text yet)"));
        Assert.That(TextScripts.Display("ऊँट", Covered), Is.EqualTo("(can't show Devanagari text yet)"));
        Assert.That(TextScripts.Display("ﺟﻤﻞ", Covered), Is.EqualTo("(can't show Arabic text yet)"), "Presentation forms are Arabic too.");
        Assert.That(TextScripts.Display("جمل גמל", Covered), Is.EqualTo("(can't show Arabic text yet) (can't show Hebrew text yet)"));
    }

    [Test] public void ACharacterNoFaceCoversShowsTheGeneralLineNeverABox()
    {
        Assert.That(TextScripts.Display("note  end", Covered), Is.EqualTo("note (can't show this text yet) end"));
        Assert.That(TextScripts.Display("👩🏽‍🚀", Covered), Is.EqualTo("(can't show this text yet)"));
    }

    [Test] public void EmojiShowTheGeneralLineEvenWhenAFaceHasThem()
    {
        // A system emoji face is a color face; TextMesh Pro draws outlines, so it would draw nothing or a blank.
        Assert.That(TextScripts.Display("a 🐪 here", _ => true), Is.EqualTo("a (can't show this text yet) here"));
    }

    [Test] public void TheTextItselfNeverChanges()
    {
        const string said = "My guess: camel. جمل";
        var copy = new string(said.ToCharArray());
        var shown = TextScripts.Display(said, Covered);
        Assert.That(said, Is.EqualTo(copy));
        Assert.That(shown, Is.Not.EqualTo(said));
        Assert.That(TextScripts.Display("", Covered), Is.EqualTo(""));
    }

    [TestCase(0x0627, "Arabic")][TestCase(0x05D0, "Hebrew")][TestCase(0x0915, "Devanagari")][TestCase(0x0E01, "Thai")]
    [TestCase(0x10900, "")]
    public void NamesTheScriptsItCannotDraw(int code, string name) => Assert.That(TextScripts.ShapedScript(code), Is.EqualTo(name));

    [TestCase(0x0041)][TestCase(0xAC00)][TestCase(0x2D30)][TestCase(0x4E00)][TestCase(0x3042)]
    public void LeavesTheScriptsItDraws(int code) => Assert.That(TextScripts.ShapedScript(code), Is.Null);
}
