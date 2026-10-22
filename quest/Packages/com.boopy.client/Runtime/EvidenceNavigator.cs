#nullable enable
using System;
using System.Collections.Generic;

namespace Boopy.Client
{
    /// <summary>
    /// Independent, bounded evidence-item and detail-page navigation. The renderer supplies
    /// measured page strings; this class never splits, trims or rewrites source evidence.
    /// </summary>
    public sealed class EvidenceNavigator
    {
        private readonly List<Item> items = new List<Item>();
        private readonly List<string> pages = new List<string>();
        private int itemIndex = -1;
        private int pageIndex;

        public Item? Selected => itemIndex >= 0 ? items[itemIndex] : null;
        public int ItemIndex => itemIndex;
        public int ItemCount => items.Count;
        public int PageIndex => pages.Count == 0 ? -1 : pageIndex;
        public int PageCount => pages.Count;
        public bool DetailsOpen { get; private set; }
        public string? CurrentPage => DetailsOpen && pages.Count > 0 ? pages[pageIndex] : null;
        public bool HasPreviousItem => itemIndex > 0;
        public bool HasNextItem => itemIndex >= 0 && itemIndex < items.Count - 1;
        public bool HasPreviousPage => DetailsOpen && pages.Count > 0 && pageIndex > 0;
        public bool HasNextPage => DetailsOpen && pageIndex < pages.Count - 1;
        public bool CanConfirmSelected => Selected is Item item && item.Origin == "model"
            && item.Status == "proposed" && item.Kind != "question";

        /// <summary>
        /// Refreshes evidence in supplied order, excluding the separately displayed intent.
        /// A surviving selected ID keeps its reader state; a different selection resets it.
        /// </summary>
        public void SetItems(IReadOnlyList<Item> supplied, string? preferredId = null)
        {
            var previousId = Selected?.Id;
            var previousIndex = itemIndex;
            items.Clear();
            foreach (var item in supplied)
                if (item.Kind != "goal") items.Add(item);
            var selected = preferredId == null ? -1 : items.FindIndex(item => item.Id == preferredId);
            if (selected < 0 && previousId != null)
                selected = items.FindIndex(item => item.Id == previousId);
            if (selected < 0 && items.Count > 0)
                selected = Math.Clamp(previousIndex, 0, items.Count - 1);
            itemIndex = selected;
            if (Selected?.Id != previousId || Selected == null) ResetReader();
        }

        /// <summary>Repeated hover/inspection of the same ID must not jump the reader back to page one.</summary>
        public bool Select(string id)
        {
            var next = items.FindIndex(item => item.Id == id);
            if (next < 0 || next == itemIndex) return false;
            itemIndex = next;
            ResetReader();
            return true;
        }

        public bool MoveItem(int delta)
        {
            if (itemIndex < 0 || delta == 0) return false;
            var next = (int)Math.Clamp((long)itemIndex + delta, 0, items.Count - 1);
            if (next == itemIndex) return false;
            itemIndex = next;
            ResetReader();
            return true;
        }

        /// <summary>Closing and reopening the current reader keeps its place.</summary>
        public void SetDetailsOpen(bool open) => DetailsOpen = open && Selected != null;

        public void SetPages(IReadOnlyList<string> measuredPages)
        {
            pages.Clear();
            if (Selected != null)
                foreach (var page in measuredPages) pages.Add(page);
            pageIndex = pages.Count == 0 ? 0 : Math.Clamp(pageIndex, 0, pages.Count - 1);
        }

        public bool MovePage(int delta)
        {
            if (!DetailsOpen || pages.Count == 0 || delta == 0) return false;
            var next = (int)Math.Clamp((long)pageIndex + delta, 0, pages.Count - 1);
            if (next == pageIndex) return false;
            pageIndex = next;
            return true;
        }

        private void ResetReader()
        {
            DetailsOpen = false;
            pages.Clear();
            pageIndex = 0;
        }
    }
}
