#nullable enable
using System;
using System.Collections.Generic;
using System.Numerics;

namespace Boopy.Client
{
    /// <summary>
    /// The straight track one piece slides along, on the activity sheet's plane, in world space
    /// (meters). A position of 0 puts the piece's left edge at the track's left end ("Your left",
    /// the low label or min) and 1 its right edge at the right end.
    /// </summary>
    public readonly struct ActivityTrack
    {
        public ActivityTrack(Vector3 left, Vector3 right, Vector3 normal, float pieceWidth)
        {
            Left = left;
            Right = right;
            Normal = normal.LengthSquared() > 1e-12f ? Vector3.Normalize(normal) : Vector3.Zero;
            PieceWidth = pieceWidth;
        }

        public Vector3 Left { get; }
        public Vector3 Right { get; }

        /// <summary>The sheet's normal; its sign does not matter.</summary>
        public Vector3 Normal { get; }
        public float PieceWidth { get; }
        public float Length => Vector3.Distance(Left, Right);

        /// <summary>How far a piece's center travels from 0 to 1.</summary>
        public float Travel => Length - PieceWidth;
        public bool Valid => Normal != Vector3.Zero && PieceWidth > 0f && Travel > 1e-3f;

        /// <summary>Where a ray meets the sheet plane, as meters along the track from its left end; unclamped.</summary>
        public bool Along(Vector3 origin, Vector3 direction, out float along)
        {
            along = 0f;
            if (!Valid || direction.LengthSquared() < 1e-12f) return false;
            var facing = Vector3.Dot(direction, Normal);
            if (MathF.Abs(facing) < 1e-4f) return false;
            var distance = Vector3.Dot(Left - origin, Normal) / facing;
            if (distance <= 0f) return false;
            var hit = origin + direction * distance;
            along = Vector3.Dot(hit - Left, Vector3.Normalize(Right - Left));
            return true;
        }

        /// <summary>The position that puts the piece's center at a point along the track, clamped to the lane.</summary>
        public double PositionAt(float along) => Math.Clamp((along - PieceWidth / 2f) / (double)Travel, 0, 1);

        /// <summary>Meters along the track of a piece's center at a position.</summary>
        public float CenterAt(double position) => PieceWidth / 2f + (float)Math.Clamp(position, 0, 1) * Travel;
    }

    /// <summary>A piece position to record: every other piece keeps its recorded position.</summary>
    public readonly struct ActivityPieceChange
    {
        public ActivityPieceChange(string key, double position)
        {
            Key = key;
            Position = position;
        }

        public string Key { get; }
        public double Position { get; }
    }

    public enum ActivityPieceResult
    {
        None,

        /// <summary>A tap selected the piece for the tap-then-tap fallback and nudges.</summary>
        Selected,
        Deselected,

        /// <summary>A position to record now; nothing is recorded until the service accepts it.</summary>
        Change,

        /// <summary>The hand ray or tracking was lost mid-move. The piece returns to where it started.</summary>
        Cancelled,
    }

    /// <summary>
    /// One pinch on a piece of an arrange board. A pinch that begins on a piece is a piece gesture: it never starts the
    /// microphone, and holding means nothing. Moving it more than <see cref="TapMeters"/> along the
    /// track with the hand ray drags it; otherwise it is a tap that selects it. The drag shows a
    /// preview and saves nothing until release, which offers the position from
    /// <see cref="ReleaseLookbackSeconds"/> earlier, cancelling the shift a pinch release causes.
    /// </summary>
    public sealed class ActivityPieceGesture
    {
        /// <summary>A pinch that moves less than this along the track is a tap.</summary>
        public const float TapMeters = 0.008f;

        public const float SmoothingSeconds = 0.06f;
        public const float ReleaseLookbackSeconds = 0.08f;

        /// <summary>The width, in steps, of the dead band around each midpoint between number values.</summary>
        public const double SnapHysteresisSteps = 0.35;

        private readonly List<(float Time, double Position)> history = new List<(float, double)>();
        private ActivityTrack track;
        private int? steps;
        private bool handRay;
        private float startAlong, lastTime;
        private double startPosition, smoothed, preview;
        private int snapped;

        /// <summary>The piece the current pinch began on.</summary>
        public string? Held { get; private set; }

        /// <summary>The held piece is being dragged and shows <see cref="Preview"/>.</summary>
        public bool Dragging { get; private set; }

        /// <summary>The tap-selected piece, kept until another tap, a drag or <see cref="Deselect"/>.</summary>
        public string? Selected { get; private set; }

        /// <summary>The held piece's preview while dragging. Presentation only, never the recorded value.</summary>
        public double? Preview => Dragging ? preview : (double?)null;

        /// <summary>A change offered for recording and not yet settled by the service's answer.</summary>
        public ActivityPieceChange? Pending { get; private set; }

        /// <summary>Where to draw a piece: its preview, its pending change, its recorded position, or lane center when not placed.</summary>
        public double Displayed(string key, double? recorded) =>
            Dragging && Held == key ? preview
            : Pending.HasValue && Pending.Value.Key == key ? Pending.Value.Position
            : recorded ?? 0.5;

        /// <summary>
        /// A pinch began on a piece. Refused while a change is pending, since changes are recorded one
        /// at a time against the current revision. <paramref name="steps"/> is the number axis's step
        /// count, or null for other axes. <paramref name="along"/> is the hand ray's track point, or
        /// null without a hand ray, when only a tap is possible.
        /// </summary>
        public bool Begin(string key, double? recorded, ActivityTrack track, int? steps, float? along, float now)
        {
            if (string.IsNullOrEmpty(key) || Held != null || Pending.HasValue || !track.Valid || (steps.HasValue && steps < 1)) return false;
            Held = key;
            Dragging = false;
            this.track = track;
            this.steps = steps;
            handRay = along.HasValue;
            startAlong = along ?? 0f;
            startPosition = recorded ?? 0.5;
            smoothed = startPosition;
            snapped = steps.HasValue ? (int)ActivityDerivation.RoundHalfUp(startPosition * steps.Value) : 0;
            preview = Snap(startPosition);
            lastTime = now;
            history.Clear();
            return true;
        }

        /// <summary>Each frame while the pinch is held, with the hand ray's track point or null when the ray is off.</summary>
        public ActivityPieceResult Move(float? along, float now)
        {
            if (Held == null) return ActivityPieceResult.None;
            if (!along.HasValue)
            {
                if (Dragging) { Release(); return ActivityPieceResult.Cancelled; }
                handRay = false;
                return ActivityPieceResult.None;
            }
            if (!handRay) return ActivityPieceResult.None;
            var moved = along.Value - startAlong;
            if (!Dragging && MathF.Abs(moved) <= TapMeters) { lastTime = now; return ActivityPieceResult.None; }
            if (!Dragging) { Dragging = true; Selected = null; }
            // Smooth before clamping, so a ray past either end reaches exactly 0 or 1 at once.
            var raw = startPosition + moved / (double)track.Travel;
            var elapsed = Math.Max(0f, now - lastTime);
            smoothed += (raw - smoothed) * (1 - Math.Exp(-elapsed / SmoothingSeconds));
            lastTime = now;
            preview = Snap(Math.Clamp(smoothed, 0, 1));
            history.Add((now, preview));
            while (history.Count > 2 && history[1].Time <= now - 4 * ReleaseLookbackSeconds) history.RemoveAt(0);
            return ActivityPieceResult.None;
        }

        /// <summary>
        /// The pinch ended. A drag offers its position from <see cref="ReleaseLookbackSeconds"/> earlier
        /// as <see cref="Pending"/> unless that equals the recorded position; a tap toggles selection.
        /// </summary>
        public ActivityPieceResult End(double? recorded, float now, out ActivityPieceChange change)
        {
            change = default;
            if (Held == null) return ActivityPieceResult.None;
            var key = Held;
            if (!Dragging)
            {
                Release();
                Selected = Selected == key ? null : key;
                return Selected == null ? ActivityPieceResult.Deselected : ActivityPieceResult.Selected;
            }
            // Samples start when the drag does; a drag shorter than the lookback keeps its first sample.
            var position = history[0].Position;
            foreach (var sample in history) if (sample.Time <= now - ReleaseLookbackSeconds) position = sample.Position;
            Release();
            if (recorded.HasValue && Math.Abs(recorded.Value - position) < 1e-9) return ActivityPieceResult.None;
            change = new ActivityPieceChange(key, position);
            Pending = change;
            return ActivityPieceResult.Change;
        }

        /// <summary>Tracking was lost or the pinch was taken by the system: nothing changes.</summary>
        public void Cancel() => Release();

        /// <summary>
        /// The tap-then-tap fallback: with a piece selected, a tap on its own lane offers the position
        /// that centers it there, snapped on a number axis.
        /// </summary>
        public bool Place(string lane, ActivityTrack track, int? steps, float along, out ActivityPieceChange change)
        {
            change = default;
            if (Held != null || Pending.HasValue || Selected == null || lane != Selected || !track.Valid || (steps.HasValue && steps < 1)) return false;
            var position = steps.HasValue
                ? Round(ActivityDerivation.RoundHalfUp(track.PositionAt(along) * steps.Value) / steps.Value)
                : Round(track.PositionAt(along));
            change = new ActivityPieceChange(lane, position);
            Pending = change;
            return true;
        }

        /// <summary>Whether a placed number piece can move one step in a direction (-1 or 1).</summary>
        public static bool CanNudge(double? recorded, int steps, int direction)
        {
            if (!recorded.HasValue || steps < 1 || (direction != 1 && direction != -1)) return false;
            var next = ActivityDerivation.RoundHalfUp(recorded.Value * steps) + direction;
            return next >= 0 && next <= steps;
        }

        /// <summary>Move a placed number piece one step; disabled until placed and at the limits.</summary>
        public bool Nudge(string key, double? recorded, int steps, int direction, out ActivityPieceChange change)
        {
            change = default;
            if (Held != null || Pending.HasValue || string.IsNullOrEmpty(key) || !CanNudge(recorded, steps, direction)) return false;
            var next = ActivityDerivation.RoundHalfUp(recorded!.Value * steps) + direction;
            change = new ActivityPieceChange(key, Round(next / steps));
            Pending = change;
            return true;
        }

        /// <summary>The service answered the pending change, accepting or refusing it; draw the recorded view again.</summary>
        public void Settle() => Pending = null;

        public void Deselect() => Selected = null;

        /// <summary>Forget everything, for a new view of another activity or a focus loss.</summary>
        public void Reset()
        {
            Release();
            Pending = null;
            Selected = null;
        }

        private void Release()
        {
            Held = null;
            Dragging = false;
            history.Clear();
        }

        /// <summary>
        /// Number boards keep a snapped step until the raw position passes the midpoint to the next by
        /// half the dead band; other boards keep four decimals, well inside the 0.10 separation.
        /// </summary>
        private double Snap(double position)
        {
            if (!steps.HasValue) return Round(position);
            var index = position * steps.Value;
            var nearest = (int)ActivityDerivation.RoundHalfUp(index);
            if (nearest != snapped && Math.Abs(index - snapped) > 0.5 + SnapHysteresisSteps / 2) snapped = nearest;
            return Round(snapped / (double)steps.Value);
        }

        private static double Round(double position) => Math.Round(Math.Clamp(position, 0, 1), 4, MidpointRounding.AwayFromZero);
    }
}
