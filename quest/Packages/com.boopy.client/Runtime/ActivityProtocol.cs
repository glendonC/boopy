#nullable enable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using Newtonsoft.Json;

namespace Boopy.Client
{
    // The headset side of arrange and sequence activities (docs/activity-contract.md).
    // Assistant content is proposed plain data. The service owns ids, revisions, and derived
    // values. A position runs from 0 (your left, the low label, or min) to 1. Null is not placed.

    /// <summary>Assistant words with their language and an optional translation into the person's language.</summary>
    public sealed class ActivityText
    {
        public string Text { get; set; } = "";
        public string Language { get; set; } = "";
        public string? Gloss { get; set; }
        internal bool ValidWithin(int text, int gloss) => ActivityRules.Line(Text, text) && ActivityRules.Language(Language)
            && (Gloss == null || ActivityRules.Line(Gloss, gloss));
    }

    public sealed class ActivitySummary
    {
        private ActivityCallSummary? call;
        private bool callPresent;
        [JsonProperty(NullValueHandling = NullValueHandling.Include)]
        public ActivityCallSummary? Call { get => call; set { callPresent = true; call = value; } }
        public bool ShouldSerializeCall() => callPresent;
        public string ActivityId { get; set; } = "";
        public string? Title { get; set; }

        /// <summary>active or fallback-only.</summary>
        public string Status { get; set; } = "";
        public string ImportedAt { get; set; } = "";

        /// <summary>The author the imported file names. Never authenticated.</summary>
        public string? ClaimedAuthor { get; set; }

        /// <summary>How many submissions were frozen.</summary>
        public int? Submissions { get; set; }

        /// <summary>A submission was exported and no reply has been imported for it.</summary>
        public bool? AwaitingReply { get; set; }
        public bool? ReplyAvailable { get; set; }
        public string? ParentActivityId { get; set; }

        [JsonIgnore]
        public bool Valid => ActivityRules.Activity(ActivityId) && (Status == "active" || Status == "fallback-only")
            && (Title == null || ActivityRules.Line(Title, 60)) && ActivityRules.Time(ImportedAt)
            && (ClaimedAuthor == null || ActivityRules.Line(ClaimedAuthor, 60))
            && Submissions.HasValue && Submissions >= 0 && AwaitingReply.HasValue && ReplyAvailable.HasValue
            && (ParentActivityId == null || ActivityRules.Activity(ParentActivityId))
            && (callPresent ? Call != null && Call.Valid && ClaimedAuthor == null && Status == "active" : Call == null);
    }

    public sealed class ActivityList
    {
        public List<ActivitySummary>? Activities { get; set; }

        [JsonIgnore]
        public bool Valid => Activities != null && Activities.Count <= 20 && Activities.All(summary => summary != null && summary.Valid)
            && Activities.Select(summary => summary.ActivityId).Distinct().Count() == Activities.Count;
    }

    public sealed class ActivityParent
    {
        public string ActivityId { get; set; } = "";
        public string SubmissionId { get; set; } = "";
        public string ReplyId { get; set; } = "";
        internal bool Valid => ActivityRules.Activity(ActivityId) && ActivityRules.Submission(SubmissionId) && ActivityRules.Reply(ReplyId);
    }

    public sealed class ActivityProvenance
    {
        private ActivityCallProvenance? call;
        private bool callPresent;
        [JsonProperty(NullValueHandling = NullValueHandling.Include)]
        public ActivityCallProvenance? Call { get => call; set { callPresent = true; call = value; } }
        public bool ShouldSerializeCall() => callPresent;
        public string RequestId { get; set; } = "";
        public string PackageId { get; set; } = "";
        public string PacketSha256 { get; set; } = "";
        public string ArtifactSha256 { get; set; } = "";

        /// <summary>The author the imported file names. Never authenticated.</summary>
        public string? ClaimedAuthor { get; set; }

        /// <summary>File authorship is claimed; a recorded local call is known, with content still proposed.</summary>
        public string Authorship { get; set; } = "";
        public string ImportedAt { get; set; } = "";
        public ActivityParent? Parent { get; set; }
        internal bool Valid => ActivityRules.Request(RequestId) && HandoffWords.Package(PackageId)
            && HandoffWords.Hash(PacketSha256) && HandoffWords.Hash(ArtifactSha256)
            && (Authorship == "claimed-by-file" ? !callPresent && (ClaimedAuthor == null || ActivityRules.Line(ClaimedAuthor, 60))
                : Authorship == "called-by-boopy" && ClaimedAuthor == null && callPresent && Call != null && Call.Valid)
            && ActivityRules.Time(ImportedAt) && (Parent == null || Parent.Valid);
    }

    /// <summary>Which local model Boopy called, without making its content confirmed.</summary>
    public sealed class ActivityCallSummary
    {
        public string Provider { get; set; } = "";
        public string Model { get; set; } = "";
        internal bool Valid => Provider == "ollama" && ActivityRules.LocalModel(Model);
    }

    /// <summary>The service-recorded call that produced exactly this artifact.</summary>
    public sealed class ActivityCallProvenance
    {
        public string CallId { get; set; } = "";
        public string Provider { get; set; } = "";
        public string Model { get; set; } = "";
        public double? DurationMs { get; set; }
        internal bool Valid => ActivityRules.Call(CallId) && Provider == "ollama" && ActivityRules.LocalModel(Model)
            && DurationMs.HasValue && ActivityRules.Finite(DurationMs.Value) && DurationMs >= 0
            && DurationMs <= 9007199254740991d && Math.Floor(DurationMs.Value) == DurationMs.Value;
    }

    public sealed class ActivityCallFailure
    {
        public string Code { get; set; } = "";
        public string Message { get; set; } = "";
        internal bool Valid => new[] { "assistant_unreachable", "assistant_timeout", "assistant_error", "answer_unreadable", "answer_invalid", "assistant_busy", "interrupted" }.Contains(Code)
            && ActivityRules.Line(Message, 300);
    }

    /// <summary>Operational reply state, distinct from the recorded person's submission.</summary>
    public sealed class ActivityReplyCall
    {
        public string CallId { get; set; } = "";
        public string State { get; set; } = "";
        public ActivityCallFailure? Failure { get; set; }
        internal bool Valid => ActivityRules.Call(CallId) && (State == "running" || State == "imported" ? Failure == null
            : State == "failed" ? Failure != null && Failure.Valid && Failure.Code != "interrupted"
            : State == "interrupted" && Failure != null && Failure.Valid && Failure.Code == "interrupted");
    }

    /// <summary>
    /// viewer-left-right, scale (with low and high labels) or number (with min, max, step and an
    /// optional unit).
    /// </summary>
    public sealed class ActivityAxis
    {
        public string Kind { get; set; } = "";
        public string? Low { get; set; }
        public string? High { get; set; }
        public double? Min { get; set; }
        public double? Max { get; set; }
        public double? Step { get; set; }
        public string? Unit { get; set; }

        internal bool Valid => Kind == "viewer-left-right"
                ? Low == null && High == null && !Min.HasValue && !Max.HasValue && !Step.HasValue && Unit == null
            : Kind == "scale"
                ? ActivityRules.Line(Low, 24) && ActivityRules.Line(High, 24) && !Min.HasValue && !Max.HasValue && !Step.HasValue && Unit == null
            : Kind == "number" && Low == null && High == null && Min.HasValue && Max.HasValue && Step.HasValue
                && ActivityRules.Finite(Min.Value) && ActivityRules.Finite(Max.Value) && ActivityRules.Finite(Step.Value)
                && Min < Max && Step > 0 && Steps.HasValue && (Unit == null || ActivityRules.Line(Unit, 12));

        /// <summary>How many steps span the number axis, counted exactly in micro-units as the contract requires.</summary>
        [JsonIgnore]
        public int? Steps => Kind == "number" && Min.HasValue && Max.HasValue && Step.HasValue
            ? ActivityDerivation.Steps(Min.Value, Max.Value, Step.Value) : null;
    }

    public sealed class ActivitySource
    {
        public string SourceId { get; set; } = "";
        public string Label { get; set; } = "";
    }

    public sealed class ActivityToken
    {
        /// <summary>a to d, in order.</summary>
        public string Key { get; set; } = "";
        public ActivityText? Label { get; set; }

        /// <summary>The person's own context this token refers to; null means illustrative.</summary>
        public ActivitySource? Source { get; set; }

        /// <summary>The recorded position, 0 to 1; null until the person first moves it.</summary>
        public double? Position { get; set; }

        /// <summary>The recorded snapped value on a number axis; null otherwise or when not placed.</summary>
        public double? Value { get; set; }
    }

    public sealed class ActivityTarget
    {
        public string Subject { get; set; } = "";

        /// <summary>left-of or right-of, from the person's own view facing the tray.</summary>
        public string Relation { get; set; } = "";
        public string Object { get; set; } = "";
    }

    /// <summary>The service's mechanical reading of the recorded positions. Never a judgement of correctness.</summary>
    public sealed class ActivityDerived
    {
        /// <summary>null when either is not placed, unclear when too close, else left-of or right-of.</summary>
        public string? Relation { get; set; }
        public bool? MatchesTarget { get; set; }
        public List<string>? Order { get; set; }
        public bool Ties { get; set; }
        public Dictionary<string, double?>? Values { get; set; }
    }

    public sealed class ActivityTile
    {
        /// <summary>t1 to t8, in order.</summary>
        public string Key { get; set; } = "";
        public string Text { get; set; } = "";
        public bool Used { get; set; }
    }

    /// <summary>One component: arrange (axis, tokens, target, derived) or sequence (joiner, language, tiles, chosen, text).</summary>
    public sealed class ActivityComponent
    {
        public string Type { get; set; } = "";
        public ActivityAxis? Axis { get; set; }
        public List<ActivityToken>? Tokens { get; set; }
        public ActivityTarget? Target { get; set; }
        public ActivityDerived? Derived { get; set; }

        /// <summary>space (words of one sentence) or list (ordered steps).</summary>
        public string? Joiner { get; set; }
        public string? Language { get; set; }
        public List<ActivityTile>? Tiles { get; set; }
        public List<string>? Chosen { get; set; }
        public string? Text { get; set; }

        internal bool Valid => Type == "arrange" ? ValidArrange : Type == "sequence" && ValidSequence;

        private bool ValidArrange
        {
            get
            {
                if (Axis == null || !Axis.Valid || Tokens == null || Derived == null || Derived.Order == null) return false;
                var count = Axis.Kind == "viewer-left-right" ? 2 : -1;
                if (Tokens.Count < (Axis.Kind == "scale" ? 2 : 1) || Tokens.Count > 4 || (count > 0 && Tokens.Count != count)) return false;
                for (var index = 0; index < Tokens.Count; index++)
                {
                    var token = Tokens[index];
                    if (token == null || token.Key != ((char)('a' + index)).ToString() || token.Label == null || !token.Label.ValidWithin(24, 40)
                        || (token.Source != null && (string.IsNullOrWhiteSpace(token.Source.SourceId) || token.Source.SourceId.Length > 2048
                            || !ActivityRules.Line(token.Source.Label, 2048)))
                        || (token.Position.HasValue && !ActivityRules.Unit(token.Position.Value))
                        || (token.Value.HasValue && (Axis.Kind != "number" || !token.Position.HasValue || !ActivityRules.Finite(token.Value.Value))))
                        return false;
                }
                var keys = Tokens.Select(token => token.Key).ToList();
                if (Target != null && (Axis.Kind != "viewer-left-right" || (Target.Relation != "left-of" && Target.Relation != "right-of")
                    || !keys.Contains(Target.Subject) || !keys.Contains(Target.Object) || Target.Subject == Target.Object)) return false;
                var derived = Derived;
                return (derived.Relation == null || derived.Relation == "left-of" || derived.Relation == "right-of" || derived.Relation == "unclear")
                    && (Axis.Kind == "viewer-left-right" || derived.Relation == null) && (Target != null || derived.MatchesTarget == null)
                    && derived.Order.All(keys.Contains) && derived.Order.Distinct().Count() == derived.Order.Count
                    && (Axis.Kind == "number"
                        ? derived.Values != null && derived.Values.Keys.All(keys.Contains) && derived.Values.Values.All(value => !value.HasValue || ActivityRules.Finite(value.Value))
                        : derived.Values == null);
            }
        }

        private bool ValidSequence
        {
            get
            {
                if ((Joiner != "space" && Joiner != "list") || !ActivityRules.Language(Language) || Tiles == null || Chosen == null || Text == null
                    || Tiles.Count < 3 || Tiles.Count > 8) return false;
                if (Tiles.Any(tile => tile == null || !ActivityRules.Line(tile.Text, Joiner == "space" ? 24 : 48)
                    || (Joiner == "space" && tile.Text.Any(char.IsWhiteSpace)))) return false;
                // Keys are t1 to tN, each once; the view lists tiles in Boopy's display order, not key order.
                var keys = Tiles.Select(tile => tile.Key).ToList();
                if (!new HashSet<string>(keys, StringComparer.Ordinal).SetEquals(Enumerable.Range(1, Tiles.Count).Select(number => "t" + number.ToString(CultureInfo.InvariantCulture)))
                    || keys.Distinct(StringComparer.Ordinal).Count() != keys.Count) return false;
                return Tiles.Select(tile => tile.Text).Distinct(StringComparer.Ordinal).Count() == Tiles.Count
                    && Chosen.All(keys.Contains) && Chosen.Distinct().Count() == Chosen.Count && !Text.Contains('\n');
            }
        }
    }

    public sealed class ActivityHint
    {
        public int Index { get; set; }
        public string Text { get; set; } = "";
        public string Language { get; set; } = "";
        public string? Gloss { get; set; }
    }

    public sealed class ActivityHints
    {
        public int Total { get; set; }
        public List<ActivityHint>? Revealed { get; set; }
        internal bool Valid => Total >= 0 && Total <= 3 && Revealed != null && Revealed.Count <= Total
            && Revealed.Select((hint, index) => hint != null && hint.Index == index && ActivityRules.Line(hint.Text, 200)
                && ActivityRules.Language(hint.Language) && (hint.Gloss == null || ActivityRules.Line(hint.Gloss, 240))).All(valid => valid);
    }

    /// <summary>The frozen arrangement result of one submission.</summary>
    public sealed class ActivityArrangeResult
    {
        public Dictionary<string, double?>? Positions { get; set; }
        public string? Relation { get; set; }
        public bool? MatchesTarget { get; set; }
        public List<string>? Order { get; set; }
        public bool Ties { get; set; }
        public Dictionary<string, double?>? Values { get; set; }
    }

    public sealed class ActivitySequenceResult
    {
        public List<string>? Chosen { get; set; }
        public string Text { get; set; } = "";
    }

    /// <summary>A local export. Boopy cannot see whether the file was then sent anywhere.</summary>
    public sealed class ActivityExport
    {
        /// <summary>exported-not-sent.</summary>
        public string State { get; set; } = "";
        public string FileSha256 { get; set; } = "";
        public string ExportedAt { get; set; } = "";
        internal bool Valid => State == "exported-not-sent" && HandoffWords.Hash(FileSha256) && ActivityRules.Time(ExportedAt);
    }

    public sealed class ActivityReplyPoint
    {
        /// <summary>overall, arrange, sequence or hints.</summary>
        public string About { get; set; } = "";
        public string Text { get; set; } = "";
        public string Language { get; set; } = "";
        public string? Gloss { get; set; }
    }

    /// <summary>A reply whose own provenance remains separate from the activity it answers.</summary>
    public sealed class ActivityReply
    {
        private ActivityCallProvenance? call;
        private bool callPresent;
        [JsonProperty(NullValueHandling = NullValueHandling.Include)]
        public ActivityCallProvenance? Call { get => call; set { callPresent = true; call = value; } }
        public bool ShouldSerializeCall() => callPresent;
        public string ReplyId { get; set; } = "";
        public string ImportedAt { get; set; } = "";
        public string? ClaimedAuthor { get; set; }
        public string ArtifactSha256 { get; set; } = "";
        public ActivityText? Summary { get; set; }
        public List<ActivityReplyPoint>? Points { get; set; }
        public string? NextActivityId { get; set; }
        internal bool Valid => ActivityRules.Reply(ReplyId) && ActivityRules.Time(ImportedAt)
            && (ClaimedAuthor == null || ActivityRules.Line(ClaimedAuthor, 60)) && HandoffWords.Hash(ArtifactSha256)
            && (callPresent ? Call != null && Call.Valid && ClaimedAuthor == null : Call == null)
            && Summary != null && Summary.ValidWithin(300, 300) && Points != null && Points.Count >= 1 && Points.Count <= 4
            && Points.All(point => point != null && (point.About == "overall" || point.About == "arrange" || point.About == "sequence" || point.About == "hints")
                && ActivityRules.Line(point.Text, 300) && ActivityRules.Language(point.Language) && (point.Gloss == null || ActivityRules.Line(point.Gloss, 300)))
            && (NextActivityId == null || ActivityRules.Activity(NextActivityId));
    }

    public sealed class ActivitySubmission
    {
        private ActivityReplyCall? replyCall;
        private bool replyCallPresent;
        [JsonProperty(NullValueHandling = NullValueHandling.Include)]
        public ActivityReplyCall? ReplyCall { get => replyCall; set { replyCallPresent = true; replyCall = value; } }
        public bool ShouldSerializeReplyCall() => replyCallPresent;
        public string SubmissionId { get; set; } = "";
        public int Number { get; set; }
        public string SubmittedAt { get; set; } = "";
        public int Revision { get; set; }
        public string Digest { get; set; } = "";
        public ActivityArrangeResult? Arrange { get; set; }
        public ActivitySequenceResult? Sequence { get; set; }
        public List<int>? HintsRevealed { get; set; }
        public ActivityExport? Export { get; set; }
        public ActivityReply? Reply { get; set; }
        internal bool ValidAt(int number, int revision, bool called) => ActivityRules.Submission(SubmissionId) && Number == number
            && ActivityRules.Time(SubmittedAt) && Revision >= 0 && Revision <= revision && ActivityRules.Line(Digest, 400)
            && (Arrange == null || (Arrange.Positions != null && Arrange.Order != null))
            && (Sequence == null || (Sequence.Chosen != null && Sequence.Text != null))
            && HintsRevealed != null && (Export == null || Export.Valid)
            && replyCallPresent == called && (ReplyCall == null || ReplyCall.Valid)
            && (Reply == null || Reply.Valid && (Reply.Call == null ? Export != null
                : called && ReplyCall != null && ReplyCall.State == "imported" && ReplyCall.CallId == Reply.Call.CallId))
            && (ReplyCall?.State != "imported" || Reply?.Call != null && Reply.Call.CallId == ReplyCall.CallId);
    }

    /// <summary>One imported activity as the service projects it from the journal.</summary>
    public sealed class ActivityView
    {
        public string ActivityId { get; set; } = "";

        /// <summary>Every headset change names the revision it was made against.</summary>
        public int? Revision { get; set; }

        /// <summary>active or fallback-only.</summary>
        public string Status { get; set; } = "";
        public string? Title { get; set; }
        public string? Purpose { get; set; }
        public ActivityText? Instruction { get; set; }

        /// <summary>A plain-text version of the same activity, always present.</summary>
        public string FallbackText { get; set; } = "";
        public List<string>? Issues { get; set; } = new List<string>();
        public ActivityProvenance? Provenance { get; set; }
        public List<ActivityComponent>? Components { get; set; } = new List<ActivityComponent>();
        public ActivityHints? Hints { get; set; }
        public bool CanSubmit { get; set; }
        public List<ActivitySubmission>? Submissions { get; set; }

        [JsonIgnore] public bool Active => Status == "active";
        [JsonIgnore] public ActivityComponent? Arrange => Components?.FirstOrDefault(component => component?.Type == "arrange");
        [JsonIgnore] public ActivityComponent? Sequence => Components?.FirstOrDefault(component => component?.Type == "sequence");
        [JsonIgnore] public ActivitySubmission? LatestSubmission => Submissions?.LastOrDefault();

        /// <summary>The envelope every view must satisfy before anything of it is shown.</summary>
        public bool ValidFor(string? activityId)
        {
            if (!ActivityRules.Activity(ActivityId) || (activityId != null && ActivityId != activityId)
                || !Revision.HasValue || Revision < 0 || (Status != "active" && Status != "fallback-only")
                || !ActivityRules.Lines(FallbackText, 800) || Provenance == null || !Provenance.Valid
                || (Provenance.Authorship == "called-by-boopy" && Status != "active")
                || (Issues != null && Issues.Any(issue => issue == null || issue.Length > 500))
                || Hints == null || !Hints.Valid || Submissions == null || (Status != "active" && CanSubmit)) return false;
            for (var index = 0; index < Submissions.Count; index++)
                if (Submissions[index] == null || !Submissions[index].ValidAt(index + 1, Revision.Value, Provenance.Authorship == "called-by-boopy")) return false;
            return Submissions.Select(submission => submission.SubmissionId).Distinct().Count() == Submissions.Count;
        }

        /// <summary>
        /// An active view whose components this headset can draw. Anything else shows only its
        /// fallback text, as an unsupported choice card keeps only its ordinary words.
        /// </summary>
        [JsonIgnore]
        public bool Renderable => Active && ActivityRules.Line(Title, 60) && ActivityRules.Line(Purpose, 200)
            && Instruction != null && Instruction.ValidWithin(200, 240)
            && Components != null && Components.Count >= 1 && Components.Count <= 2
            && Components.All(component => component != null && component.Valid)
            && Components.Select(component => component.Type).Distinct().Count() == Components.Count;
    }

    internal static class ActivityRules
    {
        public static bool Activity(string? value) => Identifier(value, "act");
        public static bool Call(string? value) => Identifier(value, "cal");
        public static bool LocalModel(string? value) => value != null && Regex.IsMatch(value, @"\A[A-Za-z0-9][A-Za-z0-9._:/-]{0,44}\z", RegexOptions.CultureInvariant)
            && value.IndexOf("grok", StringComparison.OrdinalIgnoreCase) < 0
            && !Regex.IsMatch(value, @"://|www\.|\b(?:javascript|data|mailto|file|tel|sms|vbscript):\S", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        public static bool Request(string? value) => Identifier(value, "arq");
        public static bool Submission(string? value) => Identifier(value, "sub");
        public static bool Reply(string? value) => Identifier(value, "rep");
        private static bool Identifier(string? value, string prefix) => value != null
            && Regex.IsMatch(value, "\\A" + prefix + "_[A-Za-z0-9_-]{1,64}\\z");

        public static bool Language(string? value) => value != null && Regex.IsMatch(value, "\\A[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}\\z");

        /// <summary>One displayable line within its limit, in UTF-16 units as the service counts them.</summary>
        public static bool Line(string? value, int limit) => !string.IsNullOrWhiteSpace(value) && value!.Length <= limit
            && !value.Any(char.IsControl);

        /// <summary>Text that may span lines, such as the fallback text.</summary>
        public static bool Lines(string? value, int limit) => !string.IsNullOrWhiteSpace(value) && value!.Length <= limit
            && !value.Any(character => char.IsControl(character) && character != '\n');

        public static bool Time(string? value) => !string.IsNullOrWhiteSpace(value)
            && DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out _);

        public static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);

        public static bool Unit(double value) => Finite(value) && value >= 0 && value <= 1;
    }
}
