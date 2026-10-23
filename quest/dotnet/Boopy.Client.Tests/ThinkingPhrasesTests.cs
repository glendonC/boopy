#nullable enable
using System.Collections.Generic;
using System.Linq;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class ThinkingPhrasesTests
    {
        [Test]
        public void EveryPhraseIsShortDistinctAndClaimsNothing()
        {
            Assert.That(ThinkingPhrases.All, Has.Count.EqualTo(18));
            Assert.That(ThinkingPhrases.All, Is.Unique);
            foreach (var phrase in ThinkingPhrases.All)
            {
                Assert.That(phrase.Trim(), Is.Not.Empty.And.EqualTo(phrase));
                Assert.That(phrase.Length, Is.LessThanOrEqualTo(20), phrase);
                // No progress, no result, nothing about sending.
                Assert.That(phrase.Any(char.IsDigit) || phrase.Contains('%'), Is.False, phrase);
                foreach (var claim in new[] { "send", "sent", "done", "ready", "almost", "finish" })
                    Assert.That(phrase.ToLowerInvariant(), Does.Not.Contain(claim), phrase);
            }
        }

        [Test]
        public void ARoundShowsEveryPhraseOnceBeforeAnyRepeats()
        {
            foreach (var seed in Enumerable.Range(1, 40))
            {
                var phrases = new ThinkingPhrases(seed);
                for (var round = 0; round < 3; round++)
                {
                    var shown = Enumerable.Range(0, ThinkingPhrases.All.Count).Select(_ => phrases.Next()).ToList();
                    Assert.That(shown, Is.EquivalentTo(ThinkingPhrases.All), "seed " + seed + ", round " + round);
                }
            }
        }

        [Test]
        public void NoPhraseFollowsItselfAcrossRounds()
        {
            foreach (var seed in Enumerable.Range(1, 200))
            {
                var phrases = new ThinkingPhrases(seed);
                var previous = phrases.Next();
                for (var index = 1; index < ThinkingPhrases.All.Count * 4; index++)
                {
                    var next = phrases.Next();
                    Assert.That(next, Is.Not.EqualTo(previous), "seed " + seed + " at " + index);
                    previous = next;
                }
            }
        }

        [Test]
        public void TheLookingPhrasesAreTheOnesThatSayTheViewIsBeingLookedAt()
        {
            Assert.That(ThinkingPhrases.Looking, Is.EqualTo(new[] { "Looking closer…", "Leaning in…", "Squinting…", "Peeking…" }));
            Assert.That(ThinkingPhrases.Looking, Is.SubsetOf(ThinkingPhrases.All));
            Assert.That(ThinkingPhrases.WithoutPicture, Is.EquivalentTo(ThinkingPhrases.All.Except(ThinkingPhrases.Looking)));
        }

        [Test]
        public void ATurnWithoutAPictureNeverSaysBoopyIsLooking()
        {
            foreach (var seed in Enumerable.Range(1, 40))
            {
                var phrases = new ThinkingPhrases(seed, picture: false);
                for (var round = 0; round < 3; round++)
                {
                    var shown = Enumerable.Range(0, ThinkingPhrases.WithoutPicture.Count).Select(_ => phrases.Next()).ToList();
                    Assert.That(shown, Is.EquivalentTo(ThinkingPhrases.WithoutPicture), "seed " + seed + ", round " + round);
                    Assert.That(shown.Intersect(ThinkingPhrases.Looking), Is.Empty, "seed " + seed + ", round " + round);
                }
            }
        }

        [Test]
        public void TheOrderComesFromTheSeed()
        {
            static List<string> Take(int seed)
            {
                var phrases = new ThinkingPhrases(seed);
                return Enumerable.Range(0, ThinkingPhrases.All.Count * 2).Select(_ => phrases.Next()).ToList();
            }
            Assert.That(Take(7), Is.EqualTo(Take(7)));
            Assert.That(Enumerable.Range(1, 10).Select(Take).Select(order => string.Join("|", order)).Distinct().Count(), Is.GreaterThan(1),
                "Different seeds give different orders.");
            Assert.That(Take(7).Take(ThinkingPhrases.All.Count), Is.Not.EqualTo(ThinkingPhrases.All), "The order is shuffled, not the list order.");
        }
    }
}
