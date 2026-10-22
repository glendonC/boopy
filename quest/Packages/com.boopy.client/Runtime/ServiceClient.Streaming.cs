#nullable enable
using System;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

namespace Boopy.Client
{
    /// <summary>Actual service work only; no model reasoning or unvalidated answer tokens.</summary>
    public sealed class TurnProgress
    {
        public string Stage { get; }
        internal TurnProgress(string stage) { Stage = stage; }
        public string Words => Stage == "transcribing" ? "I’m working out what you said…"
            : Stage == "reading-text" ? "I’m reading the text here…"
            : Stage == "interpreting" ? "I’m looking into that…"
            : "I’m finding those details…";
    }

    public sealed partial class ServiceClient
    {
        public async Task<SessionView> StartStreamingAsync(StartSessionRequest request,
            IProgress<TurnProgress> progress, CancellationToken cancel = default)
        {
            if (request.RequestId != null && !Guid.TryParse(request.RequestId, out _))
                throw new ArgumentException("Session start requires a valid request UUID.");
            try { return await StreamTurnAsync("v1/sessions", request, progress, cancel).ConfigureAwait(false); }
            catch (ServiceException failure) when (request.RequestId != null &&
                (failure.Code == "connection_lost" || failure.Code == "request_timeout"))
            {
                cancel.ThrowIfCancellationRequested();
                try
                {
                    var current = await ReadStartAsync(request.RequestId, cancel).ConfigureAwait(false);
                    cancel.ThrowIfCancellationRequested();
                    if (current.RequestId == request.RequestId && current.Status == "succeeded" &&
                        !string.IsNullOrWhiteSpace(current.SessionId) && current.View != null && current.View.Id == current.SessionId)
                        return current.View;
                }
                catch (ServiceException) { }
                catch (Newtonsoft.Json.JsonException) { }
                cancel.ThrowIfCancellationRequested();
                throw;
            }
        }

        public Task<SessionView> UtterStreamingAsync(string sessionId, UtteranceRequest request,
            IProgress<TurnProgress> progress, CancellationToken cancel = default) =>
            StreamTurnAsync($"v1/sessions/{Uri.EscapeDataString(sessionId)}/utterances", request, progress, cancel);

        public Task<SessionView> FollowUpStreamingAsync(string sessionId, DialogueView originating,
            ContextualAction action, IProgress<TurnProgress> progress, CancellationToken cancel = default) =>
            UtterStreamingAsync(sessionId, FollowUpRequest(sessionId, originating, action), progress, cancel);

        public Task<SessionView> SelectChoiceAsync(string sessionId, ChoiceSelection selection, CancellationToken cancel = default) =>
            PostAsync($"v1/sessions/{Uri.EscapeDataString(sessionId)}/choice-selection", selection, controlTimeout, cancel);

        public Task<SessionView> SubmitChoiceStreamingAsync(string sessionId, ChoiceSelection selection,
            IProgress<TurnProgress> progress, CancellationToken cancel = default) =>
            StreamTurnAsync($"v1/sessions/{Uri.EscapeDataString(sessionId)}/choice-submit", selection, progress, cancel);

        private async Task<SessionView> StreamTurnAsync(string path, object body,
            IProgress<TurnProgress> progress, CancellationToken cancel)
        {
            if (progress == null) throw new ArgumentNullException(nameof(progress));
            if (!await HealthyAsync(cancel).ConfigureAwait(false))
                throw new ServiceException(503, "service_unavailable", "The Mac is not reachable over USB. Reconnect the cable and restore the connection, then try again.");
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            deadline.CancelAfter(requestTimeout);
            try
            {
                using var outgoing = new HttpRequestMessage(HttpMethod.Post, path);
                outgoing.Headers.Accept.ParseAdd("application/x-ndjson");
                outgoing.Content = new StringContent(Wire.Write(body), Encoding.UTF8, "application/json");
                using var response = await http.SendAsync(outgoing, HttpCompletionOption.ResponseHeadersRead, deadline.Token).ConfigureAwait(false);
                deadline.Token.ThrowIfCancellationRequested();
                if (!response.IsSuccessStatusCode)
                {
                    // Schema/Host refusals happen before the streaming response is opened.
                    using var failedStream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
                    using var failedBytes = new MemoryStream(); var failedBuffer = new byte[4096];
                    while (true)
                    {
                        var read = await failedStream.ReadAsync(failedBuffer,0,failedBuffer.Length,deadline.Token).ConfigureAwait(false);
                        deadline.Token.ThrowIfCancellationRequested(); if (read == 0) break;
                        if (failedBytes.Length + read > 16384) throw InvalidStream(path);
                        failedBytes.Write(failedBuffer,0,read);
                    }
                    ErrorDetail? detail = null;
                    try { detail = Wire.Read<ErrorBody>(Encoding.UTF8.GetString(failedBytes.ToArray())).Error; }
                    catch (Newtonsoft.Json.JsonException) { }
                    throw new ServiceException((int)response.StatusCode, detail?.Code ?? "http_error",
                        detail?.Message ?? "The Mac could not process this request. Check before trying again.");
                }
                using var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
                if (response.Content.Headers.ContentType?.MediaType != "application/x-ndjson")
                {
                    if (response.Content.Headers.ContentType?.MediaType != "application/json") throw InvalidStream(path);
                    // Compatibility is the same completed POST response, never a mutation retry.
                    // Older services have no progress events; only their final JSON is eligible.
                    using var legacy = new MemoryStream(); var bytes = new byte[4096];
                    while (true)
                    {
                        var read = await stream.ReadAsync(bytes,0,bytes.Length,deadline.Token).ConfigureAwait(false);
                        deadline.Token.ThrowIfCancellationRequested(); if (read == 0) break;
                        if (legacy.Length + read > 2 * 1024 * 1024) throw InvalidStream(path);
                        legacy.Write(bytes,0,read);
                    }
                    var value = JObject.Parse(new UTF8Encoding(false,true).GetString(legacy.ToArray()),
                        new JsonLoadSettings { DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error });
                    return StreamView(value,path);
                }
                using var line = new MemoryStream();
                var buffer = new byte[4096]; var total = 0; var events = 0;
                SessionView? result = null;
                while (true)
                {
                    var count = await stream.ReadAsync(buffer, 0, buffer.Length, deadline.Token).ConfigureAwait(false);
                    deadline.Token.ThrowIfCancellationRequested();
                    if (count == 0) break;
                    total += count; if (total > 4 * 1024 * 1024) throw InvalidStream(path);
                    for (var index = 0; index < count; index++)
                    {
                        if (buffer[index] != 10)
                        {
                            if (line.Length >= 2 * 1024 * 1024) throw InvalidStream(path);
                            line.WriteByte(buffer[index]); continue;
                        }
                        if (line.Length == 0) throw InvalidStream(path);
                        var text = new UTF8Encoding(false, true).GetString(line.ToArray()); line.SetLength(0);
                        var value = JObject.Parse(text, new JsonLoadSettings { DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error });
                        if (result != null || ++events > 33) throw InvalidStream(path);
                        if (value["type"]?.Type != JTokenType.String) throw InvalidStream(path);
                        var type = (string?)value["type"];
                        if (type == "stage")
                        {
                            if (events > 32 || value.Count != 2 || value["stage"]?.Type != JTokenType.String) throw InvalidStream(path);
                            var stage = (string)value["stage"]!;
                            if (stage != "transcribing" && stage != "reading-text" && stage != "interpreting" && stage != "refining-geometry") throw InvalidStream(path);
                            deadline.Token.ThrowIfCancellationRequested(); progress.Report(new TurnProgress(stage));
                        }
                        else if (type == "result")
                        {
                            if (value.Count != 2 || value["view"]?.Type != JTokenType.Object) throw InvalidStream(path);
                            result = StreamView(value["view"]!,path);
                        }
                        else if (type == "error")
                        {
                            if (value.Count != 2 || value["error"]?.Type != JTokenType.Object) throw InvalidStream(path);
                            var error = (JObject)value["error"]!;
                            var code = error["code"]?.Type == JTokenType.String ? (string?)error["code"] : null;
                            var message = error["message"]?.Type == JTokenType.String ? (string?)error["message"] : null;
                            if (error.Count != 2 || string.IsNullOrWhiteSpace(code) || code!.Length > 80 || string.IsNullOrWhiteSpace(message) || message!.Length > 500) throw InvalidStream(path);
                            throw new ServiceException(502, code, message);
                        }
                        else throw InvalidStream(path);
                    }
                }
                deadline.Token.ThrowIfCancellationRequested();
                if (line.Length != 0 || result == null) throw InvalidStream(path);
                return result;
            }
            catch (OperationCanceledException) when (!cancel.IsCancellationRequested)
            { throw new ServiceException(408, "request_timeout", UncertainResponse(path, true)); }
            catch (HttpRequestException)
            { cancel.ThrowIfCancellationRequested(); throw new ServiceException(503, "connection_lost", UncertainResponse(path, false)); }
            catch (IOException)
            { cancel.ThrowIfCancellationRequested(); throw new ServiceException(503, "connection_lost", UncertainResponse(path, false)); }
            catch (Newtonsoft.Json.JsonException) { throw InvalidStream(path); }
            catch (DecoderFallbackException) { throw InvalidStream(path); }
        }
        private static SessionView StreamView(JToken value, string path)
        {
            var result = Wire.Read<SessionView>(value.ToString(Newtonsoft.Json.Formatting.None));
            var parts = path.Split('/'); var expected = parts.Length > 2 ? Uri.UnescapeDataString(parts[2]) : null;
            if (result == null || string.IsNullOrWhiteSpace(result.Id) || (expected != null && result.Id != expected) ||
                (result.State != "review" && result.State != "committed") ||
                (result.State == "committed" && string.IsNullOrWhiteSpace(result.Committed?.PackageId))) throw InvalidStream(path);
            return result;
        }
        private static ServiceException InvalidStream(string path) => new ServiceException(502, "invalid_reply",
            "The Mac returned an incomplete or invalid response. Processing may continue there. "
                + (path == "v1/sessions" ? "Reconnect USB before another capture." : "Reconnect USB before another turn."));
    }
}
