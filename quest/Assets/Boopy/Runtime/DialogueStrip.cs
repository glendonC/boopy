#nullable enable
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>
    /// The line beside the session. A task uses this same line: the speaker carries "Not sent"
    /// when nothing was delivered, and the caption is the task's text.
    /// </summary>
    public sealed class DialogueStrip : MonoBehaviour
    {
        public string SpeakerText { get; private set; } = "";
        public string FullText { get; private set; } = "";

        public void ShowTask(string speakerLine, string words)
        {
            SpeakerText = speakerLine ?? "";
            FullText = words ?? "";
            gameObject.SetActive(true);
        }

        public void Hide()
        {
            gameObject.SetActive(false);
        }
    }
}
