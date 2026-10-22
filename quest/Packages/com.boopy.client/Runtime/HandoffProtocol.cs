#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace Boopy.Client
{
    public sealed class HandoffRequest
    {
        public string RequestId { get; set; } = "";
        public string PackageId { get; set; } = "";
        public HandoffMemorySelection? Memory { get; set; }
        public HandoffReferenceSelection? References { get; set; }
        [Newtonsoft.Json.JsonIgnore]
        public bool Valid => HandoffWords.Identifier(RequestId) && HandoffWords.Package(PackageId)
            && (Memory == null || Memory.Valid) && (References == null || References.Valid);
    }
    public sealed class HandoffMemorySelection
    {
        public List<string> PackageIds { get; set; } = new List<string>();
        public string Query { get; set; } = "";
        [Newtonsoft.Json.JsonIgnore]
        public bool Valid => PackageIds != null && PackageIds.Count >= 1 && PackageIds.Count <= 10
            && PackageIds.All(HandoffWords.Package) && !string.IsNullOrWhiteSpace(Query) && Query.Trim().Length <= 500;
    }
    public sealed class HandoffReferenceSelection
    {
        public string PackageId { get; set; } = "";
        public string ItemId { get; set; } = "";
        public string ConceptKey { get; set; } = "";
        public string ReferenceId { get; set; } = "";
        [Newtonsoft.Json.JsonIgnore]
        public bool Valid => HandoffWords.Package(PackageId) && !string.IsNullOrEmpty(ItemId) && ItemId.Length <= 256
            && ((ConceptKey == "dune" && ReferenceId == "Q25391")
                || (ConceptKey == "desert" && ReferenceId == "Q8514")
                || (ConceptKey == "dromedary" && ReferenceId == "Q71516"));
    }
    public sealed class HandoffStatus
    {
        public string SessionId { get; set; } = "";
        public string RequestId { get; set; } = "";
        public string PackageId { get; set; } = "";
        public string ReceiptId { get; set; } = "";
        public string SelectionSha256 { get; set; } = "";
        public int? Attempt { get; set; }
        public string State { get; set; } = "";
        public string? Reason { get; set; }
        public string? SourceState { get; set; }
        public HandoffReceipt? Receipt { get; set; }
        public bool ValidFor(string sessionId, string requestId, string? packageId = null, HandoffRequest? selection = null)
        {
            if (SessionId != sessionId || RequestId != requestId || !HandoffWords.Package(PackageId)
                || (packageId != null && PackageId != packageId) || !HandoffWords.Receipt(ReceiptId)
                || !HandoffWords.Hash(SelectionSha256) || !Attempt.HasValue || Attempt < 1 || Attempt > 3) return false;
            if (State == "preparing-local") return Receipt == null && Reason == null && SourceState == null;
            if (State == "failed") return Receipt == null && SourceState == null && (Reason == "preparation_failed" || Reason == "interrupted");
            if (State != "prepared-local" || (SourceState != "unchanged" && SourceState != "changed") || Reason != null || Receipt == null
                || !Receipt.Valid || Receipt.RequestId != RequestId || Receipt.ReceiptId != ReceiptId
                || Receipt.PackageId != PackageId || Receipt.SelectionSha256 != SelectionSha256) return false;
            if (selection == null) return true;
            var expected = new HashSet<string>(selection.Memory?.PackageIds ?? new List<string>()) { selection.PackageId };
            if (selection.References != null) expected.Add(selection.References.PackageId);
            return expected.SetEquals(Receipt.SelectedPackageIds)
                && (selection.Memory == null ? Receipt.Memory!.Status == "disabled" : Receipt.Memory!.Status != "disabled")
                && (selection.References == null ? Receipt.References!.Status == "disabled" : Receipt.References!.Status != "disabled");
        }
    }
    public sealed class HandoffReceipt
    {
        public string ReceiptId { get; set; } = "";
        public string RequestId { get; set; } = "";
        public string State { get; set; } = "";
        public string PackageId { get; set; } = "";
        public string SelectionSha256 { get; set; } = "";
        public string BaselineSha256 { get; set; } = "";
        public string PacketSha256 { get; set; } = "";
        public string SourceSnapshotSha256 { get; set; } = "";
        public string PreparedAt { get; set; } = "";
        public bool? HistoricalSnapshot { get; set; }
        public List<string> SelectedPackageIds { get; set; } = new List<string>();
        public List<string> SelectedSourceIds { get; set; } = new List<string>();
        public HandoffMemoryResult? Memory { get; set; }
        public HandoffReferenceResult? References { get; set; }
        public string Delivery { get; set; } = "";
        [Newtonsoft.Json.JsonIgnore]
        public bool Valid => State == "prepared-local" && Delivery == "not-sent" && HistoricalSnapshot == true
            && HandoffWords.Receipt(ReceiptId) && HandoffWords.Identifier(RequestId) && HandoffWords.Package(PackageId)
            && HandoffWords.Hash(SelectionSha256) && HandoffWords.Hash(BaselineSha256)
            && HandoffWords.Hash(PacketSha256) && HandoffWords.Hash(SourceSnapshotSha256)
            && DateTimeOffset.TryParse(PreparedAt, System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.RoundtripKind, out _)
            && SelectedPackageIds != null && SelectedPackageIds.Count >= 1 && SelectedPackageIds.Count <= 12
            && SelectedPackageIds.All(HandoffWords.Package) && SelectedPackageIds.Contains(PackageId)
            && SelectedPackageIds.Distinct().Count() == SelectedPackageIds.Count
            && SelectedSourceIds != null && SelectedSourceIds.Count <= 2048
            && SelectedSourceIds.Distinct().Count() == SelectedSourceIds.Count
            && SelectedSourceIds.All(source => source != null && source.Length <= 2048
                && SelectedPackageIds.Any(id => source.StartsWith(id + ":", StringComparison.Ordinal) && source.Length > id.Length + 1))
            && Memory != null && Memory.Valid && References != null && References.Valid;
    }
    public sealed class HandoffMemoryResult
    {
        public string Status { get; set; } = "";
        public int? ReturnedSources { get; set; }
        [Newtonsoft.Json.JsonIgnore]
        public bool Valid => HandoffWords.Module(Status) && ReturnedSources.HasValue && ReturnedSources >= 0
            && ReturnedSources <= 20 && (Status == "available" || ReturnedSources == 0);
    }
    public sealed class HandoffReferenceResult
    {
        public string Status { get; set; } = "";
        public int? ReturnedAssociations { get; set; }
        public string? SourceRecordSha256 { get; set; }
        [Newtonsoft.Json.JsonIgnore]
        public bool Valid => HandoffWords.Module(Status) && ReturnedAssociations.HasValue && ReturnedAssociations >= 0
            && ReturnedAssociations <= 1 && (Status == "available" ? ReturnedAssociations == 1 && HandoffWords.Hash(SourceRecordSha256)
                : ReturnedAssociations == 0 && SourceRecordSha256 == null);
    }
    internal static class HandoffWords
    {
        public static bool Identifier(string? value) => value != null && Regex.IsMatch(value, "\\A[a-zA-Z0-9_-]{1,128}\\z");
        public static bool Package(string? value) => value != null && Regex.IsMatch(value, "\\Actx_[a-zA-Z0-9_-]{1,128}\\z");
        public static bool Receipt(string? value) => value != null && value.StartsWith("handoff_", StringComparison.Ordinal)
            && Guid.TryParseExact(value.Substring(8), "D", out _);
        public static bool Hash(string? value) => value != null && Regex.IsMatch(value, "\\A[a-f0-9]{64}\\z");
        public static bool Module(string value) => value == "disabled" || value == "available" || value == "unavailable";
    }
}
