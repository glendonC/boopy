#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;

namespace Boopy.Client
{
    /// <summary>
    /// Boopy's thinking phrases for the working line while a turn is with the Mac: one at a time, the next about
    /// every <see cref="Seconds"/> seconds, in a shuffled order that shows every phrase once before any repeats and
    /// never shows one twice in a row. None claims progress, a result, or that anything was sent. Text only, never
    /// spoken. The order comes from a seed, so it is exact under test.
    /// </summary>
    public sealed class ThinkingPhrases
    {
        public const float Seconds = 3f;

        public static readonly IReadOnlyList<string> All = new[]
        {
            "Hmm, let me see…", "Looking closer…", "Leaning in…", "Squinting…", "Peeking…", "Turning it over…",
            "Mulling it over…", "Puzzling…", "Noodling on it…", "Connecting dots…", "Finding the words…", "Gathering thoughts…",
            "Getting curious…", "Thinking cap on…", "Booping gently…", "Boopifying…", "Beep boop, hmm…", "Pre-boop pondering…",
        };

        /// <summary>The phrases that say Boopy is looking at the view. A turn that sends no picture never shows them.</summary>
        public static readonly IReadOnlyList<string> Looking = new[] { "Looking closer…", "Leaning in…", "Squinting…", "Peeking…" };

        /// <summary>The phrases for a turn that sends no picture.</summary>
        public static readonly IReadOnlyList<string> WithoutPicture = All.Where(phrase => !Looking.Contains(phrase)).ToArray();

        private readonly Random random;
        private readonly IReadOnlyList<string> phrases;
        private readonly List<string> order = new List<string>();
        private string? last;

        /// <summary>A rotation for turns that send a picture, or, with <paramref name="picture"/> false, for turns that do not.</summary>
        public ThinkingPhrases(int seed, bool picture = true)
        {
            random = new Random(seed);
            phrases = picture ? All : WithoutPicture;
        }

        public string Next()
        {
            if (order.Count == 0)
            {
                order.AddRange(phrases);
                for (var index = order.Count - 1; index > 0; index--)
                {
                    var other = random.Next(index + 1);
                    (order[index], order[other]) = (order[other], order[index]);
                }
                // A new round never opens with the phrase that closed the last one.
                if (order[0] == last) (order[0], order[order.Count - 1]) = (order[order.Count - 1], order[0]);
            }
            last = order[0];
            order.RemoveAt(0);
            return last;
        }
    }
}
