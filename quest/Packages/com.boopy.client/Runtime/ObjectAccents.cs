#nullable enable
using System;
using System.Collections.Generic;
using System.Numerics;

namespace Boopy.Client
{
    /// <summary>Presentation identity within one session, independent of confidence and verification.</summary>
    public sealed class ObjectAccents
    {
        private readonly Dictionary<string, int> active = new Dictionary<string, int>();
        private static readonly Vector3[] Palette = {
            new Vector3(.94f,.91f,.82f), // Ivory
            new Vector3(.94f,.72f,.38f), // Amber
            new Vector3(.78f,.68f,.93f), // Lilac
            new Vector3(.48f,.82f,.88f), // Aqua
        };

        public static Vector3 Color(int slot) => Palette[Math.Clamp(slot, 0, Palette.Length - 1)];

        /// <summary>Retain active assignments; order changes never recolor an existing item.</summary>
        public void Synchronize(IReadOnlyList<string> orderedIds)
        {
            var desired = new List<string>();
            foreach (var id in orderedIds)
                if (!string.IsNullOrEmpty(id) && !desired.Contains(id) && desired.Count < Palette.Length) desired.Add(id);
            var gone = new List<string>();
            foreach (var id in active.Keys) if (!desired.Contains(id)) gone.Add(id);
            foreach (var id in gone) active.Remove(id);
            foreach (var id in desired)
            {
                if (active.ContainsKey(id)) continue;
                for (var slot = 0; slot < Palette.Length; slot++)
                    if (!active.ContainsValue(slot)) { active.Add(id, slot); break; }
            }
        }

        public bool TryGet(string id, out int slot) => active.TryGetValue(id, out slot);
        public void Clear() => active.Clear();

        public static float OutlineOpacity(bool focused, bool anyFocused, bool primary) =>
            focused ? .94f : anyFocused ? .26f : primary ? .76f : .48f;
        public static float FillMultiplier(bool focused, bool anyFocused) => focused ? 1.35f : anyFocused ? .45f : 1f;
    }
}
