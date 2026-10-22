#nullable enable
namespace Boopy.Client
{
    /// <summary>Display state derived only from actual microphone and request activity.</summary>
    public enum InteractionActivity { Ready, Listening, Thinking }

    public static class ActivityFeedback
    {
        /// <summary>Recording takes priority if a request is still being cleared.</summary>
        public static InteractionActivity From(bool listening, bool thinking) =>
            listening ? InteractionActivity.Listening : thinking ? InteractionActivity.Thinking : InteractionActivity.Ready;
    }
}
