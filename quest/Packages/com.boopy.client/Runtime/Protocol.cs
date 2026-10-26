#nullable enable
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;

namespace Boopy.Client
{
    // The service's wire vocabulary (service/src/contracts.ts). Image coordinates are normalized
    // 0 to 1 with the origin at the top-left; Geometry converts them to the camera's viewport.

    /// <summary>Configured capabilities, not proof of model readiness or a Muse account connection.</summary>
    public sealed class HealthView
    {
        public bool Ok { get; set; }
        public string Service { get; set; } = "";
        public ConfiguredModel? Interpreter { get; set; }
        public bool SpeechOutputAvailable { get; set; }
        public bool HandoffPreparationAvailable { get; set; }

        /// <summary>The service serves the headset activity routes; older services omit it.</summary>
        public bool Activities { get; set; }
        private ConfiguredModel? liveScene;
        private bool liveSceneSpecified;
        [JsonProperty(NullValueHandling = NullValueHandling.Include)]
        public ConfiguredModel? LiveScene
        {
            get => liveScene;
            set { liveScene = value; liveSceneSpecified = true; }
        }
        [JsonIgnore]
        public bool? LiveSceneAvailable => !liveSceneSpecified ? (bool?)null
            : liveScene == null ? false
            : !string.IsNullOrWhiteSpace(liveScene.Provider) && !string.IsNullOrWhiteSpace(liveScene.Model) ? true : (bool?)null;
        public bool Valid => Ok && Service == "boopy" && Interpreter != null
            && !string.IsNullOrWhiteSpace(Interpreter.Provider) && !string.IsNullOrWhiteSpace(Interpreter.Model);
    }
    public sealed class ConfiguredModel
    {
        public string Provider { get; set; } = "";
        public string Model { get; set; } = "";
    }

    public sealed class Point2
    {
        public float X { get; set; }
        public float Y { get; set; }
    }

    public sealed class Box2
    {
        public float X0 { get; set; }
        public float Y0 { get; set; }
        public float X1 { get; set; }
        public float Y1 { get; set; }
    }

    public sealed class Pose3
    {
        /// <summary>Unity world position, meters.</summary>
        public float[] Position { get; set; } = new float[3];

        /// <summary>Unity world rotation as x, y, z, w.</summary>
        public float[] Rotation { get; set; } = new float[4];
    }

    public sealed class CameraInfo
    {
        public string Eye { get; set; } = "left";
        public Pose3 Pose { get; set; } = new Pose3();
        public float[] FocalLength { get; set; } = new float[2];
        public float[] PrincipalPoint { get; set; } = new float[2];
        public int[] SensorResolution { get; set; } = new int[2];
    }

    /// <summary>Meters along rays through cell centers, row by row from the top-left; null where depth had no answer.</summary>
    public sealed class DepthGrid
    {
        public int Columns { get; set; }
        public int Rows { get; set; }
        public float?[] Meters { get; set; } = new float?[0];
    }

    public sealed class FrameData
    {
        /// <summary>JPEG, base64.</summary>
        public string Jpeg { get; set; } = "";
        public int Width { get; set; }
        public int Height { get; set; }
        public string CapturedAt { get; set; } = "";
        public string? Source { get; set; }
        public bool? TimestampTrusted { get; set; }
        public CameraInfo? Camera { get; set; }
        public DepthGrid? Depth { get; set; }
    }

    public class Cue
    {
        public Point2 Point { get; set; } = new Point2();
        public float[]? World { get; set; }
        public bool OnSurface { get; set; }
    }

    public sealed class PointerCue : Cue
    {
        public string Hand { get; set; } = "right";
    }

    public sealed class Cues
    {
        public Cue? Gaze { get; set; }
        public PointerCue? Pointer { get; set; }
        public string? TargetItemId { get; set; }
    }

    /// <summary>Either a WAV clip (base64) or typed text.</summary>
    public sealed class SpeechData
    {
        public string? Wav { get; set; }
        public string? Text { get; set; }
        public string? Language { get; set; }
    }

    public sealed class DeviceInfo
    {
        public string Model { get; set; } = "Meta Quest 3";
        public string App { get; set; } = "boopy-quest 0.1.0";
    }

    public sealed class StartSessionRequest
    {
        public string? RequestId { get; set; }
        public FrameData? Frame { get; set; } = new FrameData();
        /// <summary>A recorded still the Mac shows, in place of <see cref="Frame"/>.</summary>
        public RecordedFrameRef? RecordedFrame { get; set; }
        public AttentionInput? Attention { get; set; }
        public Cues Cues { get; set; } = new Cues();
        public SpeechData Speech { get; set; } = new SpeechData();
        public DeviceInfo? Device { get; set; }
    }

    public sealed class StartRecoveryView
    {
        public string RequestId { get; set; } = "";
        public string SessionId { get; set; } = "";
        public string Status { get; set; } = "";
        public string? FailureCode { get; set; }
        public SessionView? View { get; set; }
    }

    public sealed class UtteranceRequest
    {
        public ContextualActionSelection? Selection { get; set; }
        public AttentionInput? Attention { get; set; }
        public FrameData? Frame { get; set; }
        /// <summary>A recorded still the Mac shows, in place of <see cref="Frame"/>.</summary>
        public RecordedFrameRef? RecordedFrame { get; set; }
        public Cues? Cues { get; set; }
        public SpeechData Speech { get; set; } = new SpeechData();
    }

    public sealed class ActionRequest
    {
        public string ItemId { get; set; } = "";

        /// <summary>confirm, reject, ignore, known, matters or reset.</summary>
        public string Action { get; set; } = "confirm";
    }

    /// <summary>Geometry evidence is separate from semantic confidence and human confirmation.</summary>
    public sealed class SpatialEvidence
    {
        public string Provider { get; set; } = "";
        public string Model { get; set; } = "";
        public string Concept { get; set; } = "";
        public float LatencyMs { get; set; }
        public float? Confidence { get; set; }
        public string Verification { get; set; } = "proposed";
        public string Outcome { get; set; } = "";
        public string FrameSha256 { get; set; } = "";
        public string UtteranceId { get; set; } = "";
        public string? MaskSha256 { get; set; }
    }

    public sealed class Grounding
    {
        /// <summary>box, point or scene.</summary>
        public string Kind { get; set; } = "scene";
        public string? ObservationId { get; set; }
        public Box2? Box { get; set; }
        public Point2? Point { get; set; }
        /// <summary>Ordered, normalized boundary; the closing duplicate is omitted.</summary>
        public List<Point2>? Contour { get; set; }
        public SpatialEvidence? Spatial { get; set; }
    }

    public sealed class Item
    {
        public string Id { get; set; } = "";
        public string Kind { get; set; } = "";
        public string Label { get; set; } = "";
        public string? Gloss { get; set; }
        public string Statement { get; set; } = "";
        public Grounding Grounding { get; set; } = new Grounding();

        /// <summary>The model's confidence; null for the person's own words and for questions.</summary>
        public float? Confidence { get; set; }
        public string? Why { get; set; }

        /// <summary>model or person.</summary>
        public string Origin { get; set; } = "model";

        /// <summary>proposed, confirmed, rejected, ignored or known.</summary>
        public string Status { get; set; } = "proposed";
        public bool Emphasis { get; set; }
        public string? Note { get; set; }
        public string? ProposedLabel { get; set; }
        public List<string>? Text { get; set; }
    }

    public sealed class Relation
    {
        public string Id { get; set; } = "";
        public string From { get; set; } = "";
        public string To { get; set; } = "";
        public string Kind { get; set; } = "";
        public string? Label { get; set; }
    }

    public sealed class ObservationRef
    {
        public string Id { get; set; } = "";
        public string CapturedAt { get; set; } = "";
    }

    public sealed class UtteranceRef
    {
        public string Id { get; set; } = "";
        public string Text { get; set; } = "";
        public string Language { get; set; } = "";
        public string Kind { get; set; } = "";
    }

    public sealed class ModelRef
    {
        public string Provider { get; set; } = "";
        public string Id { get; set; } = "";
        public float LatencyMs { get; set; }
    }

    public sealed class Committed
    {
        public string PackageId { get; set; } = "";
        public string At { get; set; } = "";
        public string Summary { get; set; } = "";
    }

    /// <summary>Sanitized latest-turn interpretation failure; absent on older services.</summary>
    public sealed class InterpretationFailure
    {
        public string Code { get; set; } = "";
        public string UtteranceId { get; set; } = "";
        public string Message { get; set; } = "";
    }

    public sealed class SessionView
    {
        public bool SpeechOutputAvailable { get; set; }
        public string Id { get; set; } = "";

        /// <summary>review or committed.</summary>
        public string State { get; set; } = "review";
        public string Scope { get; set; } = "object";
        public string? ReferentId { get; set; }
        public string? IntentId { get; set; }
        public List<Item> Items { get; set; } = new List<Item>();
        public List<Relation> Relations { get; set; } = new List<Relation>();
        public List<ObservationRef> Observations { get; set; } = new List<ObservationRef>();
        public List<UtteranceRef> Utterances { get; set; } = new List<UtteranceRef>();
        public ModelRef? Model { get; set; }
        public string? Notice { get; set; }
        public InterpretationFailure? InterpretationFailure { get; set; }
        public Committed? Committed { get; set; }
        public AttentionView? Attention { get; set; }
        public DialogueView? Dialogue { get; set; }
    }

    /// <summary>Explicit evidence request; the service decides whether to inspect, clarify or ask for a fresh view.</summary>
    public sealed class AttentionInput
    {
        public string Source { get; set; } = "unknown";
        public string Scope { get; set; } = "scene";
        public string Evidence { get; set; } = "visual";
        public string? ObservationId { get; set; }
        public bool AmbiguousTarget { get; set; }
        public bool OcrRequested { get; set; }
        public bool SegmentationRequested { get; set; }
        public double MaxAgeMs { get; set; } = 15000;
    }

    public sealed class AttentionWork
    {
        public bool Ocr { get; set; }
        public bool Segmentation { get; set; }
    }

    public sealed class AttentionView
    {
        public string UtteranceId { get; set; } = "";
        public string Source { get; set; } = "unknown";
        public string Action { get; set; } = "clarify";
        public string Reason { get; set; } = "";
        public string? ObservationId { get; set; }
        public AttentionWork Work { get; set; } = new AttentionWork();
    }

    /// <summary>Actual journaled Boopy response. At is server response time, not speech/caption timing.</summary>
    public sealed class SpeechOutputRequest
    {
        public string UtteranceId { get; set; } = "";
        public string ResponseAt { get; set; } = "";
    }

    public sealed class SpeechOutputResponse
    {
        public string SessionId { get; set; } = "";
        public string UtteranceId { get; set; } = "";
        public string ResponseAt { get; set; } = "";
        public string Speaker { get; set; } = "";
        public string MimeType { get; set; } = "";
        public string Wav { get; set; } = "";
        public string Language { get; set; } = "";
        public string Voice { get; set; } = "";
        public double LatencyMs { get; set; }
    }

    public sealed class ContextualAction
    {
        public string Id { get; set; } = "";
        public string Question { get; set; } = "";
        public string? TargetItemId { get; set; }
        public string? ObservationId { get; set; }
    }

    /// <summary>A person's explicit selection, not microphone speech or semantic confirmation.</summary>
    public sealed class ContextualActionSelection
    {
        public string UtteranceId { get; set; } = "";
        public string ResponseAt { get; set; } = "";
        public string ActionId { get; set; } = "";
    }

    public sealed class ChoiceOption
    {
        public string Id { get; set; } = "";
        public string Label { get; set; } = "";
        public string Value { get; set; } = "";
    }
    public sealed class ChoiceCard
    {
        public string Id { get; set; } = "";
        public string Kind { get; set; } = "";
        public string Prompt { get; set; } = "";
        public List<ChoiceOption> Options { get; set; } = new List<ChoiceOption>();
        public string? SelectedOptionId { get; set; }
        [JsonIgnore]
        public bool Supported => Kind == "choice" && !string.IsNullOrWhiteSpace(Id) && Id.Length <= 120
            && !string.IsNullOrWhiteSpace(Prompt) && Prompt.Length <= 160 && Options != null && Options.Count >= 2 && Options.Count <= 3
            && Options.All(o => o != null && !string.IsNullOrWhiteSpace(o.Id) && o.Id.Length <= 120
                && !string.IsNullOrWhiteSpace(o.Label) && o.Label.Length <= 60 && o.Value == o.Label)
            && Options.Select(o => o.Id).Distinct().Count() == Options.Count
            && (SelectedOptionId == null || Options.Any(o => o.Id == SelectedOptionId));
    }
    public sealed class ChoiceSelection
    {
        public string UtteranceId { get; set; } = "";
        public string ResponseAt { get; set; } = "";
        public string CardId { get; set; } = "";
        public string OptionId { get; set; } = "";
    }
    public sealed class DialogueView
    {
        public ChoiceCard? Choice { get; set; }
        public List<ContextualAction> Actions { get; set; } = new List<ContextualAction>();
        public string Speaker { get; set; } = "boopy";
        public string Text { get; set; } = "";
        public string UtteranceId { get; set; } = "";
        public string At { get; set; } = "";
    }

    public sealed class ErrorBody
    {
        public ErrorDetail? Error { get; set; }
    }

    public sealed class ErrorDetail
    {
        public string Code { get; set; } = "";
        public string Message { get; set; } = "";
    }

    public static class Wire
    {
        public static readonly JsonSerializerSettings Settings = new JsonSerializerSettings
        {
            ContractResolver = new CamelCasePropertyNamesContractResolver(),
            NullValueHandling = NullValueHandling.Ignore,
            MissingMemberHandling = MissingMemberHandling.Ignore,
            // Timestamps stay the strings the service sent; parsing them as dates would rewrite
            // them in the headset's culture when read into string properties.
            DateParseHandling = DateParseHandling.None,
        };

        public static string Write(object value) => JsonConvert.SerializeObject(value, Settings);

        public static T Read<T>(string json) => JsonConvert.DeserializeObject<T>(json, Settings)
            ?? throw new JsonSerializationException("The service sent an empty body.");
    }
}
