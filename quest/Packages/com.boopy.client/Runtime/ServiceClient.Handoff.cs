#nullable enable
using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Boopy.Client
{
    public sealed partial class ServiceClient
    {
        private const int HandoffMetadataLimit = 256 * 1024;
        public Task<HandoffStatus> PrepareHandoffAsync(string sessionId, HandoffRequest request, CancellationToken cancel = default)
        {
            if (request == null || !request.Valid) throw new ArgumentException("Select valid context and optional sources.");
            return HandoffAsync(sessionId, request.RequestId, request.PackageId, request, true, cancel);
        }
        public Task<HandoffStatus> ReadHandoffAsync(string sessionId, string requestId, CancellationToken cancel = default) =>
            HandoffAsync(sessionId, requestId, null, null, false, cancel);
        public Task<HandoffStatus> ReadHandoffAsync(string sessionId, HandoffRequest request, CancellationToken cancel = default)
        {
            if (request == null || !request.Valid) throw new ArgumentException("Select valid context and optional sources.");
            return HandoffAsync(sessionId, request.RequestId, request.PackageId, request, false, cancel);
        }
        private async Task<HandoffStatus> HandoffAsync(string sessionId, string requestId, string? packageId,
            HandoffRequest? selection, bool prepare, CancellationToken cancel)
        {
            if (string.IsNullOrWhiteSpace(sessionId) || sessionId.Length > 160 || !HandoffWords.Identifier(requestId))
                throw new ArgumentException("Select a valid context preparation.");
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            deadline.CancelAfter(controlTimeout);
            try
            {
                var path = $"v1/sessions/{Uri.EscapeDataString(sessionId)}/handoff-preparations";
                if (!prepare) path += "/" + Uri.EscapeDataString(requestId);
                using var request = new HttpRequestMessage(prepare ? HttpMethod.Post : HttpMethod.Get, path);
                if (prepare) request.Content = new StringContent(Wire.Write(selection!), Encoding.UTF8, "application/json");
                using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token).ConfigureAwait(false);
                deadline.Token.ThrowIfCancellationRequested();
                if (response.StatusCode != HttpStatusCode.OK && !(prepare && response.StatusCode == HttpStatusCode.Accepted))
                    throw new ServiceException((int)response.StatusCode, "handoff_unavailable", "Could not prepare or check this context on the Mac.");
                if (response.Content.Headers.ContentLength > HandoffMetadataLimit) throw InvalidHandoff();
                using var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
                using var bytes = new MemoryStream();
                var buffer = new byte[4096];
                while (true)
                {
                    var count = await stream.ReadAsync(buffer, 0, buffer.Length, deadline.Token).ConfigureAwait(false);
                    deadline.Token.ThrowIfCancellationRequested();
                    if (count == 0) break;
                    if (bytes.Length + count > HandoffMetadataLimit) throw InvalidHandoff();
                    bytes.Write(buffer, 0, count);
                }
                var status = Wire.Read<HandoffStatus>(Encoding.UTF8.GetString(bytes.ToArray()));
                deadline.Token.ThrowIfCancellationRequested();
                if (!status.ValidFor(sessionId, requestId, packageId, selection)
                    || (response.StatusCode == HttpStatusCode.Accepted && status.State != "preparing-local")
                    || (prepare && response.StatusCode == HttpStatusCode.OK && status.State != "prepared-local"))
                    throw InvalidHandoff();
                return status;
            }
            catch (OperationCanceledException) when (!cancel.IsCancellationRequested)
            { throw new ServiceException(408, "request_timeout", "The context preparation may still finish on the Mac. Check its receipt before trying again."); }
            catch (Newtonsoft.Json.JsonException) { throw InvalidHandoff(); }
            catch (HttpRequestException) { throw HandoffConnectionLost(); }
            catch (IOException) { throw HandoffConnectionLost(); }
        }
        private static ServiceException InvalidHandoff() => new ServiceException(502, "invalid_reply", "The Mac returned an invalid context preparation receipt.");
        private static ServiceException HandoffConnectionLost() => new ServiceException(503, "connection_lost", "The Mac connection was lost. Check this preparation's receipt after reconnecting.");
    }
}
