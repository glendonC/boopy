#nullable enable
using System;

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
        public AttentionInput Attention(bool targeted, bool recorded = false) => new AttentionInput
        {
            Source = SpokenOnly ? "unknown" : recorded ? "past-recollection" : "current-surroundings",
            Evidence = SpokenOnly ? "none" : "visual",
            Scope = targeted ? "target" : "scene",
            OcrRequested = !SpokenOnly,
            SegmentationRequested = !SpokenOnly && targeted,
        };
        public StartSessionRequest Start(SpeechData speech, Cues cues, FrameData? frame, RecordedFrameRef? recorded = null)
        {
            var still = Still(frame, recorded);
            var prepared = PreparedCues(cues, still != null);
            return new StartSessionRequest
            {
                Frame = SpokenOnly ? null : frame, RecordedFrame = still,
                Speech = speech, Cues = prepared, Attention = Attention(Targeted(prepared), still != null),
                Device = new DeviceInfo(),
            };
        }
        public UtteranceRequest Utter(SpeechData speech, Cues? cues, FrameData? frame, RecordedFrameRef? recorded = null)
        {
            var still = Still(frame, recorded);
            var prepared = PreparedCues(cues ?? new Cues(), still != null);
            return new UtteranceRequest
            {
                Frame = SpokenOnly ? null : frame, RecordedFrame = still, Speech = speech,
                Cues = prepared,
                Attention = Attention(Targeted(prepared), still != null),
            };
        }
        // The recorded still a picture turn is about; a spoken turn has none. A frame and a still never go together.
        private RecordedFrameRef? Still(FrameData? frame, RecordedFrameRef? recorded)
        {
            if (frame != null && recorded != null) throw new ArgumentException("A turn sends a frame or a recorded still, never both.");
            return SpokenOnly ? null : recorded;
        }
        private bool Targeted(Cues prepared) => prepared.TargetItemId != null || (!SpokenOnly && prepared.Pointer != null);
        // A recorded still has no room: only the gaze point on it goes, never a room point, a depth claim or a pointer.
        private Cues PreparedCues(Cues cues, bool recorded) => SpokenOnly ? new Cues { TargetItemId = cues.TargetItemId }
            : recorded ? new Cues { TargetItemId = cues.TargetItemId, Gaze = cues.Gaze == null ? null : new Cue { Point = cues.Gaze.Point } }
            : cues;

    }
}
