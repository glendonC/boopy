#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Boopy.Client
{
    /// <summary>
    /// One task view on the existing subject, chip, and dialogue line. Continuity stays local-only
    /// and delivery stays not-sent, so the line says "Not sent". A proposal stays proposed.
    /// </summary>
    public sealed class InteractionPresentation
    {
        private const int MaxRevision = 1_000_000;
        private const string NotSent = " · Not sent";

        public string TargetId { get; private set; } = "";
        public string Chip { get; private set; } = "";
        public string Dialogue { get; private set; } = "";
        public InteractionAction? Action { get; private set; }
        public string? StatusLine { get; private set; }
        public string Utterance { get; private set; } = "";
        public string Continuity { get; private set; } = "";
        public string Delivery { get; private set; } = "";
        public string TaskId { get; private set; } = "";
        public string SessionId { get; private set; } = "";
        public int Revision { get; private set; }
        public string Phase { get; private set; } = "";
        public TaskAttempt? LastAttempt { get; private set; }
        public string SpeakerLine { get; private set; } = "";
        public string Caption { get; private set; } = "";
        public string? AnswerLabel { get; private set; }

        private InteractionPresentation() { }

        /// <summary>Read a task view. A view that claims it was sent is refused.</summary>
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
            var utterance = RequiredString(view, "utterance");
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
            InteractionAction? action = null;
            string? status = null;
            var seen = new HashSet<string>();
            foreach (var token in components)
            {
                if (token is not JObject component)
                    throw new ArgumentException("A component is not an object.");
                var type = RequiredString(component, "type");
                if (!seen.Add(type))
                    throw new ArgumentException("Use at most one of each component.");
                if (type == "voice_reply")
                    action = new InteractionAction(type, RequiredString(component, "prompt"));
                else if (type == "annotation")
                    chip = RequiredString(component, "text");
                else if (type == "dialogue")
                    dialogue = RequiredString(component, "text");
                else if (type == "subject")
                {
                    if (RequiredString(component, "sourceId") != sourceId)
                        throw new ArgumentException("Subject source does not match the task source.");
                }
                else if (type == "status")
                    status = RequiredString(component, "code");
                else
                    throw new ArgumentException("Unknown component type.");
            }
            if (status == null)
                throw new ArgumentException("Task status is missing.");

            var presentation = new InteractionPresentation
            {
                TargetId = sourceId,
                Utterance = utterance,
                Continuity = continuity,
                Delivery = delivery,
                TaskId = taskId,
                SessionId = sessionId,
                Revision = revision,
                Phase = phase,
                LastAttempt = lastAttempt,
                Chip = chip ?? "",
                Dialogue = dialogue ?? "",
                Action = action,
                StatusLine = "Not sent",
                SpeakerLine = (lastAttempt != null ? "You" : "Boopy") + NotSent,
                Caption = lastAttempt != null ? lastAttempt.Text : dialogue ?? "",
                AnswerLabel = phase == "open" && action != null && action.Type == "voice_reply"
                    ? WithoutOnePeriod(action.Label)
                    : null,
            };
            return presentation;
        }

        /// <summary>The chip on the subject. The label stays proposed.</summary>
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

        private static string WithoutOnePeriod(string prompt)
        {
            if (!prompt.EndsWith(".", StringComparison.Ordinal)) return prompt;
            var label = prompt.Substring(0, prompt.Length - 1);
            return label.Trim().Length == 0 ? prompt : label;
        }

        private static int Whole(JToken? token, string name, int minimum)
        {
            if (token is not JValue { Type: JTokenType.Integer } number)
                throw new ArgumentException("Missing " + name + ".");
            if (number.Value is not long value || value < minimum || value > MaxRevision)
                throw new ArgumentException(name + " is out of range.");
            return (int)value;
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

    /// <summary>One recorded answer. It stays on the Mac and is not sent.</summary>
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

    /// <summary>The one control on the view. The proposal itself is not this action.</summary>
    public sealed class InteractionAction
    {
        public InteractionAction(string type, string label)
        {
            Type = type;
            Label = label;
            OptionLabels = Array.Empty<string>();
        }

        public string Type { get; }
        public string Label { get; }
        public IReadOnlyList<string> OptionLabels { get; }
    }
}
