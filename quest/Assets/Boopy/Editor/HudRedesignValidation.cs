#nullable enable
using UnityEngine;
namespace Boopy.Quest.Editor
{
    public static class HudRedesignValidation
    {
        public static void ValidateAll()
        {
            VisualPrimitiveValidation.Validate();
            ActionIconValidation.Validate();
            ConnectionValidation.Validate();
            ButtonTalkValidation.Validate();
            ControlBarValidation.ValidateAll();
            CharacterValidation.Validate();
            Debug.Log("Boopy redesign integration validation passed: connection, input, presentation and character.");
        }
    }
}
