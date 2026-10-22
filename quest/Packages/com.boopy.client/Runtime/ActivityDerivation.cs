#nullable enable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace Boopy.Client
{
    /// <summary>
    /// Position readings for a drag preview (docs/activity-contract.md). The service recomputes
    /// them. The headset shows its own result only while a piece is held, never as the saved value.
    /// </summary>
    public static class ActivityDerivation
    {
        /// <summary>Pieces closer than this, after rounding the gap to 9 decimals, are too close to tell.</summary>
        public const double Separation = 0.10;

        /// <summary>The recorded positions with one piece changed: every token key, null for not placed.</summary>
        public static Dictionary<string, double?> Positions(ActivityComponent arrange, string key, double? position)
        {
            if (arrange?.Tokens == null || arrange.Tokens.All(token => token.Key != key))
                throw new ArgumentException("The piece is not part of this arrangement.");
            return arrange.Tokens.ToDictionary(token => token.Key, token => token.Key == key ? position : token.Position);
        }

        public static ActivityDerived Derive(ActivityComponent arrange, IReadOnlyDictionary<string, double?> positions)
        {
            if (arrange?.Axis == null || arrange.Tokens == null) throw new ArgumentException("A preview needs an arrangement.");
            double? At(string key) => positions.TryGetValue(key, out var value) ? value : null;
            var placed = arrange.Tokens.Where(token => At(token.Key).HasValue)
                .OrderBy(token => At(token.Key)!.Value).ToList();
            var derived = new ActivityDerived
            {
                Order = placed.Select(token => token.Key).ToList(),
                Ties = placed.Zip(placed.Skip(1), (left, right) => Apart(At(left.Key)!.Value, At(right.Key)!.Value)).Any(apart => !apart),
            };
            if (arrange.Axis.Kind == "viewer-left-right" && arrange.Tokens.Count == 2)
            {
                var subject = arrange.Target?.Subject ?? arrange.Tokens[0].Key;
                var other = arrange.Target?.Object ?? arrange.Tokens[1].Key;
                derived.Relation = Relation(At(subject), At(other));
                derived.MatchesTarget = arrange.Target == null ? (bool?)null : derived.Relation == arrange.Target.Relation;
            }
            if (arrange.Axis.Kind == "number")
                derived.Values = arrange.Tokens.ToDictionary(token => token.Key,
                    token => At(token.Key).HasValue ? Value(arrange.Axis, At(token.Key)!.Value) : (double?)null);
            return derived;
        }

        /// <summary>null if either is not placed, unclear when too close, else where the subject is from the person's view.</summary>
        public static string? Relation(double? subject, double? other)
        {
            if (!subject.HasValue || !other.HasValue) return null;
            if (!Apart(subject.Value, other.Value)) return "unclear";
            return subject.Value < other.Value ? "left-of" : "right-of";
        }

        /// <summary>Exactly 0.10 counts as apart (section 10a).</summary>
        public static bool Apart(double one, double other) => RoundHalfUp(Math.Abs(one - other) * 1e9) / 1e9 >= Separation;

        /// <summary>The largest number axis end the contract allows, in either direction.</summary>
        public const double Bound = 1e9;

        /// <summary>A contract number in integer micro-units, as the service computes it: <c>Math.round(v * 1e6)</c>.</summary>
        public static long Micro(double value)
        {
            if (double.IsNaN(value) || Math.Abs(value) > 2 * Bound) throw new ArgumentOutOfRangeException(nameof(value), "Number axis values and steps stay within the contract's bounds.");
            return (long)RoundHalfUp(value * 1e6);
        }

        /// <summary>
        /// The snapped value at a position in exact integer micro-units (contract section 10a):
        /// <c>minU + Math.round(x * (maxU - minU) / stepU) * stepU</c>, the service's own method.
        /// </summary>
        public static long ValueMicro(ActivityAxis axis, double position)
        {
            if (axis?.Kind != "number" || !axis.Min.HasValue || !axis.Max.HasValue || !axis.Step.HasValue || !axis.Steps.HasValue)
                throw new ArgumentException("Only a valid number axis has values.");
            var min = Micro(axis.Min.Value);
            var span = Micro(axis.Max.Value) - min;
            var step = Micro(axis.Step.Value);
            return min + (long)RoundHalfUp(position * span / step) * step;
        }

        /// <summary>The snapped value as the JSON number the service records.</summary>
        public static double Value(ActivityAxis axis, double position) => ValueMicro(axis, position) / 1e6;

        /// <summary>A contract number as the contract prints it: the exact decimal of its micro-units, no exponent, no trailing zeros.</summary>
        public static string Format(double value) => FormatMicro(Micro(value));

        public static string FormatMicro(long micro)
        {
            if (micro == 0) return "0";
            var magnitude = Math.Abs(micro);
            var text = (magnitude / 1_000_000).ToString(CultureInfo.InvariantCulture);
            var fraction = magnitude % 1_000_000;
            if (fraction > 0) text += "." + fraction.ToString("D6", CultureInfo.InvariantCulture).TrimEnd('0');
            return micro < 0 ? "-" + text : text;
        }

        /// <summary>Whole steps from min to max in micro-units, or null when the axis breaks the contract's number rules.</summary>
        public static int? Steps(double min, double max, double step)
        {
            if (double.IsNaN(min) || double.IsNaN(max) || double.IsNaN(step) || Math.Abs(min) > Bound || Math.Abs(max) > Bound || !(step > 0) || step > 2 * Bound) return null;
            var stepU = Micro(step);
            var span = Micro(max) - Micro(min);
            if (stepU < 1 || span <= 0 || span % stepU != 0 || span / stepU > 1000) return null;
            return (int)(span / stepU);
        }

        /// <summary>JavaScript's Math.round, which the service uses: halves round up, unlike Math.Round.</summary>
        public static double RoundHalfUp(double value) => Math.Floor(value + 0.5);
    }
}
