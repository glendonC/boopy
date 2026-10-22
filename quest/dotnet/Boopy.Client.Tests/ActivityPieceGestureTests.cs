#nullable enable
using System.Numerics;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class ActivityPieceGestureTests
    {
        // A 690 mm track one meter ahead at eye height, pieces 150 mm wide: 540 mm of travel.
        private static readonly ActivityTrack Track = new ActivityTrack(
            new Vector3(-0.345f, 1.4f, 1f), new Vector3(0.345f, 1.4f, 1f), new Vector3(0f, 0f, -1f), 0.15f);
        private const float Frame = 1f / 72f;

        /// <summary>Meters along the track where a piece at this position has its center.</summary>
        private static float At(double position) => Track.CenterAt(position);

        /// <summary>Hold the ray still long enough for smoothing to settle; returns the time reached.</summary>
        private static float Hold(ActivityPieceGesture gesture, float along, float from, float seconds = 0.5f)
        {
            var now = from;
            for (var frame = 0; frame < seconds / Frame; frame++) { now += Frame; gesture.Move(along, now); }
            return now;
        }

        [Test]
        public void TheTrackProjectsTheHandRayOntoTheSheetPlane()
        {
            Assert.That(Track.Along(new Vector3(0f, 1.4f, 0f), Vector3.UnitZ, out var center), Is.True);
            Assert.That(center, Is.EqualTo(0.345f).Within(1e-5f));
            Assert.That(Track.Along(new Vector3(0f, 1.2f, 0f), Vector3.Normalize(new Vector3(0.2f, 0.2f, 1f)), out var right), Is.True);
            Assert.That(right, Is.EqualTo(0.545f).Within(1e-5f), "Only the along-track coordinate matters; height is ignored.");
            Assert.That(Track.Along(new Vector3(0f, 1.4f, 0f), Vector3.UnitX, out _), Is.False, "A ray parallel to the sheet never meets it.");
            Assert.That(Track.Along(new Vector3(0f, 1.4f, 0f), -Vector3.UnitZ, out _), Is.False, "A ray pointing away never meets it.");
            Assert.That(Track.PositionAt(0.075f), Is.EqualTo(0).Within(1e-6), "Position 0 puts the piece's left edge at Your left.");
            Assert.That(Track.PositionAt(0.615f), Is.EqualTo(1).Within(1e-6));
            Assert.That(Track.PositionAt(0f), Is.EqualTo(0), "Clamped to the lane.");
            Assert.That(Track.PositionAt(0.9f), Is.EqualTo(1));
            Assert.That(Track.CenterAt(0.5), Is.EqualTo(0.345f).Within(1e-6f));
            Assert.That(new ActivityTrack(Vector3.Zero, new Vector3(0.1f, 0, 0), Vector3.UnitZ, 0.15f).Valid, Is.False, "A piece wider than its track cannot move.");
        }

        [Test]
        public void APinchThatBarelyMovesIsATapThatSelectsWithoutOfferingAChange()
        {
            var gesture = new ActivityPieceGesture();
            Assert.That(gesture.Begin("a", 0.22, Track, null, At(0.22), 0f), Is.True);
            var now = Hold(gesture, At(0.22) + 0.007f, 0f, 0.6f);
            Assert.That(gesture.Dragging, Is.False, "7 mm of jitter is still a tap, even held past the talk threshold.");
            Assert.That(gesture.End(0.22, now, out _), Is.EqualTo(ActivityPieceResult.Selected));
            Assert.That(gesture.Selected, Is.EqualTo("a"));
            Assert.That(gesture.Pending, Is.Null);
            gesture.Begin("b", 0.71, Track, null, At(0.71), now);
            Assert.That(gesture.End(0.71, now + 0.1f, out _), Is.EqualTo(ActivityPieceResult.Selected));
            Assert.That(gesture.Selected, Is.EqualTo("b"), "Tapping another piece moves the selection.");
            gesture.Begin("b", 0.71, Track, null, At(0.71), now + 0.2f);
            Assert.That(gesture.End(0.71, now + 0.3f, out _), Is.EqualTo(ActivityPieceResult.Deselected));
            Assert.That(gesture.Selected, Is.Null);
        }

        [Test]
        public void ADragPreviewsWithoutRecordingAndOffersOnlyTheReleasedPosition()
        {
            var gesture = new ActivityPieceGesture();
            gesture.Begin("a", 0.22, Track, null, At(0.22), 0f);
            var now = Hold(gesture, At(0.22) + 0.054f, 0f);
            Assert.That(gesture.Dragging, Is.True);
            Assert.That(gesture.Preview, Is.EqualTo(0.32).Within(1e-3), "0.054 m is a tenth of the travel.");
            Assert.That(gesture.Pending, Is.Null, "Nothing is offered for recording while held.");
            Assert.That(gesture.Displayed("a", 0.22), Is.EqualTo(gesture.Preview));
            Assert.That(gesture.Displayed("b", 0.71), Is.EqualTo(0.71), "Other pieces keep their recorded positions.");
            Assert.That(gesture.End(0.22, now, out var change), Is.EqualTo(ActivityPieceResult.Change));
            Assert.That(change.Key, Is.EqualTo("a"));
            Assert.That(change.Position, Is.EqualTo(0.32).Within(1e-3));
            Assert.That(gesture.Preview, Is.Null);
            Assert.That(gesture.Pending!.Value.Position, Is.EqualTo(change.Position));
            Assert.That(gesture.Displayed("a", 0.22), Is.EqualTo(change.Position), "The released piece stays put while the Mac answers.");
            Assert.That(gesture.Begin("b", 0.71, Track, null, At(0.71), now), Is.False, "Changes are recorded one at a time.");
            gesture.Settle();
            Assert.That(gesture.Displayed("a", 0.22), Is.EqualTo(0.22), "Once settled, only the recorded view is drawn.");
            Assert.That(gesture.Begin("b", 0.71, Track, null, At(0.71), now), Is.True);
        }

        [Test]
        public void GrabbingOffCenterDoesNotMakeThePieceJump()
        {
            var gesture = new ActivityPieceGesture();
            var grabbedAtRightEdge = At(0.22) + 0.07f;
            gesture.Begin("a", 0.22, Track, null, grabbedAtRightEdge, 0f);
            Hold(gesture, grabbedAtRightEdge + 0.027f, 0f);
            Assert.That(gesture.Preview, Is.EqualTo(0.27).Within(1e-3));
        }

        [Test]
        public void ReleaseUsesThePositionFromEightyMillisecondsEarlierToCancelReleaseShift()
        {
            var gesture = new ActivityPieceGesture();
            gesture.Begin("a", null, Track, null, At(0.5), 0f);
            var now = Hold(gesture, At(0.7), 0f);
            Assert.That(gesture.Preview, Is.EqualTo(0.7).Within(1e-3));
            // Opening the pinch drags the knuckle ray 30 mm in the last 40 ms.
            now += 0.02f; gesture.Move(At(0.7) + 0.03f, now);
            now += 0.02f; gesture.Move(At(0.7) + 0.03f, now);
            Assert.That(gesture.End(null, now, out var change), Is.EqualTo(ActivityPieceResult.Change));
            Assert.That(change.Position, Is.EqualTo(0.7).Within(1e-3));
        }

        [Test]
        public void SmoothingFollowsTheHandWithoutJumping()
        {
            var gesture = new ActivityPieceGesture();
            gesture.Begin("a", 0.5, Track, null, At(0.5), 0f);
            gesture.Move(At(0.6), Frame);
            var first = gesture.Preview!.Value;
            Assert.That(first, Is.GreaterThan(0.5).And.LessThan(0.6), "One frame moves part of the way.");
            Hold(gesture, At(0.6), Frame);
            Assert.That(gesture.Preview, Is.EqualTo(0.6).Within(1e-3));
        }

        [Test]
        public void AnUnplacedPieceStartsAtLaneCenterAndIsClampedToItsLane()
        {
            var gesture = new ActivityPieceGesture();
            Assert.That(gesture.Displayed("a", null), Is.EqualTo(0.5));
            gesture.Begin("a", null, Track, null, At(0.5), 0f);
            var now = Hold(gesture, At(0.5) + 0.5f, 0f);
            Assert.That(gesture.Preview, Is.EqualTo(1));
            now = Hold(gesture, At(0.5) - 0.6f, now);
            Assert.That(gesture.Preview, Is.EqualTo(0));
            Assert.That(gesture.End(null, now, out var change), Is.EqualTo(ActivityPieceResult.Change));
            Assert.That(change.Position, Is.EqualTo(0));
        }

        [Test]
        public void LosingTheHandRayMidDragCancelsAndThePieceReturnsToItsRecordedPosition()
        {
            var gesture = new ActivityPieceGesture();
            gesture.Begin("a", 0.22, Track, null, At(0.22), 0f);
            var now = Hold(gesture, At(0.6), 0f);
            Assert.That(gesture.Move(null, now + Frame), Is.EqualTo(ActivityPieceResult.Cancelled));
            Assert.That(gesture.Held, Is.Null);
            Assert.That(gesture.Pending, Is.Null);
            Assert.That(gesture.Displayed("a", 0.22), Is.EqualTo(0.22));
            Assert.That(gesture.End(0.22, now + 0.1f, out _), Is.EqualTo(ActivityPieceResult.None), "The pinch's own release changes nothing after a cancel.");
        }

        [Test]
        public void WithoutTheHandRayAPinchCanOnlyTap()
        {
            var gesture = new ActivityPieceGesture();
            gesture.Begin("a", 0.22, Track, null, null, 0f);
            var now = Hold(gesture, At(0.9), 0f);
            Assert.That(gesture.Dragging, Is.False, "Drags need the hand ray; the head ray only selects.");
            Assert.That(gesture.End(0.22, now, out _), Is.EqualTo(ActivityPieceResult.Selected));
            gesture.Begin("a", 0.22, Track, null, At(0.22), now);
            gesture.Move(null, now + Frame);
            Hold(gesture, At(0.9), now + Frame);
            Assert.That(gesture.Dragging, Is.False, "A ray lost before the drag began makes this pinch a tap.");
            gesture.Cancel();
            Assert.That(gesture.Held, Is.Null);
        }

        [Test]
        public void ADragClearsTheSelectionAndAReleaseWhereItStartedOffersNothing()
        {
            var gesture = new ActivityPieceGesture();
            gesture.Begin("a", 0.22, Track, null, At(0.22), 0f);
            gesture.End(0.22, 0.1f, out _);
            Assert.That(gesture.Selected, Is.EqualTo("a"));
            gesture.Begin("a", 0.22, Track, null, At(0.22), 0.2f);
            var now = Hold(gesture, At(0.4), 0.2f);
            Assert.That(gesture.Selected, Is.Null);
            now = Hold(gesture, At(0.22), now, 1f);
            Assert.That(gesture.End(0.22, now, out _), Is.EqualTo(ActivityPieceResult.None));
            Assert.That(gesture.Pending, Is.Null);
        }

        [Test]
        public void NumberPiecesSnapToStepsAndHoldEachStepAcrossADeadBand()
        {
            // 0 to 200 MAD in steps of 5: 40 steps, 13.5 mm of travel each.
            const int steps = 40;
            float Index(double index) => At(index / steps);
            var gesture = new ActivityPieceGesture();
            gesture.Begin("a", 0.25, Track, steps, Index(10), 0f);
            var now = Hold(gesture, Index(10.6), 0f);
            Assert.That(gesture.Preview, Is.EqualTo(10 / 40.0), "Inside the dead band past the midpoint, the step holds.");
            now = Hold(gesture, Index(10.7), now);
            Assert.That(gesture.Preview, Is.EqualTo(11 / 40.0));
            now = Hold(gesture, Index(10.4), now);
            Assert.That(gesture.Preview, Is.EqualTo(11 / 40.0), "Coming back, the new step holds across the band too.");
            now = Hold(gesture, Index(10.3), now);
            Assert.That(gesture.Preview, Is.EqualTo(10 / 40.0));
            now = Hold(gesture, Index(17.2), now);
            Assert.That(gesture.End(0.25, now, out var change), Is.EqualTo(ActivityPieceResult.Change));
            Assert.That(change.Position, Is.EqualTo(17 / 40.0));
            var axis = new ActivityAxis { Kind = "number", Min = 0, Max = 200, Step = 5, Unit = "MAD" };
            Assert.That(ActivityDerivation.Value(axis, change.Position), Is.EqualTo(85), "The offered position snaps exactly to the shown value.");
        }

        [Test]
        public void TheTapFallbackPlacesTheSelectedPieceOnlyOnItsOwnLane()
        {
            var gesture = new ActivityPieceGesture();
            Assert.That(gesture.Place("a", Track, null, At(0.5), out _), Is.False, "Nothing is selected yet.");
            gesture.Begin("a", null, Track, null, At(0.5), 0f);
            gesture.End(null, 0.1f, out _);
            Assert.That(gesture.Place("b", Track, null, At(0.5), out _), Is.False, "Another piece's lane does not place this one.");
            Assert.That(gesture.Place("a", Track, null, At(0.8), out var change), Is.True);
            Assert.That((change.Key, change.Position), Is.EqualTo(("a", 0.8)));
            Assert.That(gesture.Pending, Is.Not.Null);
            Assert.That(gesture.Place("a", Track, null, At(0.3), out _), Is.False, "Wait for the Mac before the next change.");
            gesture.Settle();
            Assert.That(gesture.Place("a", Track, 40, At(10.4 / 40), out var snapped), Is.True);
            Assert.That(snapped.Position, Is.EqualTo(10 / 40.0), "A number piece snaps to the nearest step.");
            Assert.That(gesture.Selected, Is.EqualTo("a"), "The selection stays for further taps and nudges.");
        }

        [Test]
        public void NudgesMoveAPlacedNumberPieceOneStepWithinItsLimits()
        {
            var gesture = new ActivityPieceGesture();
            Assert.That(ActivityPieceGesture.CanNudge(null, 40, 1), Is.False, "Disabled until placed.");
            Assert.That(ActivityPieceGesture.CanNudge(0, 40, -1), Is.False);
            Assert.That(ActivityPieceGesture.CanNudge(1, 40, 1), Is.False);
            Assert.That(ActivityPieceGesture.CanNudge(0, 40, 1), Is.True);
            Assert.That(gesture.Nudge("a", 0.25, 40, 1, out var up), Is.True);
            Assert.That(up.Position, Is.EqualTo(0.275));
            Assert.That(gesture.Nudge("a", 0.25, 40, -1, out _), Is.False, "One change at a time.");
            gesture.Settle();
            Assert.That(gesture.Nudge("a", 0.275, 40, -1, out var down), Is.True);
            Assert.That(down.Position, Is.EqualTo(0.25));
        }

        [Test]
        public void OnlyOnePinchAtATimeAndResetForgetsEverything()
        {
            var gesture = new ActivityPieceGesture();
            Assert.That(gesture.Begin("a", 0.22, Track, null, At(0.22), 0f), Is.True);
            Assert.That(gesture.Begin("b", 0.71, Track, null, At(0.71), 0f), Is.False);
            Assert.That(gesture.Begin("", 0.71, Track, null, At(0.71), 0f), Is.False);
            gesture.Reset();
            Assert.That((gesture.Held, gesture.Selected, gesture.Pending, gesture.Dragging), Is.EqualTo(((string?)null, (string?)null, (ActivityPieceChange?)null, false)));
            Assert.That(gesture.Begin("b", 0.71, Track, 0, At(0.71), 0f), Is.False, "A number axis has at least one step.");
        }
    }
}
