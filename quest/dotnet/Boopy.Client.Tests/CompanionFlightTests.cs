using System.Numerics;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class CompanionFlightTests
    {
        [Test]
        public void ListeningAndProcessingPerchesProduceSixtyMillimetresOfPurposefulTravel()
        {
            Assert.That(CompanionFlight.HomeFor("listening").Y - CompanionFlight.HomeFor("processing").Y,
                Is.EqualTo(.060f).Within(.00001f));
            var flight = new CompanionFlight();
            flight.MoveTo(CompanionFlight.HomeFor("listening"));
            for (var i = 0; i < 60; i++) flight.Tick(1f / 60f, false, false, true);
            Assert.That(Vector3.Distance(flight.Position, CompanionFlight.HomeFor("listening")), Is.LessThan(.00001f));
        }

        [Test]
        public void UnboundedInputAndRepeatedInterruptionsStayWithinReservedFlightZone()
        {
            var flight = new CompanionFlight();
            for (var tick = 0; tick < 3000; tick++)
            {
                if (tick % 25 == 0) flight.MoveTo(new Vector3(tick % 2 == 0 ? 100 : -100,
                    tick % 3 == 0 ? 100 : -100, tick % 5 == 0 ? 100 : -100));
                var position = flight.Tick(1f / 60f, false, false, true);
                Assert.That(position.X, Is.InRange(-.010f, .010f));
                Assert.That(position.Y, Is.InRange(-.031f, .043f));
                Assert.That(position.Z, Is.InRange(-.018f, .002f));
                Assert.That(flight.Pitch, Is.InRange(-8f, 8f));
                Assert.That(flight.Bank, Is.InRange(-9f, 9f));
            }
        }

        [Test]
        public void FreezeHoldsFlightAndResumesWithoutConsumingSuspendedTime()
        {
            var flight = new CompanionFlight();
            flight.MoveTo(CompanionFlight.HomeFor("listening"));
            flight.Tick(.1f, false, false, true);
            var before = flight.Position;
            for (var i = 0; i < 100; i++) Assert.That(flight.Tick(.1f, true, false, true), Is.EqualTo(before));
            var resumed = flight.Tick(.016f, false, false, true);
            Assert.That(Vector3.Distance(before, resumed), Is.LessThan(.005f));
        }

        [TestCase(true, true)]
        [TestCase(false, false)]
        public void ReducedMotionOrInvisibilityCancelsFlightWithoutReplayingIt(bool reduced, bool visible)
        {
            var flight = new CompanionFlight();
            flight.MoveTo(CompanionFlight.HomeFor("listening"));
            flight.Tick(.1f, false, false, true);
            Assert.That(flight.Tick(.1f, false, reduced, visible), Is.EqualTo(Vector3.Zero));
            Assert.That(flight.Tick(.1f, false, false, true), Is.EqualTo(Vector3.Zero));
        }

        [Test]
        public void SameTargetAndTrackingJitterDoNotRestartAnticipation()
        {
            var flight = new CompanionFlight();
            var target = CompanionFlight.HomeFor("listening");
            flight.MoveTo(target);
            for (var i = 0; i < 120; i++)
            {
                flight.MoveTo(target + new Vector3(i % 2 == 0 ? .0005f : -.0005f, 0f, 0f));
                flight.Tick(1f / 60f, false, false, true);
            }
            Assert.That(Vector3.Distance(flight.Position, target), Is.LessThan(.00001f));
        }

        [Test]
        public void InvalidDirectionAndDeltaNeverProduceNonfiniteFlight()
        {
            var flight = new CompanionFlight();
            flight.MoveTo(new Vector3(float.NaN, float.PositiveInfinity, float.NegativeInfinity));
            Assert.That(flight.Tick(float.NaN, false, false, true), Is.EqualTo(Vector3.Zero));
        }
    }
}
