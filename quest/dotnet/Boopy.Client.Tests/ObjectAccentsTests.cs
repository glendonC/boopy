using System.Linq;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class ObjectAccentsTests
    {
        [Test]
        public void FourObjectsHaveDistinctAccentsThatSurviveReorderingAndConfirmation()
        {
            var accents=new ObjectAccents();
            var items=new[]{new Item {Id="photo"},new Item {Id="note"},new Item {Id="cup"},new Item {Id="lamp"}};
            accents.Synchronize(items.Select(item=>item.Id).ToArray());
            var before=items.Select(item=> {Assert.That(accents.TryGet(item.Id,out var slot),Is.True); return slot;}).ToArray();
            Assert.That(before.Distinct().Count(),Is.EqualTo(4));
            items[0].Status="confirmed"; items[0].Label="Corrected name";
            accents.Synchronize(items.Reverse().Select(item=>item.Id).ToArray());
            for(var i=0;i<items.Length;i++) {accents.TryGet(items[i].Id,out var slot);Assert.That(slot,Is.EqualTo(before[i]));}
        }

        [Test]
        public void NewObjectsReuseOnlyVacatedSlotsWithoutRecoloringSurvivors()
        {
            var accents=new ObjectAccents(); accents.Synchronize(new[]{"photo","note","cup","lamp"});
            accents.TryGet("note",out var priorNote); accents.TryGet("cup",out var priorCup);
            accents.Synchronize(new[]{"new-object","cup","note","note","","fifth"});
            accents.TryGet("note",out var note); accents.TryGet("cup",out var cup); accents.TryGet("new-object",out var fresh);
            Assert.That(note,Is.EqualTo(priorNote)); Assert.That(cup,Is.EqualTo(priorCup));
            Assert.That(fresh,Is.Not.EqualTo(note).And.Not.EqualTo(cup));
            Assert.That(accents.TryGet("photo",out _),Is.False);
            accents.Clear();Assert.That(accents.TryGet("note",out _),Is.False);
        }

        [Test]
        public void FocusChangesIntensityWithoutChangingObjectIdentityOrClaimStatus()
        {
            var before=ObjectAccents.Color(2);
            Assert.That(ObjectAccents.OutlineOpacity(true,true,false),Is.GreaterThan(ObjectAccents.OutlineOpacity(false,true,true)));
            Assert.That(ObjectAccents.OutlineOpacity(false,true,true),Is.LessThan(ObjectAccents.OutlineOpacity(false,false,true)));
            Assert.That(ObjectAccents.FillMultiplier(true,true),Is.GreaterThan(ObjectAccents.FillMultiplier(false,true)));
            Assert.That(ObjectAccents.Color(2),Is.EqualTo(before));
            var item=new Item {Status="proposed",Confidence=null};
            Assert.That(ChipStyles.For(item,false).Tone,Is.EqualTo(ChipTone.Proposed));
            Assert.That(ChipStyles.For(item,false).Tag,Is.EqualTo("proposed"));
        }
    }
}
