using Boopy.Client;
using Newtonsoft.Json;
using NUnit.Framework;

namespace Boopy.Client.Tests;

public class EvidenceInputPolicyTests
{
    [Test] public void DefaultRemainsPhysicalAndPendingChoiceCannotChange()
    {
        var policy = new EvidenceInputPolicy();
        var visual = policy.Begin()!;
        Assert.That(visual.RequiresPicture, Is.True);
        Assert.That(policy.Toggle(), Is.False);
        policy.End(); Assert.That(policy.Toggle(), Is.True);
        var spoken = policy.Begin()!;
        Assert.That(spoken.RequiresPicture, Is.False);
        policy.End(); policy.Toggle();
        Assert.That(spoken.SpokenOnly, Is.True);
        Assert.That(policy.Begin()!.RequiresPicture, Is.True);
    }
    [Test] public void BusyAndFocusBlockChangesAndNewTurns()
    {
        var policy = new EvidenceInputPolicy();
        policy.SetInteractionState(false, false);
        Assert.That(policy.Toggle(), Is.False); Assert.That(policy.Begin(), Is.Null);
        policy.SetInteractionState(true, true);
        Assert.That(policy.Toggle(), Is.False); Assert.That(policy.Begin(), Is.Null);
        policy.SetInteractionState(true, false); Assert.That(policy.Toggle(), Is.True);
        var turn = policy.Begin()!;
        policy.SetInteractionState(false, false); policy.End();
        Assert.That(turn.SpokenOnly, Is.True);
        Assert.That(policy.Begin(), Is.Null);
        policy.SetInteractionState(true, false); Assert.That(policy.Begin()!.SpokenOnly, Is.True);
    }
    [Test] public void SpokenTurnSerializesNullFrameAndNoVisualWorkWithoutInferringPlace()
    {
        var turn = new EvidenceTurn(true);
        var request = turn.Start(new SpeechData { Text = "그 여행은 추웠어요. Much Colder." }, new Cues(), new FrameData { Jpeg = "synthetic" });
        var json = Newtonsoft.Json.Linq.JObject.Parse(Wire.Write(request));
        Assert.That(json.ContainsKey("frame"), Is.False);
        Assert.That(request.Speech.Text, Is.EqualTo("그 여행은 추웠어요. Much Colder."));
        Assert.That(request.Attention!.Evidence, Is.EqualTo("none"));
        Assert.That(request.Attention.Source, Is.EqualTo("unknown"));
        Assert.That(request.Attention.OcrRequested || request.Attention.SegmentationRequested, Is.False);
    }
    [Test] public void PhysicalTurnRetainsFrameAndTargetGates()
    {
        var frame = new FrameData();
        var request = new EvidenceTurn(false).Start(new SpeechData(), new Cues { TargetItemId = "synthetic" }, frame);
        Assert.That(request.Frame, Is.SameAs(frame));
        Assert.That(request.Attention!.Evidence, Is.EqualTo("visual"));
        Assert.That(request.Attention.Scope, Is.EqualTo("target"));
        Assert.That(request.Attention.OcrRequested && request.Attention.SegmentationRequested, Is.True);
    }
    [Test] public void SpokenContinuationDropsStalePictureAndPointerButRetainsExplicitCardCorrection()
    {
        var turn = new EvidenceTurn(true);
        var request = turn.Utter(new SpeechData { Text = "Synthetic exact note" }, new Cues { Pointer = new PointerCue(), Gaze = new Cue(), TargetItemId = "explicit-card" }, new FrameData { Jpeg = "stale" });
        var json = Newtonsoft.Json.Linq.JObject.Parse(Wire.Write(request));
        Assert.That(json.ContainsKey("frame"), Is.False);
        Assert.That(request.Cues!.Pointer, Is.Null); Assert.That(request.Cues.Gaze, Is.Null);
        Assert.That(request.Cues.TargetItemId, Is.EqualTo("explicit-card"));
        Assert.That(request.Attention!.Scope, Is.EqualTo("target"));
        Assert.That(request.Attention.OcrRequested || request.Attention.SegmentationRequested, Is.False);
    }
    [Test] public void DiscardedEmptyTurnCanChangeSourceAndBeginAgain()
    {
        var policy = new EvidenceInputPolicy();
        Assert.That(policy.Begin(), Is.Not.Null);
        policy.End();
        Assert.That(policy.Toggle(), Is.True);
        Assert.That(policy.Begin()!.SpokenOnly, Is.True);
    }

    [Test] public void ExplicitIdleSourceSelectionIsIdempotentAndDoesNotBeginCapture()
    {
        var policy = new EvidenceInputPolicy();
        Assert.That(policy.SelectCurrentView(), Is.True);
        Assert.That(policy.SelectCurrentView(), Is.True);
        Assert.That(policy.SpokenOnly, Is.False);
        Assert.That(policy.Pending, Is.Null);
        Assert.That(policy.SelectSpokenOnly(), Is.True);
        Assert.That(policy.SelectSpokenOnly(), Is.True);
        Assert.That(policy.SpokenOnly, Is.True);
        Assert.That(policy.Pending, Is.Null);
        var latched = policy.Begin()!;
        Assert.That(latched.SpokenOnly, Is.True);
        policy.End();
        Assert.That(policy.Begin()!.SpokenOnly, Is.True, "the explicit selection persists for later turns");
    }

    [Test] public void ExplicitSelectionsRejectUnfocusedBusyAndPendingWithoutChangingLatchedTurn()
    {
        var policy = new EvidenceInputPolicy();
        Assert.That(policy.SelectSpokenOnly(), Is.True);
        foreach (var state in new[] { (false, false), (true, true), (false, true) })
        {
            policy.SetInteractionState(state.Item1, state.Item2);
            Assert.That(policy.SelectCurrentView(), Is.False);
            Assert.That(policy.SelectSpokenOnly(), Is.False);
            Assert.That(policy.SpokenOnly, Is.True);
            Assert.That(policy.Pending, Is.Null);
        }
        policy.SetInteractionState(true, false);
        var pending = policy.Begin()!;
        Assert.That(policy.SelectCurrentView(), Is.False);
        Assert.That(policy.SelectSpokenOnly(), Is.False);
        Assert.That(policy.Toggle(), Is.False);
        Assert.That(policy.Pending, Is.SameAs(pending));
        Assert.That(pending.SpokenOnly, Is.True);
        policy.End();
        Assert.That(policy.SelectCurrentView(), Is.True);
        Assert.That(policy.Begin()!.RequiresPicture, Is.True);
        Assert.That(pending.SpokenOnly, Is.True, "a completed turn keeps its own captured policy");
    }

    [Test] public void ExplicitNextTurnUsesFreshCurrentFrameOrOmitsSpokenFrameAndStaleVisualCues()
    {
        var policy = new EvidenceInputPolicy();
        policy.SelectSpokenOnly();
        var spoken = policy.Begin()!;
        var stale = new FrameData { Jpeg = "synthetic-stale-frame" };
        var words = new SpeechData { Text = "Synthetic spoken recollection. 추웠어요." };
        var spokenRequest = spoken.Start(words, new Cues { Gaze = new Cue(), Pointer = new PointerCue() }, stale);
        Assert.That(spokenRequest.Frame, Is.Null);
        Assert.That(spokenRequest.Cues.Gaze, Is.Null);
        Assert.That(spokenRequest.Cues.Pointer, Is.Null);
        Assert.That(spokenRequest.Cues.TargetItemId, Is.Null);
        Assert.That(spokenRequest.Attention!.Evidence, Is.EqualTo("none"));
        Assert.That(spokenRequest.Attention.Source, Is.EqualTo("unknown"));
        Assert.That(spokenRequest.Attention.Scope, Is.EqualTo("scene"));
        Assert.That(spokenRequest.Attention.OcrRequested || spokenRequest.Attention.SegmentationRequested, Is.False);
        Assert.That(Newtonsoft.Json.Linq.JObject.Parse(Wire.Write(spokenRequest)).ContainsKey("frame"), Is.False);
        policy.End(); policy.SelectCurrentView();
        var current = policy.Begin()!;
        var fresh = new FrameData { Jpeg = "synthetic-new-current-frame", Source = "current-surroundings", TimestampTrusted = false };
        var currentRequest = current.Start(words, new Cues(), fresh);
        Assert.That(currentRequest.Frame, Is.SameAs(fresh));
        Assert.That(currentRequest.Frame, Is.Not.SameAs(stale));
        Assert.That(currentRequest.Attention!.Evidence, Is.EqualTo("visual"));
        Assert.That(currentRequest.Attention.Source, Is.EqualTo("current-surroundings"));
        Assert.That(currentRequest.Attention.OcrRequested, Is.True);
        Assert.That(currentRequest.Attention.SegmentationRequested, Is.False);
        Assert.That(currentRequest.Speech, Is.SameAs(words));
        Assert.That(spoken.SpokenOnly, Is.True);
    }

    private static RecordedFrameRef Recorded() => new RecordedFrameRef
    {
        RecordingId = "rec_0123456789abcdef0123456789abcdef", FrameId = "rfr_fedcba9876543210fedcba9876543210",
    };

    // A recorded still has no room: the gaze point on it is all that goes, never a room point, a depth claim or a pointer.
    private static Cues RoomCues() => new Cues
    {
        Gaze = new Cue { Point = new Point2 { X = .3f, Y = .7f }, World = new[] { 1f, 2f, 3f }, OnSurface = true },
        Pointer = new PointerCue { Point = new Point2 { X = .9f, Y = .1f } },
    };

    [Test] public void ATurnOnARecordedStillSendsItsReferenceAsPastRecollectionAndOnlyTheGazePoint()
    {
        var start = new EvidenceTurn(false).Start(new SpeechData { Text = "Synthetic question." }, RoomCues(), null, Recorded());
        Assert.That(start.Frame, Is.Null);
        Assert.That(start.RecordedFrame!.FrameId, Is.EqualTo("rfr_fedcba9876543210fedcba9876543210"));
        Assert.That(start.Attention!.Source, Is.EqualTo("past-recollection"));
        Assert.That(start.Attention.Evidence, Is.EqualTo("visual"));
        Assert.That(start.Cues.Gaze!.Point.X, Is.EqualTo(.3f));
        Assert.That(start.Cues.Gaze.Point.Y, Is.EqualTo(.7f));
        Assert.That(start.Cues.Gaze.World, Is.Null);
        Assert.That(start.Cues.Gaze.OnSurface, Is.False);
        Assert.That(start.Cues.Pointer, Is.Null);
        var json = Newtonsoft.Json.Linq.JObject.Parse(Wire.Write(start));
        Assert.That(json.ContainsKey("frame"), Is.False);
        Assert.That(((Newtonsoft.Json.Linq.JObject)json["cues"]!["gaze"]!).ContainsKey("world"), Is.False);
        var utter = new EvidenceTurn(false).Utter(new SpeechData { Text = "Synthetic follow-on." }, RoomCues(), null, Recorded());
        Assert.That(utter.Frame, Is.Null);
        Assert.That(utter.RecordedFrame, Is.Not.Null);
        Assert.That(utter.Attention!.Source, Is.EqualTo("past-recollection"));
        Assert.That(utter.Cues!.Gaze!.World, Is.Null);
        Assert.That(utter.Cues.Pointer, Is.Null);
    }

    // Only a session's first turn opens a task, so each boop on a recording starts its own session. A live turn, or a
    // spoken-only one, continues the open session as before.
    [Test] public void ASecondBoopOnARecordingStartsANewSession()
    {
        var boop = new EvidenceTurn(false);
        Assert.That(boop.StartsSession(null, Recorded()), Is.True, "The first boop starts a session.");
        Assert.That(boop.StartsSession("review", Recorded()), Is.True, "A second boop on a recording starts a new session.");
        Assert.That(boop.StartsSession("committed", Recorded()), Is.True);
        Assert.That(boop.StartsSession("review", null), Is.False, "A live turn continues the open session.");
        Assert.That(boop.StartsSession(null, null), Is.True);
        Assert.That(boop.StartsSession("committed", null), Is.True);
        Assert.That(new EvidenceTurn(true).StartsSession("review", Recorded()), Is.False, "A spoken-only turn is about no still.");
    }

    [Test] public void ASpokenOnlyTurnSendsNoRecordedStillAndAFrameAndAStillTogetherAreRefused()
    {
        var spoken = new EvidenceTurn(true).Start(new SpeechData { Text = "Synthetic recollection." }, RoomCues(), null, Recorded());
        Assert.That(spoken.RecordedFrame, Is.Null);
        Assert.That(spoken.Attention!.Source, Is.EqualTo("unknown"));
        Assert.That(new EvidenceTurn(true).Utter(new SpeechData(), RoomCues(), null, Recorded()).RecordedFrame, Is.Null);
        Assert.Throws<System.ArgumentException>(() => new EvidenceTurn(false).Start(new SpeechData(), new Cues(), new FrameData(), Recorded()));
        Assert.Throws<System.ArgumentException>(() => new EvidenceTurn(false).Utter(new SpeechData(), new Cues(), new FrameData(), Recorded()));
    }
}
