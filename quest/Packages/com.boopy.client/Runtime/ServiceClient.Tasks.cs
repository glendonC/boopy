#nullable enable
using System;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

namespace Boopy.Client
{
    /// <summary>Ids for the task routes: a prefix and up to 64 id characters.</summary>
    public static class TaskIds
    {
        private static readonly Regex EventPattern = new Regex(@"^evt_[A-Za-z0-9_-]{1,64}\z", RegexOptions.CultureInvariant);
        private static readonly Regex TaskPattern = new Regex(@"^tsk_[A-Za-z0-9_-]{1,64}\z", RegexOptions.CultureInvariant);
        private static readonly Regex SessionPattern = new Regex(@"^[A-Za-z0-9_-]{1,128}\z", RegexOptions.CultureInvariant);

        internal static bool IsEvent(string? id) => id != null && EventPattern.IsMatch(id);
        internal static bool IsTask(string? id) => id != null && TaskPattern.IsMatch(id);
        internal static bool IsSession(string? id) => id != null && SessionPattern.IsMatch(id);
    }

    /// <summary>
    /// The headset's task calls. A returned view is accepted only when it stays not-sent.
    /// Calling again with the same ids is the same event.
    /// </summary>
    public sealed partial class ServiceClient
    {
        public async Task<string?> OpenTaskAsync(string sessionId, string eventId, string taskId, CancellationToken cancel = default)
        {
            if (!TaskIds.IsSession(sessionId) || !TaskIds.IsEvent(eventId) || !TaskIds.IsTask(taskId))
                throw new ArgumentException("Opening a task needs a session, an event id and a task id.");
            var body = new JObject { ["eventId"] = eventId, ["taskId"] = taskId };
            var text = await SendTaskAsync(HttpMethod.Post, "v1/sessions/" + Uri.EscapeDataString(sessionId) + "/task", body, cancel).ConfigureAwait(false);
            if (text == null) return null;
            var view = AcceptedView(text);
            if (view.SessionId != sessionId) throw InvalidTask();
            return text;
        }

        public async Task<string> ActOnTaskAsync(string taskId, string sessionId, int expectedRevision, string eventId, string action,
            CancellationToken cancel = default)
        {
            if (!TaskIds.IsTask(taskId) || !TaskIds.IsSession(sessionId) || !TaskIds.IsEvent(eventId) || expectedRevision < 0)
                throw new ArgumentException("A task change needs its task, its session, the revision it was made against and an event id.");
            if (action != "wrong_subject" && action != "save_for_later" && action != "retry" && action != "cancel")
                throw new ArgumentException("A task action is wrong_subject, save_for_later, retry or cancel. Answers have their own route.");
            var body = new JObject
            {
                ["eventId"] = eventId,
                ["sessionId"] = sessionId,
                ["expectedRevision"] = expectedRevision,
                ["action"] = new JObject { ["type"] = action },
            };
            var text = await SendTaskAsync(HttpMethod.Post, "v1/tasks/" + Uri.EscapeDataString(taskId) + "/actions", body, cancel).ConfigureAwait(false);
            if (text == null) throw InvalidTask();
            var view = AcceptedView(text);
            if (view.TaskId != taskId || view.SessionId != sessionId) throw InvalidTask();
            return text;
        }

        private async Task<string?> SendTaskAsync(HttpMethod method, string path, JObject body, CancellationToken cancel)
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            deadline.CancelAfter(controlTimeout);
            try
            {
                using var request = new HttpRequestMessage(method, path);
                request.Content = new StringContent(body.ToString(Newtonsoft.Json.Formatting.None), Encoding.UTF8, "application/json");
                using var response = await http.SendAsync(request, deadline.Token).ConfigureAwait(false);
                deadline.Token.ThrowIfCancellationRequested();
                var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                deadline.Token.ThrowIfCancellationRequested();
                if (!response.IsSuccessStatusCode)
                {
                    string? code = null;
                    try { code = JObject.Parse(text)["error"]?["code"]?.Value<string>(); }
                    catch (Newtonsoft.Json.JsonException) { }
                    if ((int)response.StatusCode == 409 && code == "task_unavailable") return null;
                    throw new ServiceException((int)response.StatusCode,
                        string.IsNullOrWhiteSpace(code) ? "http_error" : code!,
                        "The Mac refused this task.");
                }
                return text;
            }
            catch (OperationCanceledException) when (!cancel.IsCancellationRequested)
            {
                throw new ServiceException(408, "request_timeout", "The Mac did not answer in time.");
            }
            catch (HttpRequestException)
            {
                cancel.ThrowIfCancellationRequested();
                throw new ServiceException(503, "connection_lost", "The Mac connection was interrupted.");
            }
        }

        private static InteractionPresentation AcceptedView(string text)
        {
            try { return InteractionPresentation.Read(text); }
            catch (ArgumentException) { throw InvalidTask(); }
        }

        private static ServiceException InvalidTask() =>
            new ServiceException(502, "invalid_reply", "The Mac returned an invalid task. Nothing on the headset changed.");
    }
}
