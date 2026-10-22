#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;

namespace Boopy.Client
{
    /// <summary>What the spatial console can truthfully say or offer from a returned session.</summary>
    public static class ContextReview
    {
        /// <summary>
        /// A small set of room annotations; the reader still owns the complete evidence list.
        /// Only explicit referent and emphasis affect priority, never inferred relevance or confidence.
        /// </summary>
        public static IReadOnlyList<Item> WorldItems(SessionView view, int maximum = 3) => view.Items
            .Where(item => item.Id != view.IntentId && item.Kind != "goal" && item.Kind != "question"
                && item.Status != "ignored" && item.Status != "rejected"
                && item.Grounding.ObservationId != null
                && ((item.Grounding.Kind == "box" && item.Grounding.Box != null)
                    || (item.Grounding.Kind == "point" && item.Grounding.Point != null)))
            .OrderBy(item => item.Id == view.ReferentId ? 0 : item.Emphasis ? 1 : 2)
            .Take(Math.Max(0, maximum))
            .ToList();

        public static bool IsExcluded(Item item) => item.Status == "ignored" || item.Status == "rejected";
        public static string InclusionAction(Item item) => IsExcluded(item) ? "reset" : "ignore";

        public static bool CanSave(SessionView? view) => view != null && view.State == "review"
            && view.Items.Count > 0 && view.Committed == null
            && (view.Model != null || HasCompletedSpokenContext(view));

        // The service creates person-origin "utterance" items only after completing explicit
        // no-visual work. This durable evidence survives direct actions that clear attention.
        // Generic notes after a failed interpretation cannot establish that completion.
        private static bool HasCompletedSpokenContext(SessionView view) =>
            view.Utterances.Any(utterance => !string.IsNullOrWhiteSpace(utterance.Id)
                && !string.IsNullOrWhiteSpace(utterance.Text))
            && view.Items.Any(item => item.Origin == "person" && item.Kind == "utterance"
                && item.Status == "confirmed" && item.Confidence == null
                && !string.IsNullOrWhiteSpace(item.Id) && !string.IsNullOrWhiteSpace(item.Statement));

        public static string Counts(SessionView view) =>
            $"{view.Items.Count(item => item.Status == "proposed")} proposed · " +
            $"{view.Items.Count(item => item.Status == "confirmed")} confirmed · " +
            $"{view.Items.Count(item => item.Status == "known")} known · " +
            $"{view.Items.Count(item => item.Kind == "question" && item.Status == "proposed")} questions";

        /// <summary>OCR remains exact evidence; an explanation is explicitly attributed to the model.</summary>
        public static string Evidence(Item item)
        {
            var text = item.Text != null && item.Text.Count > 0
                ? "OCR as written: " + string.Join(" / ", item.Text) : item.Statement;
            if (!string.IsNullOrWhiteSpace(item.Note)) text += "\nYou said: " + item.Note;
            if (item.Origin == "model" && !string.IsNullOrWhiteSpace(item.Why))
                text += "\nModel explanation: " + item.Why;
            return text;
        }

        /// <summary>Matches the service package's live-item selection; never upgrades a proposal.</summary>
        public static string SaveSummary(SessionView view)
        {
            var live = view.Items.Where(item => item.Status == "proposed" || item.Status == "confirmed").ToArray();
            var unconfirmed = live.Count(item => item.Origin == "model" && item.Status == "proposed");
            var questions = live.Count(item => item.Kind == "question");
            return "Prepare these words, corrections and selected details for your agent."
                + (unconfirmed > 0 ? "\nModel suggestions stay unconfirmed." : "")
                + (questions > 0 ? "\nOpen questions stay open." : "")
                + "\nNothing is sent.";
        }

        /// <summary>Compact projection of existing records, not a generated or verified summary.</summary>
        public static string ConversationSummary(SessionView view)
        {
            var included = view.Items.Where(item => !IsExcluded(item) && item.Id != view.IntentId
                && item.Label != "Suggested answer").ToArray();
            var lines = included.Take(3).Select(item =>
                (item.Origin == "person" ? "You said · " : item.Status == "confirmed" ? "Confirmed · "
                    : item.Kind == "question" ? "Open question · " : "Proposed · ") + item.Label);
            var text = string.Join("\n", lines);
            if (included.Length > 3) text += $"\n{included.Length - 3} more " + (included.Length == 4 ? "detail" : "details");
            return text.Length == 0 ? "Keep talking to build the context." : text;
        }

        public static string Receipt(SessionView view) => view.Committed == null
            ? "Context not prepared" : "Context ready on your Mac · Not sent yet";
    }
}
