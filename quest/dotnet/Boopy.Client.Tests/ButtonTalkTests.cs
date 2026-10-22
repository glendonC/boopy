using Boopy.Client;
using NUnit.Framework;
namespace Boopy.Client.Tests;
public sealed class ButtonTalkTests
{
    [Test] public void StartsOnlyOnceAndExplicitEndDoesNotInventAnotherRecording()
    {
        var talk = new ButtonTalk(); Assert.That(talk.Recording, Is.False);
        Assert.That(talk.End(), Is.False); Assert.That(talk.Begin(10), Is.True);
        Assert.That(talk.Begin(20), Is.False); Assert.That(talk.Expired(39.9f), Is.False);
        Assert.That(talk.End(), Is.True); Assert.That(talk.End(), Is.False);
        Assert.That(talk.Expired(100), Is.False); Assert.That(talk.Begin(100), Is.True);
    }
    [Test] public void ExpiryDoesNotImplicitlySendOrRestartAndCannotBeExtendedByDuplicateBegin()
    {
        var talk = new ButtonTalk(); talk.Begin(5); talk.Begin(34);
        Assert.That(talk.Expired(35), Is.True); Assert.That(talk.Recording, Is.True);
        talk.End(); Assert.That(talk.Recording, Is.False);
    }
    [Test] public void InvalidClockCannotStartOrProlongRecording()
    {
        var talk = new ButtonTalk(); Assert.That(talk.Begin(float.NaN), Is.False);
        talk.Begin(10); Assert.That(talk.Expired(9), Is.True);
        Assert.That(talk.Expired(float.PositiveInfinity), Is.True);
    }
}
