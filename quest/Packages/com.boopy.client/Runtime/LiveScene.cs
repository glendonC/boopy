#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;

namespace Boopy.Client
{
    public sealed class SceneObservationRequest
    {
        public string StreamId { get; set; } = "";
        public string FrameId { get; set; } = "";
        public int Sequence { get; set; }
        public FrameData Frame { get; set; } = new FrameData();
    }
    public sealed class SceneObject
    {
        public string Label { get; set; } = "";
        public float Confidence { get; set; }
        public Box2 Box { get; set; } = new Box2();
        public List<Point2> Contour { get; set; } = new List<Point2>();
        public float MaskConfidence { get; set; }
        public string MaskSha256 { get; set; } = "";
        public int MaskPixels { get; set; }
        public Grounding GroundingFor(SceneObservation source) => new Grounding {
            Kind="box", Box=Box, Contour=Contour, ObservationId=source.FrameId,
            Spatial=new SpatialEvidence {Provider=source.Provider,Model=source.Model,Concept=Label,
                Outcome="contour",Verification="proposed",Confidence=MaskConfidence,
                FrameSha256=source.FrameSha256,MaskSha256=MaskSha256,LatencyMs=source.LatencyMs}
        };
    }
    public sealed class SceneObservation
    {
        public string StreamId { get; set; } = "";
        public string FrameId { get; set; } = "";
        public int Sequence { get; set; }
        public string CapturedAt { get; set; } = "";
        public string FrameSha256 { get; set; } = "";
        public string EventId { get; set; } = "";
        public string Provider { get; set; } = "";
        public string Model { get; set; } = "";
        public string Verification { get; set; } = "";
        public bool FrameRetained { get; set; }
        public float LatencyMs { get; set; }
        public List<SceneObject> Objects { get; set; } = new List<SceneObject>();
        /// <summary>How many objects <see cref="LeaveOutUnusableOutlines"/> left out of this frame. Never on the wire.</summary>
        [Newtonsoft.Json.JsonIgnore] public int LeftOut { get; private set; }

        /// <summary>
        /// Leaves out each object whose outline is well formed but not a simple polygon (its edges cross or touch), so one
        /// bad outline never refuses the frame's other objects. Returns how many. Anything else malformed still fails
        /// <see cref="Matches"/>.
        /// </summary>
        public int LeaveOutUnusableOutlines()
        {
            var removed = Objects?.RemoveAll(item => item?.Contour != null && item.Contour.Count >= 3 && item.Contour.Count <= 256
                && item.Contour.All(point => point != null && !float.IsNaN(point.X) && !float.IsInfinity(point.X)
                    && !float.IsNaN(point.Y) && !float.IsInfinity(point.Y))
                && !Geometry.TryContour(item.GroundingFor(this), out _)) ?? 0;
            LeftOut += removed;
            return removed;
        }
        public bool Matches(SceneObservationRequest request) => StreamId == request.StreamId && FrameId == request.FrameId
            && Sequence == request.Sequence && CapturedAt == request.Frame.CapturedAt && Verification == "proposed"
            && !FrameRetained && !string.IsNullOrWhiteSpace(EventId) && !string.IsNullOrWhiteSpace(Model)
            && !string.IsNullOrWhiteSpace(Provider) && FrameSha256.Length == 64 && FrameSha256.All(Uri.IsHexDigit)
            && FrameSha256 == FrameHash(request.Frame.Jpeg)
            && !float.IsNaN(LatencyMs) && !float.IsInfinity(LatencyMs) && LatencyMs >= 0
            && Objects != null && Objects.Count <= 4 && Objects.All(item => item != null
                && !string.IsNullOrWhiteSpace(item.Label) && item.Label.Length <= 64
                && !float.IsNaN(item.Confidence) && item.Confidence >= 0 && item.Confidence <= 1
                && item.Contour != null && item.Contour.Count >= 3 && item.Contour.Count <= 256
                && item.MaskSha256.Length==64 && item.MaskSha256.All(Uri.IsHexDigit) && item.MaskPixels>0
                && !float.IsNaN(item.MaskConfidence) && item.MaskConfidence>=0 && item.MaskConfidence<=1
                && Geometry.TryContour(item.GroundingFor(this), out _));
        private static string FrameHash(string jpeg)
        {
            try { using var sha=SHA256.Create();return BitConverter.ToString(sha.ComputeHash(Convert.FromBase64String(jpeg))).Replace("-","").ToLowerInvariant(); }
            catch(FormatException) { return ""; }
        }
    }
    public sealed partial class ServiceClient
    {
        /// <summary>A single current frame, never retried or used as confirmation.</summary>
        public async Task<SceneObservation> ObserveSceneAsync(SceneObservationRequest request, CancellationToken cancel = default)
        {
            if (!Guid.TryParse(request.StreamId,out _) || !Guid.TryParse(request.FrameId,out _) || request.Sequence < 0)
                throw new ArgumentException("A live frame needs stream/frame identities.");
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            deadline.CancelAfter(TimeSpan.FromSeconds(8));
            using var content = new StringContent(Wire.Write(request), Encoding.UTF8, "application/json");
            using var response = await http.PostAsync("v1/scene/observe",content,deadline.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) throw new ServiceException((int)response.StatusCode,"scene_unavailable","Scene recognition is unavailable.");
            var result = Wire.Read<SceneObservation>(await response.Content.ReadAsStringAsync().ConfigureAwait(false));
            deadline.Token.ThrowIfCancellationRequested();
            result.LeaveOutUnusableOutlines();
            if (!result.Matches(request)) throw new ServiceException(502,"scene_invalid","Scene update did not match this view.");
            return result;
        }
    }
}
