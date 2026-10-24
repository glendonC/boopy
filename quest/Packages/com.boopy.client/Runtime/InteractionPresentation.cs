#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Boopy.Client
{
    /// <summary>
    /// One task view as the existing scene slots. The target id is the source id. The chip's subject
    /// is the grounded item the annotation names. Continuity stays local-only and delivery stays
    /// not-sent, so every line the headset shows for a task says "Not sent to your AI".
    /// </summary>
    public sealed class InteractionPresentation
    {
        private const int MaxRevision = 1_000_000;
        private const string NotSent = " · Not sent to your AI";
        private static readonly HashSet<string> ComponentTypes = new HashSet<string>
        {
            "subject", "annotation", "dialogue", "choice", "voice_reply", "task_step", "detail", "status", "agent_presence",
        };
        private static readonly HashSet<string> ActionTypes = new HashSet<string> { "choice", "voice_reply", "task_step" };

        public string TargetId { get; private set; } = "";
        public string Chip { get; private set; } = "";
        public string Dialogue { get; private set; } = "";
        public InteractionAction? Action { get; private set; }
        public string? StatusLine { get; private set; }
        public string Utterance { get; private set; } = "";
        public string Continuity { get; private set; } = "";
        public string Delivery { get; private set; } = "";
        public int SourceRevision { get; private set; }
        public string Sha256 { get; private set; } = "";
        public string Intent { get; private set; } = "";
        public string TaskId { get; private set; } = "";
        public string SessionId { get; private set; } = "";
        public int Revision { get; private set; }

        /// <summary>open or cancelled. A cancelled task takes no answer.</summary>
        public string Phase { get; private set; } = "";

        /// <summary>The annotation's evidence ids: the chip's subject. Empty without an annotation.</summary>
        public IReadOnlyList<string> AnnotationEvidenceIds { get; private set; } = Array.Empty<string>();

        /// <summary>The person's newest recorded answer, or null before any.</summary>
        public TaskAttempt? LastAttempt { get; private set; }

        /// <summary>
        /// The strip's speaker line: "Boopy · Not sent to your AI"; over a recorded answer "You · Not sent to your AI",
        /// or "You, as heard · Not sent to your AI" when recognition was uncertain.
        /// </summary>
        public string SpeakerLine { get; private set; } = "";

        /// <summary>The strip's caption: "Wrong item.", the newest answer exactly, or Boopy's dialogue (may be empty).</summary>
        public string Caption { get; private set; } = "";

        /// <summary>
        /// The label of the one control the headset draws: a voice reply's prompt without one trailing
        /// period. Null for a choice or a task step (no person action in protocol v1), a wrong item,
        /// a cancelled task, or once the line shows the person's answer.
        /// </summary>
        public string? AnswerLabel { get; private set; }

        /// <summary>
        /// Whether the headset draws this view on the subject: it has both its chip and Boopy's
        /// line, a recorded answer, or the wrong-item status. A part left out, such as a line too
        /// long for the task, keeps the session's own presentation so nothing it shows vanishes.
        /// A wrong item is shown as one, so the session's chip does not come back on it.
        /// </summary>
        public bool Presentable => (Chip.Length > 0 && Dialogue.Length > 0) || LastAttempt != null || wrongItem;

        private bool wrongItem;

        private InteractionPresentation() { }

        /// <summary>
        /// Read the task view <c>present()</c> already emits. A view the headset cannot show as sent,
        /// including repeated fields or trailing text, is an <see cref="ArgumentException"/>.
        /// </summary>
        public static InteractionPresentation Read(string json)
        {
            var view = Parse(json);
            var continuity = RequiredString(view, "continuity");
            if (continuity != "local-only")
                throw new ArgumentException("Continuity stays local-only.");
            var delivery = RequiredString(view, "delivery");
            if (delivery != "not-sent")
                throw new ArgumentException("Delivery stays not-sent.");
            if (view["source"] is not JObject source)
                throw new ArgumentException("Task source is missing.");
            var sourceId = RequiredString(source, "sourceId");
            if (source["sourceRevision"]?.Type != JTokenType.Integer)
                throw new ArgumentException("Task source revision is missing.");
            var sourceRevision = Whole(source["sourceRevision"], "sourceRevision", 0);
            var sha256 = RequiredString(source, "sha256");
            var utterance = RequiredString(view, "utterance");
            var intent = RequiredString(view, "intent");
            var taskId = RequiredString(view, "taskId");
            var sessionId = RequiredString(view, "sessionId");
            var revision = Whole(view["revision"], "revision", 0);
            var phase = RequiredString(view, "phase");
            if (phase != "open" && phase != "cancelled")
                throw new ArgumentException("Unknown task phase.");
            var lastAttempt = NewestAttempt(view["attempts"]);
            if (view["components"] is not JArray components)
                throw new ArgumentException("Task components are missing.");

            string? chip = null;
            string? dialogue = null;
            IReadOnlyList<string> evidence = Array.Empty<string>();
            InteractionAction? action = null;
            string? status = null;
            var seen = new HashSet<string>();
            foreach (var token in components)
            {
                if (token is not JObject component)
                    throw new ArgumentException("A component is not an object.");
                var type = RequiredString(component, "type");
                if (!ComponentTypes.Contains(type))
                    throw new ArgumentException("Unknown component type.");
                if (!seen.Add(type))
                    throw new ArgumentException("Use at most one of each component.");
                if (ActionTypes.Contains(type))
                {
                    if (action != null)
                        throw new ArgumentException("Use one action.");
                    action = ActionOf(component, type);
                }
                else if (type == "subject")
                {
                    if (RequiredString(component, "sourceId") != sourceId)
                        throw new ArgumentException("Subject source does not match the task source.");
                }
                else if (type == "annotation")
                {
                    chip = RequiredString(component, "text");
                    evidence = EvidenceIds(component);
                }
                else if (type == "dialogue")
                    dialogue = RequiredString(component, "text");
                else if (type == "status")
                    status = RequiredString(component, "code");
            }
            if (status == null)
                throw new ArgumentException("Task status is missing.");

            var presentation = new InteractionPresentation
            {
                TargetId = sourceId, Utterance = utterance, Continuity = continuity, Delivery = delivery,
                SourceRevision = sourceRevision, Sha256 = sha256, Intent = intent, TaskId = taskId, SessionId = sessionId,
                Revision = revision, Phase = phase, LastAttempt = lastAttempt,
            };
            if (status == "wrong-item")
            {
                // The assistant's parts are cleared: no chip, no subject, no control. The answer stays recorded.
                presentation.wrongItem = true;
                presentation.StatusLine = "Wrong item";
                presentation.Caption = "Wrong item.";
                presentation.SpeakerLine = "Boopy" + NotSent;
                return presentation;
            }
            presentation.Chip = chip ?? "";
            presentation.Dialogue = dialogue ?? "";
            presentation.AnnotationEvidenceIds = evidence;
            presentation.Action = action;
            presentation.StatusLine = "Not sent";
            presentation.SpeakerLine = (lastAttempt == null ? "Boopy" : lastAttempt.RecognitionUncertain ? "You, as heard" : "You") + NotSent;
            presentation.Caption = lastAttempt != null ? lastAttempt.Text : presentation.Dialogue;
            // The control sits only under Boopy's line that asks: once the line shows the person's answer, it goes away.
            presentation.AnswerLabel = phase == "open" && action?.Type == "voice_reply" && lastAttempt == null ? WithoutOnePeriod(action.Label) : null;
            return presentation;
        }

        /// <summary>
        /// The one chip <c>Chip.Show</c> already draws, or none when the annotation is cleared.
        /// The label is the annotation. It stays proposed.
        /// </summary>
        public Item? ChipItem()
        {
            if (Chip.Length == 0) return null;
            return new Item
            {
                Id = TargetId,
                Kind = "object",
                Label = Chip,
                Status = "proposed",
                Origin = "model",
            };
        }

        private static JObject Parse(string json)
        {
            try
            {
                // Strings stay the exact text sent: a person's words are never read as a date.
                using var reader = new JsonTextReader(new StringReader(json)) { DateParseHandling = DateParseHandling.None };
                var value = JToken.ReadFrom(reader, new JsonLoadSettings { DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error });
                if (value is not JObject view || reader.Read())
                    throw new ArgumentException("A task view is one JSON object.");
                return view;
            }
            catch (JsonException)
            {
                throw new ArgumentException("A task view is one JSON object.");
            }
        }

        private static TaskAttempt? NewestAttempt(JToken? token)
        {
            if (token is not JArray attempts)
                throw new ArgumentException("Task attempts are missing.");
            TaskAttempt? newest = null;
            foreach (var entry in attempts)
            {
                if (entry is not JObject attempt)
                    throw new ArgumentException("An attempt is not an object.");
                RequiredString(attempt, "eventId");
                if (RequiredString(attempt, "kind") != "practice-attempt")
                    throw new ArgumentException("Unknown attempt kind.");
                if (attempt["recognitionUncertain"]?.Type != JTokenType.Boolean)
                    throw new ArgumentException("Missing recognitionUncertain.");
                newest = new TaskAttempt(RequiredString(attempt, "text"), attempt["recognitionUncertain"]!.Value<bool>());
            }
            return newest;
        }

        private static IReadOnlyList<string> EvidenceIds(JObject component)
        {
            if (component["evidenceIds"] is not JArray ids || ids.Count < 1 || ids.Count > 4)
                throw new ArgumentException("An annotation names one to four evidence ids.");
            var result = new string[ids.Count];
            for (var index = 0; index < ids.Count; index++)
            {
                var id = ids[index].Type == JTokenType.String ? ids[index].Value<string>() : null;
                if (string.IsNullOrEmpty(id))
                    throw new ArgumentException("An evidence id is missing.");
                result[index] = id!;
            }
            return result;
        }

        private static string WithoutOnePeriod(string prompt)
        {
            if (!prompt.EndsWith(".", StringComparison.Ordinal)) return prompt;
            var label = prompt.Substring(0, prompt.Length - 1);
            return label.Trim().Length == 0 ? prompt : label;
        }

        private static int Whole(JToken? token, string name, int minimum)
        {
            // The reader keeps integers that fit as long; a larger one is out of range, not an overflow.
            if (token is not JValue { Type: JTokenType.Integer } number)
                throw new ArgumentException("Missing " + name + ".");
            if (number.Value is not long value || value < minimum || value > MaxRevision)
                throw new ArgumentException(name + " is out of range.");
            return (int)value;
        }

        private static InteractionAction ActionOf(JObject component, string type)
        {
            if (type == "voice_reply")
                return new InteractionAction(type, RequiredString(component, "prompt"));
            if (type == "task_step")
                return new InteractionAction(type, RequiredString(component, "text"));
            var options = component["options"] as JArray;
            if (options == null || options.Count < 1 || options.Count > 3)
                throw new ArgumentException("A choice has one to three options.");
            var labels = new string[options.Count];
            for (var index = 0; index < options.Count; index++)
            {
                if (options[index] is not JObject option)
                    throw new ArgumentException("A choice option is missing.");
                labels[index] = RequiredString(option, "label");
            }
            return new InteractionAction(type, labels[0], labels);
        }

        private static string RequiredString(JObject obj, string name)
        {
            if (obj[name]?.Type != JTokenType.String)
                throw new ArgumentException("Missing " + name + ".");
            var value = obj[name]!.Value<string>() ?? "";
            if (value.Length == 0)
                throw new ArgumentException("Missing " + name + ".");
            return value;
        }
    }

    /// <summary>
    /// One recorded answer: the recognized words exactly, and whether recognition was uncertain.
    /// It is a practice attempt kept on the Mac, not a confirmed statement, and it is not sent.
    /// </summary>
    public sealed class TaskAttempt
    {
        internal TaskAttempt(string text, bool recognitionUncertain)
        {
            Text = text;
            RecognitionUncertain = recognitionUncertain;
        }

        public string Text { get; }
        public bool RecognitionUncertain { get; }
    }

    /// <summary>The one interactive component already on the view. Agent presence is not an action.</summary>
    public sealed class InteractionAction
    {
        public string Type { get; }
        /// <summary>Voice prompt, task step, or the first choice option. Every choice label is in <see cref="OptionLabels"/>.</summary>
        public string Label { get; }
        public IReadOnlyList<string> OptionLabels { get; }

        public InteractionAction(string type, string label, IReadOnlyList<string>? optionLabels = null)
        {
            Type = type;
            Label = label;
            OptionLabels = optionLabels ?? Array.Empty<string>();
        }
    }
}
