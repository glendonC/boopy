#nullable enable
using System;
using System.Linq;

namespace Boopy.Client
{
    /// <summary>Success sounds acknowledge a returned server transition, never model confidence.</summary>
    public static class AudioFeedback
    {
        public static AudioCue? ForTransition(SessionView? previous, SessionView returned)
        {
            if (returned == null) throw new ArgumentNullException(nameof(returned));
            // A distinct arrival tone means proposals are available, never that they are correct.
            var latest = returned.Observations.LastOrDefault()?.Id;
            if (returned.State == "review" && returned.Model != null && latest != null
                && (previous?.Id != returned.Id || previous.Observations.LastOrDefault()?.Id != latest)
                && returned.Items.Any(item => item.Origin == "model" && item.Grounding.ObservationId == latest))
                return AudioCue.Ready;
            // First display and a different session are not evidence of an action just succeeding.
            if (previous == null || previous.Id != returned.Id) return null;
            var package = returned.Committed?.PackageId;
            if (returned.State == "committed" && !string.IsNullOrWhiteSpace(package) &&
                package != previous.Committed?.PackageId) return AudioCue.Saved;
            foreach (var item in returned.Items)
            {
                if (item.Status != "confirmed" || string.IsNullOrWhiteSpace(item.Id)) continue;
                var before = previous.Items.Find(candidate => candidate.Id == item.Id);
                if (before?.Status == "proposed") return AudioCue.Confirm;
            }
            return null;
        }
    }
}
