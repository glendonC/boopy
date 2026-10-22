#nullable enable
using UnityEngine;

namespace Boopy.Quest
{
    public enum ConsoleAction { None, Save, Confirm, PreviousItem, NextItem, ToggleDetails, PreviousText, NextText, Size, Options, Sound, Cancel, Review, ToggleIncluded, Motion, PrepareSave, Back, Handoff, Speech, EvidenceSource, CheckCapture, DismissCapture, UseCurrentView, UseSpokenOnly, Actions, Settings, FollowUpOne, FollowUpTwo, ChoiceOne, ChoiceTwo, ChoiceThree, SendChoice, PauseScene, Talk, FinishTalk, AnswerTask }

    /// <summary>A labeled action. The person acts by choosing it. The control does not send anything.</summary>
    public sealed class SpatialAction : MonoBehaviour
    {
        private string words = "";
        public ConsoleAction Action { get; private set; }
        public string AccessibleLabel => words;

        public static SpatialAction Create(Transform parent, ConsoleAction action, string label, float width)
        {
            var go = new GameObject("Action " + action);
            go.transform.SetParent(parent, false);
            go.transform.localScale = new Vector3(Mathf.Max(width, 0.02f), 0.06f, 1f);
            var control = go.AddComponent<SpatialAction>();
            control.Action = action;
            control.Label(label);
            return control;
        }

        public void Label(string label) => words = label ?? "";
    }
}
