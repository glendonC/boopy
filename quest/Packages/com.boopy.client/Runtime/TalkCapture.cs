#nullable enable
using System;

namespace Boopy.Client
{
    /// <summary>Start speech before blocking frame work, and roll it back when capture fails.</summary>
    public static class TalkCapture
    {
        public static bool Begin(Func<bool> beginRecording, Action capture, Action discardRecording)
        {
            try
            {
                if (!beginRecording()) return false;
                capture();
                return true;
            }
            catch
            {
                discardRecording();
                throw;
            }
        }
    }
}
