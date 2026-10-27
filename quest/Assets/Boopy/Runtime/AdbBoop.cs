#nullable enable
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>
    /// The recording driven from adb, so the whole turn can be run on the device with the headset unworn, through the
    /// activity's intent (a launch, or a new intent to the running app, which Unity's activity sets as its intent):
    /// <see cref="Place"/> (true: place the read recording and play it); a boop, <see cref="Id"/> with <see cref="X"/> and
    /// <see cref="Y"/> (the point on the recording, 0 to 1 from its top-left) and optionally <see cref="Seconds"/> (the
    /// clip time to stop on); and a hold, <see cref="HoldMs"/> (held as a pinch for that long, at the boop's point when
    /// given), optionally with <see cref="HoldWav"/>, a bare file name in the app's own data folder sent in place of the
    /// microphone. Each intent is done once. Only a development build reads them, and only from the shell.
    /// </summary>
    public static class AdbBoop
    {
        public const string Place = "boopy.place", Id = "boopy.boop.id", X = "boopy.boop.x", Y = "boopy.boop.y", Seconds = "boopy.boop.t",
            HoldMs = "boopy.hold.ms", HoldWav = "boopy.hold.wav";

        /// <summary>What an intent asked for; <see cref="Identity"/> tells one intent from the next.</summary>
        public readonly struct Request
        {
            public Request(int identity, bool place, string? id, Vector2 at, float? seconds, int? holdMs, string? holdWav, string? from)
            {
                Identity = identity; Placing = place; BoopId = id; At = at; Time = seconds; Hold = holdMs; Wav = holdWav; From = from;
            }
            public int Identity { get; }
            public bool Placing { get; }
            public string? BoopId { get; }
            /// <summary>The point, or (-1, -1) when the intent names none.</summary>
            public Vector2 At { get; }
            public float? Time { get; }
            public int? Hold { get; }
            public string? Wav { get; }
            /// <summary>The launch's referrer host, or null when it arrived with none.</summary>
            public string? From { get; }
        }

        /// <summary>True with the request when the intent carries one Boopy may take; <paramref name="refused"/> says why not.</summary>
        public static bool TryRead(out Request request, out string? refused)
        {
            request = default; refused = null;
#if UNITY_ANDROID && !UNITY_EDITOR
            try
            {
                using var player = new AndroidJavaClass("com.unity3d.player.UnityPlayer");
                using var activity = player.GetStatic<AndroidJavaObject>("currentActivity");
                using var intent = activity.Call<AndroidJavaObject>("getIntent");
                if (intent == null) return false;
                bool Has(string name) => intent.Call<bool>("hasExtra", name);
                if (!Has(Id) && !Has(Place) && !Has(HoldMs)) return false;
                if (!Debug.isDebugBuild) { refused = "not a development build"; return false; }
                using var referrer = activity.Call<AndroidJavaObject>("getReferrer");
                var from = referrer?.Call<string>("getHost");
                if (from != null && from != "com.android.shell") { refused = "not launched from the shell"; return false; }
                request = new Request(intent.Call<int>("hashCode"), intent.Call<bool>("getBooleanExtra", Place, false),
                    Has(Id) ? intent.Call<string>("getStringExtra", Id) : null,
                    new Vector2(intent.Call<float>("getFloatExtra", X, -1f), intent.Call<float>("getFloatExtra", Y, -1f)),
                    Has(Seconds) ? intent.Call<float>("getFloatExtra", Seconds, -1f) : (float?)null,
                    Has(HoldMs) ? intent.Call<int>("getIntExtra", HoldMs, 0) : (int?)null,
                    Has(HoldWav) ? intent.Call<string>("getStringExtra", HoldWav) : null, from);
                return true;
            }
            catch (System.Exception failure) { refused = "unreadable: " + failure.GetType().Name; return false; }
#else
            return false;
#endif
        }
    }
}
