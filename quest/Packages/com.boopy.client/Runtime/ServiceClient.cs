#nullable enable
using System;
using System.Net.Http;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Boopy.Client
{
    /// <summary>A refusal from the service, with its code and a line for the person.</summary>
    public sealed class ServiceException : Exception
    {
        public ServiceException(int status, string code, string message) : base(message)
        {
            Status = status;
            Code = code;
        }

        public int Status { get; }
        public string Code { get; }
    }

    /// <summary>
    /// The headset's side of the service API. Over USB the service is at
    /// 127.0.0.1 through adb reverse. HttpClient works under IL2CPP on the Quest 3.
    /// A short health check detects a dropped USB reverse mapping before
    /// a capture is sent. Mutations have bounded deadlines and are never retried automatically.
    /// </summary>
    public sealed partial class ServiceClient : IDisposable
    {
        public const string DefaultBaseUrl = "http://127.0.0.1:47900";

        private readonly HttpClient http;
        private readonly TimeSpan requestTimeout;
        private readonly TimeSpan controlTimeout;
        private readonly TimeSpan healthTimeout;
        private readonly TimeSpan speechTimeout;

        public ServiceClient(string baseUrl = DefaultBaseUrl, HttpMessageHandler? handler = null,
            TimeSpan? requestTimeout = null, TimeSpan? healthTimeout = null,
            TimeSpan? controlTimeout = null, TimeSpan? speechTimeout = null)
        {
            // Local neural speech can reload after cancellation (measured 8.6–20.1 seconds).
            // Captions remain immediate; a new action still cancels this independent wait.
            this.speechTimeout = Deadline(speechTimeout ?? TimeSpan.FromSeconds(30), nameof(speechTimeout));
            this.requestTimeout = Deadline(requestTimeout ?? TimeSpan.FromSeconds(45), nameof(requestTimeout));
            this.healthTimeout = Deadline(healthTimeout ?? TimeSpan.FromSeconds(3), nameof(healthTimeout));
            this.controlTimeout = Deadline(controlTimeout ?? TimeSpan.FromSeconds(10), nameof(controlTimeout));
            http = handler == null ? new HttpClient() : new HttpClient(handler);
            http.BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/");
            // Each operation owns its deadline, including all response bytes, so caller cancellation
            // remains distinguishable from a timeout instead of sharing HttpClient's global timer.
            http.Timeout = Timeout.InfiniteTimeSpan;
        }

        public async Task<SessionView> StartAsync(StartSessionRequest request, CancellationToken cancel = default)
        {
            if (request.RequestId != null && !Guid.TryParse(request.RequestId, out _))
                throw new ArgumentException("Session start requires a valid request UUID.");
            try
            {
                return await PostAsync("v1/sessions", request, requestTimeout, cancel).ConfigureAwait(false);
            }
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
                // A missing, unfinished or mismatched receipt does not establish success.
                throw;
            }
        }

        public async Task<StartRecoveryView> ReadStartAsync(string requestId, CancellationToken cancel = default)
        {
            if (!Guid.TryParse(requestId, out _)) throw new ArgumentException("Session start requires a valid request UUID.");
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            deadline.CancelAfter(controlTimeout);
            try
            {
                using var response = await http.GetAsync($"v1/session-starts/{Uri.EscapeDataString(requestId)}", deadline.Token).ConfigureAwait(false);
                deadline.Token.ThrowIfCancellationRequested();
                if (!response.IsSuccessStatusCode)
                    throw new ServiceException((int)response.StatusCode, "start_read_failed", "Could not check this capture on the Mac.");
                var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                deadline.Token.ThrowIfCancellationRequested();
                return Wire.Read<StartRecoveryView>(text);
            }
            catch (OperationCanceledException) when (!cancel.IsCancellationRequested)
            {
                throw new ServiceException(408, "start_read_timeout", "Checking this capture on the Mac timed out.");
            }
            catch (HttpRequestException)
            {
                cancel.ThrowIfCancellationRequested();
                throw new ServiceException(503, "start_read_failed", "The Mac connection was interrupted while checking this capture.");
            }
        }

        public Task<SessionView> UtterAsync(string sessionId, UtteranceRequest request, CancellationToken cancel = default) =>
            PostAsync($"v1/sessions/{Uri.EscapeDataString(sessionId)}/utterances", request, requestTimeout, cancel);

        /// <summary>Select one exact proposed question from its originating journaled response.</summary>
        public Task<SessionView> FollowUpAsync(string sessionId, DialogueView originating,
            ContextualAction action, CancellationToken cancel = default)
            => UtterAsync(sessionId, FollowUpRequest(sessionId, originating, action), cancel);

        private static UtteranceRequest FollowUpRequest(string sessionId, DialogueView originating, ContextualAction action)
        {
            if (string.IsNullOrWhiteSpace(sessionId) || originating == null || action == null ||
                originating.Speaker != "boopy" || string.IsNullOrWhiteSpace(originating.UtteranceId) ||
                string.IsNullOrWhiteSpace(originating.At) || string.IsNullOrWhiteSpace(action.Id) ||
                string.IsNullOrWhiteSpace(action.Question) || action.Question.Length > 2000 ||
                (action.TargetItemId != null && string.IsNullOrWhiteSpace(action.TargetItemId)) ||
                (action.ObservationId != null && string.IsNullOrWhiteSpace(action.ObservationId)) ||
                originating.Actions == null)
                throw new ArgumentException("A follow-up requires its exact originating response and question.");
            var matches = originating.Actions.Where(candidate => candidate != null && candidate.Id == action.Id).ToArray();
            if (matches.Length != 1 || matches[0].Question != action.Question ||
                matches[0].TargetItemId != action.TargetItemId || matches[0].ObservationId != action.ObservationId)
                throw new ArgumentException("The question does not match its originating response.");
            return new UtteranceRequest
            {
                Speech = new SpeechData { Text = action.Question },
                Cues = action.TargetItemId == null ? null : new Cues { TargetItemId = action.TargetItemId },
                Selection = new ContextualActionSelection
                {
                    UtteranceId = originating.UtteranceId, ResponseAt = originating.At, ActionId = action.Id,
                },
            };
        }

        public Task<SessionView> ActAsync(string sessionId, ActionRequest request, CancellationToken cancel = default) =>
            PostAsync($"v1/sessions/{Uri.EscapeDataString(sessionId)}/actions", request, controlTimeout, cancel);

        /// <summary>Speak only an already journaled Boopy response, with exact turn/time association.</summary>
        public async Task<SpeechOutputResponse> SpeechAsync(string sessionId, SpeechOutputRequest request, CancellationToken cancel = default)
        {
            if (string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(request.UtteranceId) || string.IsNullOrWhiteSpace(request.ResponseAt))
                throw new ArgumentException("Speech requires a session, utterance and response time.");
            if (!await HealthyAsync(cancel).ConfigureAwait(false))
                throw new ServiceException(503, "speech_unavailable", "Speech is unavailable. Read the Boopy caption instead.");
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            deadline.CancelAfter(speechTimeout);
            try
            {
                using var content = new StringContent(Wire.Write(request), Encoding.UTF8, "application/json");
                using var response = await http.PostAsync($"v1/sessions/{Uri.EscapeDataString(sessionId)}/speech", content, deadline.Token).ConfigureAwait(false);
                var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                deadline.Token.ThrowIfCancellationRequested();
                if (!response.IsSuccessStatusCode)
                    throw new ServiceException((int)response.StatusCode, "speech_unavailable", "Speech is unavailable for this response. Read the Boopy caption instead.");
                var result = Wire.Read<SpeechOutputResponse>(text);
                if (result.SessionId != sessionId || result.UtteranceId != request.UtteranceId || result.ResponseAt != request.ResponseAt || result.Speaker != "boopy" || result.MimeType != "audio/wav")
                    throw new ServiceException(502, "speech_invalid", "Speech did not match this Boopy response. Read the caption instead.");
                if (string.IsNullOrWhiteSpace(result.Wav) || result.Wav.Length > 2796204)
                    throw new ServiceException(502, "speech_invalid", "Speech audio was invalid or too large. Read the Boopy caption instead.");
                return result;
            }
            catch (OperationCanceledException) when (!cancel.IsCancellationRequested)
            {
                throw new ServiceException(408, "speech_timeout", "Speech took too long. Read the Boopy caption instead.");
            }
            catch (HttpRequestException)
            {
                throw new ServiceException(503, "speech_unavailable", "Speech connection was interrupted. Read the Boopy caption instead.");
            }
            catch (Newtonsoft.Json.JsonException)
            {
                throw new ServiceException(502, "speech_invalid", "Speech response was invalid. Read the Boopy caption instead.");
            }
        }

        public async Task<SessionView> CommitAsync(string sessionId, CancellationToken cancel = default)
        {
            try
            {
                return await PostAsync($"v1/sessions/{Uri.EscapeDataString(sessionId)}/commit", new { }, controlTimeout, cancel, requireCommit: true).ConfigureAwait(false);
            }
            catch (ServiceException failure) when (failure.Code == "connection_lost" || failure.Code == "request_timeout" || failure.Code == "committed" || failure.Code == "invalid_reply")
            {
                cancel.ThrowIfCancellationRequested();
                try
                {
                    // A lost response may conceal a completed save. Read its actual state once;
                    // replaying a mutation would not establish whether the first save succeeded.
                    var current = await ReadSessionAsync(sessionId, cancel).ConfigureAwait(false);
                    if (current.Id == sessionId && current.State == "committed" && !string.IsNullOrWhiteSpace(current.Committed?.PackageId)) return current;
                }
                catch (ServiceException) { }
                catch (Newtonsoft.Json.JsonException) { }
                // Read failure or an unsaved projection cannot turn an uncertain save into success.
                throw;
            }
        }

        public async Task<SessionView> ReadSessionAsync(string sessionId, CancellationToken cancel = default)
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            deadline.CancelAfter(controlTimeout);
            try
            {
                using var response = await http.GetAsync($"v1/sessions/{Uri.EscapeDataString(sessionId)}", deadline.Token).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode)
                    throw new ServiceException((int)response.StatusCode, "session_read_failed", "Could not check this context on the Mac.");
                var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                deadline.Token.ThrowIfCancellationRequested();
                return Wire.Read<SessionView>(text);
            }
            catch (OperationCanceledException) when (!cancel.IsCancellationRequested)
            {
                throw new ServiceException(408, "session_read_timeout", "Checking this context on the Mac timed out.");
            }
            catch (HttpRequestException)
            {
                throw new ServiceException(503, "session_read_failed", "The Mac connection was interrupted while checking this context.");
            }
        }

        public async Task<bool> HealthyAsync(CancellationToken cancel = default) =>
            await ReadHealthAsync(cancel).ConfigureAwait(false) != null;

        public async Task<HealthView?> ReadHealthAsync(CancellationToken cancel = default)
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            deadline.CancelAfter(healthTimeout);
            HealthView? health = null;
            try
            {
                using var response = await http.GetAsync("v1/health", deadline.Token).ConfigureAwait(false);
                deadline.Token.ThrowIfCancellationRequested();
                if (response.IsSuccessStatusCode)
                {
                    var parsed = Wire.Read<HealthView>(await response.Content.ReadAsStringAsync().ConfigureAwait(false));
                    deadline.Token.ThrowIfCancellationRequested();
                    if (parsed != null && parsed.Valid) health = parsed;
                }
            }
            catch (HttpRequestException) { }
            catch (Newtonsoft.Json.JsonException) { }
            catch (OperationCanceledException) when (!cancel.IsCancellationRequested) { }
            cancel.ThrowIfCancellationRequested();
            return health;
        }

        private async Task<SessionView> PostAsync(string path, object body, TimeSpan timeout, CancellationToken cancel, bool requireCommit = false)
        {
            if (!await HealthyAsync(cancel).ConfigureAwait(false))
                throw new ServiceException(503, "service_unavailable",
                    "The Mac is not reachable over USB. Reconnect the cable and restore the connection, then try again.");
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            deadline.CancelAfter(timeout);
            try
            {
                using var content = new StringContent(Wire.Write(body), Encoding.UTF8, "application/json");
                using var response = await http.PostAsync(path, content, deadline.Token).ConfigureAwait(false);
                var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                // A completed response cannot override an explicit stop, even if transport ignored cancellation.
                deadline.Token.ThrowIfCancellationRequested();
                if (!response.IsSuccessStatusCode)
                {
                    ErrorDetail? error = null;
                    try
                    {
                        error = Wire.Read<ErrorBody>(text).Error;
                    }
                    catch (Newtonsoft.Json.JsonException)
                    {
                    }
                    throw new ServiceException((int)response.StatusCode, error?.Code ?? "http_error",
                        error?.Message ?? $"The Mac answered {(int)response.StatusCode}.");
                }
                var view = Wire.Read<SessionView>(text);
                var parts = path.Split('/');
                var expectedId = parts.Length > 2 ? Uri.UnescapeDataString(parts[2]) : null;
                if (string.IsNullOrWhiteSpace(view.Id) || (expectedId != null && view.Id != expectedId) ||
                    (view.State != "review" && view.State != "committed") ||
                    (view.State == "committed" && string.IsNullOrWhiteSpace(view.Committed?.PackageId)) ||
                    (requireCommit && view.State != "committed"))
                    throw new ServiceException(502, "invalid_reply", "The Mac returned an invalid receipt. Processing may still finish there; check before trying again.");
                return view;
            }
            catch (OperationCanceledException) when (!cancel.IsCancellationRequested)
            {
                throw new ServiceException(408, "request_timeout", UncertainResponse(path, true));
            }
            catch (HttpRequestException)
            {
                throw new ServiceException(503, "connection_lost", UncertainResponse(path, false));
            }
        }

        private static string UncertainResponse(string path, bool timedOut) =>
            path.EndsWith("/commit", StringComparison.Ordinal)
                ? "Could not verify that the context is ready. It may already be prepared on the Mac. Reconnect USB before trying Use this context again."
                : timedOut
                    ? "The Mac response timed out. Processing may continue there. Reconnect USB before another capture."
                    : "The Mac connection was interrupted. Processing may continue there. Reconnect USB before another capture.";

        private static TimeSpan Deadline(TimeSpan value, string name)
        {
            if (value <= TimeSpan.Zero || value > TimeSpan.FromMinutes(5))
                throw new ArgumentOutOfRangeException(name, "A request deadline must be positive and at most five minutes.");
            return value;
        }

        public void Dispose() => http.Dispose();
    }
}
