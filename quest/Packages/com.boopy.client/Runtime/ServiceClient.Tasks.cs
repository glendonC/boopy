#nullable enable
using System;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Boopy.Client
{
    /// <summary>Ids for the task routes, made on the headset: a prefix and 32 lowercase hex characters.</summary>
    public static class TaskIds
    {
        private static readonly Regex EventPattern = new Regex(@"^evt_[A-Za-z0-9_-]{1,64}\z", RegexOptions.CultureInvariant);
        private static readonly Regex TaskPattern = new Regex(@"^tsk_[A-Za-z0-9_-]{1,64}\z", RegexOptions.CultureInvariant);
        private static readonly Regex SessionPattern = new Regex(@"^[A-Za-z0-9_-]{1,128}\z", RegexOptions.CultureInvariant);

        public static string NewEventId() => "evt_" + Guid.NewGuid().ToString("N");
        public static string NewTaskId() => "tsk_" + Guid.NewGuid().ToString("N");

        internal static bool IsEvent(string? id) => id != null && EventPattern.IsMatch(id);
        internal static bool IsTask(string? id) => id != null && TaskPattern.IsMatch(id);
        internal static bool IsSession(string? id) => id != null && SessionPattern.IsMatch(id);
    }

    /// <summary>
    /// The headset task routes (docs/protocol.md). The ids are the caller's: a call never makes its
    /// own, so calling again with the same ids is the same event and the Mac records it once. Like
    /// every change here, a call sends once and never retries by itself. A view comes back as the
    /// JSON text the Mac sent, once <see cref="InteractionPresentation.Read"/>, the one parser,
    /// accepts it as this task's view.
    /// </summary>
    public sealed partial class ServiceClient
    {
        private const int TaskResponseLimit = 1024 * 1024;
        private const int TaskWavLimit = 44 + 2 * Wav.SampleRate * (int)Wav.MaxSeconds;
        private enum TaskWork { Open, Answer, Change, Read }

        /// <summary>
        /// Open this session's task, or get the one it already has. Null when the session has no
        /// task-ready turn (409 task_unavailable): that is no task, not an error.
        /// </summary>
        public Task<string?> OpenTaskAsync(string sessionId, string eventId, string taskId, CancellationToken cancel = default)
        {
            if (!TaskIds.IsSession(sessionId) || !TaskIds.IsEvent(eventId) || !TaskIds.IsTask(taskId))
                throw new ArgumentException("Opening a task needs a session, an event id and a task id.");
            return OpenTaskCoreAsync(sessionId, new JObject { ["eventId"] = eventId, ["taskId"] = taskId }, cancel);
        }

        /// <summary>Record a spoken answer against the revision the person saw. Only the WAV is sent, as base64.</summary>
        public Task<string> AnswerTaskAsync(string taskId, string sessionId, int expectedRevision, string eventId, byte[] wav,
            CancellationToken cancel = default)
        {
            RequireChange(taskId, sessionId, expectedRevision, eventId);
            if (wav == null || wav.Length == 0 || wav.Length > TaskWavLimit)
                throw new ArgumentException("An answer is one recorded WAV clip.");
            var body = new JObject
            {
                ["eventId"] = eventId, ["sessionId"] = sessionId, ["expectedRevision"] = expectedRevision,
                ["speech"] = new JObject { ["wav"] = Convert.ToBase64String(wav) },
            };
            // Recognition runs on the Mac, so an answer has the turn deadline rather than the control one.
            return ChangeTaskAsync(taskId, sessionId, expectedRevision, "answers", body, requestTimeout, TaskWork.Answer, cancel);
        }

        /// <summary>wrong_subject, save_for_later, retry or cancel, against the revision the person saw.</summary>
        public Task<string> ActOnTaskAsync(string taskId, string sessionId, int expectedRevision, string eventId, string action,
            CancellationToken cancel = default)
        {
            RequireChange(taskId, sessionId, expectedRevision, eventId);
            if (action != "wrong_subject" && action != "save_for_later" && action != "retry" && action != "cancel")
                throw new ArgumentException("A task action is wrong_subject, save_for_later, retry or cancel. Answers have their own route.");
            var body = new JObject
            {
                ["eventId"] = eventId, ["sessionId"] = sessionId, ["expectedRevision"] = expectedRevision,
                ["action"] = new JObject { ["type"] = action },
            };
            return ChangeTaskAsync(taskId, sessionId, expectedRevision, "actions", body, controlTimeout, TaskWork.Change, cancel);
        }

        /// <summary>The task's current view, or null when the Mac has no such task. Reading changes nothing.</summary>
        public Task<string?> ReadTaskAsync(string taskId, CancellationToken cancel = default)
        {
            if (!TaskIds.IsTask(taskId)) throw new ArgumentException("Choose a valid task.");
            return ReadTaskCoreAsync(taskId, cancel);
        }

        private async Task<string?> OpenTaskCoreAsync(string sessionId, JObject body, CancellationToken cancel)
        {
            string text;
            try
            {
                text = await TaskRequestAsync(HttpMethod.Post, $"v1/sessions/{Uri.EscapeDataString(sessionId)}/task", body,
                    controlTimeout, TaskWork.Open, cancel).ConfigureAwait(false);
            }
            catch (ServiceException refused) when (refused.Status == 409 && refused.Code == "task_unavailable")
            {
                return null;
            }
            // One task per session: the Mac may answer with the task it already has, under its own ids.
            if (TaskView(text).SessionId != sessionId) throw InvalidTask();
            return text;
        }

        private async Task<string?> ReadTaskCoreAsync(string taskId, CancellationToken cancel)
        {
            var text = await TaskRequestAsync(HttpMethod.Get, TaskPath(taskId), null, controlTimeout, TaskWork.Read, cancel).ConfigureAwait(false);
            if (text.Trim() == "null") return null;
            if (TaskView(text).TaskId != taskId) throw InvalidTask();
            return text;
        }

        private async Task<string> ChangeTaskAsync(string taskId, string sessionId, int expectedRevision, string route, JObject body,
            TimeSpan timeout, TaskWork work, CancellationToken cancel)
        {
            var text = await TaskRequestAsync(HttpMethod.Post, TaskPath(taskId) + "/" + route, body, timeout, work, cancel).ConfigureAwait(false);
            var view = TaskView(text);
            // An accepted change, or the replay of one, is a later revision of this same task;
            // an accepted answer is on it.
            if (view.TaskId != taskId || view.SessionId != sessionId || view.Revision <= expectedRevision
                || (work == TaskWork.Answer && view.LastAttempt == null))
                throw InvalidTask();
            return text;
        }

        private async Task<string> TaskRequestAsync(HttpMethod method, string path, JObject? body, TimeSpan timeout, TaskWork work,
            CancellationToken cancel)
        {
            if (body != null && !await HealthyAsync(cancel).ConfigureAwait(false))
                throw new ServiceException(503, "service_unavailable",
                    "The Mac is not reachable over USB. Reconnect the cable and restore the connection, then try again.");
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            deadline.CancelAfter(timeout);
            try
            {
                using var request = new HttpRequestMessage(method, path);
                if (body != null) request.Content = new StringContent(body.ToString(Formatting.None), Encoding.UTF8, "application/json");
                using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token).ConfigureAwait(false);
                deadline.Token.ThrowIfCancellationRequested();
                using var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
                using var bytes = new MemoryStream();
                var buffer = new byte[4096];
                var complete = true;
                while (true)
                {
                    var count = await stream.ReadAsync(buffer, 0, buffer.Length, deadline.Token).ConfigureAwait(false);
                    deadline.Token.ThrowIfCancellationRequested();
                    if (count == 0) break;
                    if (bytes.Length + count > TaskResponseLimit) { complete = false; break; }
                    bytes.Write(buffer, 0, count);
                }
                if (!response.IsSuccessStatusCode)
                {
                    ErrorDetail? error = null;
                    try { if (complete) error = Wire.Read<ErrorBody>(new UTF8Encoding(false, true).GetString(bytes.ToArray())).Error; }
                    catch (JsonException) { }
                    catch (DecoderFallbackException) { }
                    var code = error?.Code;
                    throw new ServiceException((int)response.StatusCode,
                        !string.IsNullOrWhiteSpace(code) && code!.Length <= 80 ? code : "http_error",
                        !string.IsNullOrWhiteSpace(error?.Message) && error!.Message.Length <= 500 ? error.Message : $"The Mac answered {(int)response.StatusCode}.");
                }
                if (!complete) throw InvalidTask();
                return new UTF8Encoding(false, true).GetString(bytes.ToArray());
            }
            catch (OperationCanceledException) when (!cancel.IsCancellationRequested)
            {
                throw new ServiceException(408, "request_timeout", TaskWords(work, true));
            }
            catch (HttpRequestException) { cancel.ThrowIfCancellationRequested(); throw new ServiceException(503, "connection_lost", TaskWords(work, false)); }
            catch (IOException) { cancel.ThrowIfCancellationRequested(); throw new ServiceException(503, "connection_lost", TaskWords(work, false)); }
            catch (DecoderFallbackException) { throw InvalidTask(); }
        }

        private static void RequireChange(string taskId, string sessionId, int expectedRevision, string eventId)
        {
            if (!TaskIds.IsTask(taskId) || !TaskIds.IsSession(sessionId) || !TaskIds.IsEvent(eventId) || expectedRevision < 0)
                throw new ArgumentException("A task change needs its task, its session, the revision it was made against and an event id.");
        }

        private static InteractionPresentation TaskView(string text)
        {
            try { return InteractionPresentation.Read(text); }
            catch (ArgumentException) { throw InvalidTask(); }
        }

        private static string TaskPath(string taskId) => "v1/tasks/" + Uri.EscapeDataString(taskId);

        private static string TaskWords(TaskWork work, bool timedOut) => work switch
        {
            TaskWork.Open => timedOut ? "Opening this task on the Mac timed out." : "The Mac connection was interrupted while opening this task.",
            TaskWork.Answer => timedOut ? "The Mac did not answer in time. Your answer may still be recorded there."
                : "The Mac connection was interrupted. Your answer may still be recorded there.",
            TaskWork.Change => timedOut ? "The Mac did not answer in time. This change may still be recorded there."
                : "The Mac connection was interrupted. This change may still be recorded there.",
            _ => timedOut ? "Checking this task on the Mac timed out." : "The Mac connection was interrupted while checking this task.",
        };

        private static ServiceException InvalidTask() =>
            new ServiceException(502, "invalid_reply", "The Mac returned an invalid task. Nothing on the headset changed.");
    }
}
