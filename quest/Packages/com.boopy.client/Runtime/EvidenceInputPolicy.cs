#nullable enable
namespace Boopy.Client
{
    /// <summary>Explicit wearer choice, latched at talk start; no interpretation of spoken intent.</summary>
    public sealed class EvidenceInputPolicy
    {
        private bool available = true;
        public bool SpokenOnly { get; private set; }
        public EvidenceTurn? Pending { get; private set; }
        public void SetInteractionState(bool focused, bool busy) => available = focused && !busy;
        public bool Toggle() => Select(!SpokenOnly);
        public bool SelectCurrentView() => Select(false);
        public bool SelectSpokenOnly() => Select(true);
        private bool Select(bool spokenOnly)
        {
            if (!available || Pending != null) return false;
            SpokenOnly = spokenOnly; return true;
        }
        public EvidenceTurn? Begin()
        {
            if (!available || Pending != null) return null;
            Pending = new EvidenceTurn(SpokenOnly); return Pending;
        }
        public void End() => Pending = null;
    }
    public sealed class EvidenceTurn
    {
        public bool SpokenOnly { get; }
        public bool RequiresPicture => !SpokenOnly;
        public EvidenceTurn(bool spokenOnly) => SpokenOnly = spokenOnly;
        public AttentionInput Attention(bool targeted) => new AttentionInput
        {
            Source = SpokenOnly ? "unknown" : "current-surroundings",
            Evidence = SpokenOnly ? "none" : "visual",
            Scope = targeted ? "target" : "scene",
            OcrRequested = !SpokenOnly,
            SegmentationRequested = !SpokenOnly && targeted,
        };
        public StartSessionRequest Start(SpeechData speech, Cues cues, FrameData? frame) => new StartSessionRequest
        {
            Frame = SpokenOnly ? null : frame,
            Speech = speech, Cues = PreparedCues(cues), Attention = Attention(cues.TargetItemId != null || (!SpokenOnly && cues.Pointer != null)),
            Device = new DeviceInfo(),
        };
        public UtteranceRequest Utter(SpeechData speech, Cues? cues, FrameData? frame) => new UtteranceRequest
        {
            Frame = SpokenOnly ? null : frame, Speech = speech,
            Cues = PreparedCues(cues ?? new Cues()),
            Attention = Attention(cues?.TargetItemId != null || (!SpokenOnly && cues?.Pointer != null)),
        };
        private Cues PreparedCues(Cues cues) => SpokenOnly ? new Cues { TargetItemId = cues.TargetItemId } : cues;

    }
}
