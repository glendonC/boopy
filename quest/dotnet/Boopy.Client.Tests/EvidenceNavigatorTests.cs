using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class EvidenceNavigatorTests
    {
        private static Item Evidence(string id, string kind = "object", string origin = "model",
            string status = "proposed") => new Item { Id = id, Kind = kind, Origin = origin, Status = status };

        [Test]
        public void ItemAndTextNavigationAreIndependentAndDoNotWrap()
        {
            var navigator = new EvidenceNavigator();
            navigator.SetItems(new[] { Evidence("intent", "goal"), Evidence("a"), Evidence("b") });
            Assert.That(navigator.ItemCount, Is.EqualTo(2));
            Assert.That(navigator.Selected!.Id, Is.EqualTo("a"));
            Assert.That(navigator.DetailsOpen, Is.False);
            Assert.That(navigator.HasPreviousItem, Is.False);
            Assert.That(navigator.MoveItem(-1), Is.False);
            navigator.SetPages(new[] { "first", "second", "third" });
            Assert.That(navigator.CurrentPage, Is.Null, "details stay collapsed until requested");
            Assert.That(navigator.MovePage(1), Is.False);
            navigator.SetDetailsOpen(true);
            Assert.That(navigator.MovePage(1), Is.True);
            Assert.That(navigator.CurrentPage, Is.EqualTo("second"));
            Assert.That(navigator.Selected.Id, Is.EqualTo("a"));
            navigator.MovePage(1);
            Assert.That(navigator.HasNextPage, Is.False);
            Assert.That(navigator.MovePage(1), Is.False);
            Assert.That(navigator.CurrentPage, Is.EqualTo("third"));
            Assert.That(navigator.MoveItem(1), Is.True);
            Assert.That(navigator.Selected.Id, Is.EqualTo("b"));
            Assert.That(navigator.DetailsOpen, Is.False);
            Assert.That(navigator.PageCount, Is.Zero);
            Assert.That(navigator.HasNextItem, Is.False);
            Assert.That(navigator.MoveItem(1), Is.False);
        }

        [Test]
        public void RepeatedSameItemInspectionAndRefreshPreserveReaderPlace()
        {
            var navigator = new EvidenceNavigator();
            navigator.SetItems(new[] { Evidence("a"), Evidence("b") });
            navigator.SetPages(new[] { "one", "two", "three" });
            navigator.SetDetailsOpen(true);
            navigator.MovePage(1);
            Assert.That(navigator.Select("a"), Is.False);
            navigator.SetItems(new[] { Evidence("b"), Evidence("a", status: "confirmed") });
            navigator.SetPages(new[] { "one refreshed", "two refreshed", "three refreshed" });
            Assert.That(navigator.Selected!.Id, Is.EqualTo("a"));
            Assert.That(navigator.ItemIndex, Is.EqualTo(1));
            Assert.That(navigator.DetailsOpen, Is.True);
            Assert.That(navigator.CurrentPage, Is.EqualTo("two refreshed"));
            Assert.That(navigator.CanConfirmSelected, Is.False);
        }

        [Test]
        public void ClosingReaderKeepsItsPageButSwitchingItemsResetsIt()
        {
            var navigator = new EvidenceNavigator();
            navigator.SetItems(new[] { Evidence("a"), Evidence("b") });
            navigator.SetPages(new[] { "first", "second" });
            navigator.SetDetailsOpen(true);
            navigator.MovePage(1);
            navigator.SetDetailsOpen(false);
            Assert.That(navigator.CurrentPage, Is.Null);
            navigator.SetDetailsOpen(true);
            Assert.That(navigator.CurrentPage, Is.EqualTo("second"));
            navigator.Select("b");
            navigator.SetPages(new[] { "other" });
            navigator.SetDetailsOpen(true);
            navigator.Select("a");
            navigator.SetPages(new[] { "first", "second" });
            Assert.That(navigator.DetailsOpen, Is.False);
            navigator.SetDetailsOpen(true);
            Assert.That(navigator.CurrentPage, Is.EqualTo("first"));
        }

        [Test]
        public void KeepsEveryMeasuredUnicodePageExactlyWithoutMutatingSource()
        {
            var navigator = new EvidenceNavigator();
            navigator.SetItems(new[] { Evidence("ocr", "text") });
            var pages = new[] { "  한글\n한글 👩🏽‍🚀\n", "\r\n사막: 고향 — \u2066정확한 텍스트\u2069  " };
            var expected = string.Concat(pages);
            navigator.SetPages(pages);
            pages[0] = "renderer cache replaced";
            navigator.SetDetailsOpen(true);
            var observed = navigator.CurrentPage;
            navigator.MovePage(1);
            observed += navigator.CurrentPage;
            Assert.That(observed, Is.EqualTo(expected));
        }

        [Test]
        public void RemovalAndEmptyRefreshCannotLeaveAStaleSelectionOrPage()
        {
            var navigator = new EvidenceNavigator();
            navigator.SetItems(new[] { Evidence("a"), Evidence("b") }, "b");
            navigator.SetPages(new[] { "old detail" });
            navigator.SetDetailsOpen(true);
            navigator.SetItems(new[] { Evidence("a") });
            Assert.That(navigator.Selected!.Id, Is.EqualTo("a"));
            Assert.That(navigator.DetailsOpen, Is.False);
            Assert.That(navigator.CurrentPage, Is.Null);
            Assert.That(navigator.Select("removed"), Is.False);
            navigator.SetItems(new Item[0]);
            navigator.SetPages(new[] { "orphan" });
            navigator.SetDetailsOpen(true);
            Assert.That(navigator.Selected, Is.Null);
            Assert.That(navigator.ItemIndex, Is.EqualTo(-1));
            Assert.That(navigator.PageCount, Is.Zero);
            Assert.That(navigator.HasNextItem || navigator.HasPreviousItem
                || navigator.HasNextPage || navigator.HasPreviousPage, Is.False);
        }

        [Test]
        public void RepaginationClampsReaderPageAndExplicitPreferredSelectionResetsIt()
        {
            var navigator = new EvidenceNavigator();
            var items = new[] { Evidence("a"), Evidence("b") };
            navigator.SetItems(items);
            navigator.SetPages(new[] { "one", "two", "three" });
            navigator.SetDetailsOpen(true);
            navigator.MovePage(int.MaxValue);
            navigator.SetPages(new[] { "shorter" });
            Assert.That(navigator.PageIndex, Is.Zero);
            Assert.That(navigator.CurrentPage, Is.EqualTo("shorter"));
            navigator.SetItems(items, "b");
            Assert.That(navigator.Selected!.Id, Is.EqualTo("b"));
            Assert.That(navigator.DetailsOpen, Is.False);
            Assert.That(navigator.PageCount, Is.Zero);
        }

        [TestCase("object", "model", "proposed", true)]
        [TestCase("text", "model", "proposed", true)]
        [TestCase("question", "model", "proposed", false)]
        [TestCase("object", "person", "proposed", false)]
        [TestCase("object", "person", "confirmed", false)]
        [TestCase("object", "model", "confirmed", false)]
        [TestCase("object", "model", "rejected", false)]
        public void ExplicitConfirmOnlyAppliesToAnUnconfirmedModelClaim(string kind,
            string origin, string status, bool allowed)
        {
            var navigator = new EvidenceNavigator();
            navigator.SetItems(new[] { Evidence("a", kind, origin, status) });
            Assert.That(navigator.CanConfirmSelected, Is.EqualTo(allowed));
        }
    }
}
