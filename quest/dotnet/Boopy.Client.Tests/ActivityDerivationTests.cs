#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using Boopy.Client;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class ActivityDerivationTests
    {
        private static ActivityComponent Arrange(string json) => ActivityClientTests.View(json).Arrange!;
        private static ActivityAxis Number(double min, double max, double step) =>
            new ActivityAxis { Kind = "number", Min = min, Max = max, Step = step };

        [Test]
        public void ThePreviewReadsBothCanonicalViewsAsTheServiceRecordedThem()
        {
            foreach (var json in new[] { ActivityClientTests.Korean, ActivityClientTests.Morocco })
            {
                var arrange = Arrange(json);
                var positions = arrange.Tokens!.ToDictionary(token => token.Key, token => token.Position);
                var preview = ActivityDerivation.Derive(arrange, positions);
                var recorded = arrange.Derived!;
                Assert.That(preview.Relation, Is.EqualTo(recorded.Relation));
                Assert.That(preview.MatchesTarget, Is.EqualTo(recorded.MatchesTarget));
                Assert.That(preview.Order, Is.EqualTo(recorded.Order));
                Assert.That(preview.Ties, Is.EqualTo(recorded.Ties));
                Assert.That(preview.Values, Is.EqualTo(recorded.Values));
            }
        }

        [TestCase(0.3, 0.2, "right-of")]
        [TestCase(0.7, 0.8, "left-of")]
        [TestCase(0.2, 0.3, "left-of")]
        [TestCase(0.8, 0.7, "right-of")]
        [TestCase(0.25, 0.3, "unclear")]
        [TestCase(0.5, 0.4000001, "unclear")]
        [TestCase(0.0, 0.1, "left-of")]
        [TestCase(0.9, 1.0, "left-of")]
        public void ExactlyTenHundredthsApartCountsAsApartWhateverTheBinaryRounding(double subject, double other, string relation)
        {
            // 0.3 - 0.2 is 0.09999999999999998 in binary; section 10a rounds the gap to 9 decimals first.
            Assert.That(ActivityDerivation.Relation(subject, other), Is.EqualTo(relation));
        }

        [Test]
        public void NothingIsReadBeforeBothPiecesArePlaced()
        {
            Assert.That(ActivityDerivation.Relation(null, 0.4), Is.Null);
            Assert.That(ActivityDerivation.Relation(0.4, null), Is.Null);
            var arrange = Arrange(ActivityClientTests.Korean);
            var preview = ActivityDerivation.Derive(arrange, new Dictionary<string, double?> { ["a"] = 0.1, ["b"] = null });
            Assert.That(preview.Relation, Is.Null);
            Assert.That(preview.MatchesTarget, Is.False, "With a target, a missing relation does not match it.");
            Assert.That(preview.Order, Is.EqualTo(new[] { "a" }));
            Assert.That(preview.Values, Is.Null);
        }

        [Test]
        public void TheTargetIsReadFromItsSubjectAndObjectNotTheKeyOrder()
        {
            var view = JObject.Parse(ActivityClientTests.Korean);
            view["components"]![0]!["target"] = JObject.Parse("{\"subject\":\"b\",\"relation\":\"right-of\",\"object\":\"a\"}");
            var arrange = Arrange(view.ToString());
            var preview = ActivityDerivation.Derive(arrange, new Dictionary<string, double?> { ["a"] = 0.22, ["b"] = 0.71 });
            Assert.That(preview.Relation, Is.EqualTo("right-of"));
            Assert.That(preview.MatchesTarget, Is.True);
            view["components"]![0]!["target"] = null;
            var untargeted = ActivityDerivation.Derive(Arrange(view.ToString()), new Dictionary<string, double?> { ["a"] = 0.71, ["b"] = 0.22 });
            Assert.That(untargeted.Relation, Is.EqualTo("right-of"), "Without a target, a is read against b.");
            Assert.That(untargeted.MatchesTarget, Is.Null);
        }

        [Test]
        public void ScaleOrderSkipsUnplacedPiecesAndFlagsNeighboursTooCloseToTell()
        {
            var view = JObject.Parse(ActivityClientTests.Morocco);
            var component = (JObject)view["components"]![0]!;
            component["axis"] = JObject.Parse("{\"kind\":\"scale\",\"low\":\"Cheaper\",\"high\":\"Pricier\"}");
            component["tokens"] = new JArray(new[] { "scarf", "lamp", "tagine" }.Select((label, index) => new JObject {
                ["key"] = ((char)('a' + index)).ToString(), ["label"] = new JObject { ["text"] = label, ["language"] = "en" },
            }));
            component["derived"] = JObject.Parse("{\"order\":[],\"ties\":false}");
            var arrange = Arrange(view.ToString());
            var close = ActivityDerivation.Derive(arrange, new Dictionary<string, double?> { ["a"] = 0.55, ["b"] = 0.5, ["c"] = null });
            Assert.That(close.Order, Is.EqualTo(new[] { "b", "a" }));
            Assert.That(close.Ties, Is.True);
            Assert.That(close.Relation, Is.Null, "Only a left/right board has a relation.");
            Assert.That(close.Values, Is.Null, "Only a number board has values.");
            var apart = ActivityDerivation.Derive(arrange, new Dictionary<string, double?> { ["a"] = 0.9, ["b"] = 0.1, ["c"] = 0.5 });
            Assert.That(apart.Order, Is.EqualTo(new[] { "b", "c", "a" }));
            Assert.That(apart.Ties, Is.False);
            var level = ActivityDerivation.Derive(arrange, new Dictionary<string, double?> { ["a"] = 0.4, ["b"] = 0.4, ["c"] = 0.4 });
            Assert.That(level.Order, Is.EqualTo(new[] { "a", "b", "c" }), "Equal positions keep key order, as a stable sort does.");
        }

        [TestCase(0, 200, 5, 0.25, 50, "50")]
        [TestCase(0, 200, 5, 0.0, 0, "0")]
        [TestCase(0, 200, 5, 1.0, 200, "200")]
        [TestCase(0, 1, 0.1, 0.3, 0.3, "0.3")]
        [TestCase(0, 4, 1, 0.625, 3, "3")]
        [TestCase(0, 4, 1, 0.375, 2, "2")]
        [TestCase(-10, 10, 0.5, 0.375, -2.5, "-2.5")]
        [TestCase(-10, 10, 0.5, 0.5, 0, "0")]
        [TestCase(0.25, 1.25, 0.25, 0.5, 0.75, "0.75")]
        [TestCase(0, 0.000003, 0.000001, 1.0, 0.000003, "0.000003")]
        public void NumberValuesSnapWithTheServicesRoundingAndPrintWithoutNoise(double min, double max, double step, double position, double value, string printed)
        {
            var axis = Number(min, max, step);
            var snapped = ActivityDerivation.Value(axis, position);
            Assert.That(snapped, Is.EqualTo(value));
            Assert.That(ActivityDerivation.Format(snapped), Is.EqualTo(printed));
        }

        [TestCase(0.0, 99999999L, "999999.99")]
        [TestCase(1.0, 100000006L, "1000000.06")]
        [TestCase(3.0 / 7.0, 100000002L, "1000000.02")]
        public void DecimalPricesSnapExactlyInMicroUnits(double position, long cents, string printed)
        {
            // Contract 10a: 999999.99 to 1000000.06 in 0.01 steps is accepted and computed in integer micro-units.
            var axis = Number(999999.99, 1000000.06, 0.01);
            Assert.That(axis.Steps, Is.EqualTo(7));
            Assert.That(ActivityDerivation.ValueMicro(axis, position), Is.EqualTo(cents * 10_000L));
            Assert.That(ActivityDerivation.Format(ActivityDerivation.Value(axis, position)), Is.EqualTo(printed));
        }

        [TestCase(0L, "0")]
        [TestCase(1L, "0.000001")]
        [TestCase(-500_000L, "-0.5")]
        [TestCase(-1_250_000L, "-1.25")]
        [TestCase(123_400_000L, "123.4")]
        [TestCase(1_000_000_000_000_000L, "1000000000")]
        [TestCase(-999_999_999_999_999L, "-999999999.999999")]
        public void MicroUnitsPrintAsExactDecimalsWithoutExponentOrTrailingZeros(long micro, string printed) =>
            Assert.That(ActivityDerivation.FormatMicro(micro), Is.EqualTo(printed));

        [TestCase(0, 0.3, 0.1, 3)]
        [TestCase(0, 1000, 1, 1000)]
        [TestCase(-1e9, 1e9, 2e6, 1000)]
        [TestCase(-1e9, 1e9, 2e9, 1)]
        [TestCase(0, 0.000003, 0.000001, 3)]
        public void StepsAreCountedExactlyInMicroUnits(double min, double max, double step, int steps) =>
            Assert.That(ActivityDerivation.Steps(min, max, step), Is.EqualTo(steps), "0.3 / 0.1 is 2.9999999999999996 in binary; micro-units count 3.");

        [TestCase(0, 1, 0.3)]
        [TestCase(0, 1001, 1)]
        [TestCase(0, 2e9, 1e7)]
        [TestCase(5, 5, 1)]
        [TestCase(0, 1, 0.0000001)]
        [TestCase(0, 1, -0.5)]
        public void AxesOutsideTheContractsNumberRulesHaveNoSteps(double min, double max, double step) =>
            Assert.That(ActivityDerivation.Steps(min, max, step), Is.Null);

        [Test]
        public void HalfStepsRoundUpLikeJavaScriptNotToEven()
        {
            Assert.That(ActivityDerivation.RoundHalfUp(2.5), Is.EqualTo(3));
            Assert.That(ActivityDerivation.RoundHalfUp(3.5), Is.EqualTo(4));
            Assert.That(ActivityDerivation.RoundHalfUp(2.4999), Is.EqualTo(2));
            Assert.That(Math.Round(2.5), Is.EqualTo(2), "Math.Round alone would disagree with the service.");
        }

        [Test]
        public void PositionsChangeOnePieceAndKeepEveryOtherRecordedPosition()
        {
            var arrange = Arrange(ActivityClientTests.Korean);
            var positions = ActivityDerivation.Positions(arrange, "b", null);
            Assert.That(positions, Is.EqualTo(new Dictionary<string, double?> { ["a"] = 0.22, ["b"] = null }));
            Assert.That(ActivityDerivation.Positions(arrange, "a", 0.5)["b"], Is.EqualTo(0.71));
            Assert.Throws<ArgumentException>(() => ActivityDerivation.Positions(arrange, "c", 0.5));
        }

        [Test]
        public void OnlyANumberAxisHasValues() =>
            Assert.Throws<ArgumentException>(() => ActivityDerivation.Value(new ActivityAxis { Kind = "viewer-left-right" }, 0.5));
    }
}
