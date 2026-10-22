#nullable enable
using UnityEngine;

namespace Boopy.Quest
{
    /// <summary>
    /// The console under the line. A task shows one action there so the person can act.
    /// The action is recorded locally. It is not a delivery.
    /// </summary>
    public sealed class ContextConsole : MonoBehaviour
    {
        public bool TaskShown { get; private set; }
        public string? TaskActionLabel { get; private set; }

        public void ShowTask(string? actionLabel)
        {
            TaskShown = true;
            TaskActionLabel = actionLabel;
            if (string.IsNullOrEmpty(actionLabel)) return;
            SpatialAction.Create(transform, ConsoleAction.AnswerTask, actionLabel, 0.24f);
        }

        public void EndTask()
        {
            if (!TaskShown) return;
            TaskShown = false;
            TaskActionLabel = null;
        }
    }
}
