#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Boopy.Client
{
    /// <summary>
    /// The headset activity routes (docs/activity-contract.md). Every change names the
    /// revision it was made against; a stale one is refused with 409 stale_activity and changes
    /// nothing. Changes are never retried: after a lost response, read the activity again.
    /// </summary>
    public sealed partial class ServiceClient
    {
        private const int ActivityResponseLimit = 1024 * 1024;

        /// <summary>Imported activities, newest first. Reading changes nothing.</summary>
        public async Task<List<ActivitySummary>> ListActivitiesAsync(CancellationToken cancel = default)
        {
            var list = await ActivityRequestAsync<ActivityList>(HttpMethod.Get, "v1/activities", null, cancel).ConfigureAwait(false);
            if (!list.Valid) throw InvalidActivity();
            return list.Activities!;
        }

        public async Task<ActivityView> ReadActivityAsync(string activityId, CancellationToken cancel = default)
        {
            if (!ActivityRules.Activity(activityId)) throw new ArgumentException("Choose a valid activity.");
            var view = await ActivityRequestAsync<ActivityView>(HttpMethod.Get, ActivityPath(activityId), null, cancel).ConfigureAwait(false);
            if (!view.ValidFor(activityId)) throw InvalidActivity();
            return view;
        }

        /// <summary>Record every token's position, exactly this activity's keys; null leaves a token not placed.</summary>
        public Task<ActivityView> ArrangeActivityAsync(ActivityView current, IReadOnlyDictionary<string, double?> positions,
            CancellationToken cancel = default)
        {
            var tokens = Changeable(current).Arrange?.Tokens;
            if (tokens == null || positions == null || positions.Count != tokens.Count
                || tokens.Any(token => !positions.TryGetValue(token.Key, out var position) || (position.HasValue && !ActivityRules.Unit(position.Value))))
                throw new ArgumentException("An arrangement names every token of its activity, each not placed or from 0 to 1.");
            var recorded = new JObject();
            foreach (var token in tokens)
                recorded[token.Key] = positions[token.Key].HasValue ? new JValue(positions[token.Key]!.Value) : JValue.CreateNull();
            return ChangeActivityAsync(current, "arrangement", new JObject { ["revision"] = current.Revision!.Value, ["positions"] = recorded }, cancel);
        }

        /// <summary>Record the person's ordered row: distinct tile keys of this activity.</summary>
        public Task<ActivityView> SequenceActivityAsync(ActivityView current, IReadOnlyList<string> chosen, CancellationToken cancel = default)
        {
            var tiles = Changeable(current).Sequence?.Tiles;
            if (tiles == null || chosen == null || chosen.Distinct().Count() != chosen.Count || chosen.Any(key => tiles.All(tile => tile.Key != key)))
                throw new ArgumentException("A sequence names distinct tiles of its activity.");
            return ChangeActivityAsync(current, "sequence", new JObject { ["revision"] = current.Revision!.Value, ["chosen"] = new JArray(chosen) }, cancel);
        }

        /// <summary>Reveal the next hint, in order.</summary>
        public Task<ActivityView> RevealActivityHintAsync(ActivityView current, CancellationToken cancel = default) =>
            ChangeActivityAsync(Changeable(current), "hints", new JObject { ["revision"] = current.Revision!.Value }, cancel);

        /// <summary>Freeze what the person did into a numbered submission. Nothing is sent anywhere.</summary>
        public Task<ActivityView> SubmitActivityAsync(ActivityView current, CancellationToken cancel = default) =>
            ChangeActivityAsync(Changeable(current), "submissions", new JObject { ["revision"] = current.Revision!.Value }, cancel);

        private static ActivityView Changeable(ActivityView current)
        {
            if (current == null || !current.ValidFor(null) || !current.Renderable)
                throw new ArgumentException("Only an active activity this headset can show can be changed.");
            return current;
        }

        private async Task<ActivityView> ChangeActivityAsync(ActivityView current, string route, JObject body, CancellationToken cancel)
        {
            if (!await HealthyAsync(cancel).ConfigureAwait(false))
                throw new ServiceException(503, "service_unavailable",
                    "The Mac is not reachable over USB. Reconnect the cable and restore the connection, then try again.");
            var view = await ActivityRequestAsync<ActivityView>(HttpMethod.Post, ActivityPath(current.ActivityId) + "/" + route, body, cancel)
                .ConfigureAwait(false);
            if (!view.ValidFor(current.ActivityId) || view.Revision < current.Revision) throw InvalidActivity();
            return view;
        }

        private async Task<T> ActivityRequestAsync<T>(HttpMethod method, string path, JObject? body, CancellationToken cancel) where T : class
        {
            var change = body != null;
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            deadline.CancelAfter(controlTimeout);
            try
            {
                using var request = new HttpRequestMessage(method, path);
                if (change) request.Content = new StringContent(body!.ToString(Formatting.None), Encoding.UTF8, "application/json");
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
                    if (bytes.Length + count > ActivityResponseLimit) { complete = false; break; }
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
                if (!complete) throw InvalidActivity();
                // Timestamps stay the exact strings the service sent; duplicate names are refused.
                using var reader = new JsonTextReader(new StringReader(new UTF8Encoding(false, true).GetString(bytes.ToArray())))
                    { DateParseHandling = DateParseHandling.None };
                var value = JToken.ReadFrom(reader, new JsonLoadSettings { DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error });
                if (value.Type != JTokenType.Object || reader.Read()) throw InvalidActivity();
                return value.ToObject<T>(JsonSerializer.Create(Wire.Settings)) ?? throw InvalidActivity();
            }
            catch (OperationCanceledException) when (!cancel.IsCancellationRequested)
            {
                throw new ServiceException(408, "request_timeout", change
                    ? "The Mac did not answer in time. This change may have been saved there. Check the activity before changing it again."
                    : "Checking activities on the Mac timed out.");
            }
            catch (HttpRequestException) { cancel.ThrowIfCancellationRequested(); throw ActivityConnectionLost(change); }
            catch (IOException) { cancel.ThrowIfCancellationRequested(); throw ActivityConnectionLost(change); }
            catch (JsonException) { throw InvalidActivity(); }
            catch (DecoderFallbackException) { throw InvalidActivity(); }
        }

        private static string ActivityPath(string activityId) => "v1/activities/" + Uri.EscapeDataString(activityId);

        private static ServiceException ActivityConnectionLost(bool change) => new ServiceException(503, "connection_lost", change
            ? "The Mac connection was interrupted. This change may have been saved there. Check the activity before changing it again."
            : "The Mac connection was interrupted while checking activities.");

        private static ServiceException InvalidActivity() =>
            new ServiceException(502, "invalid_reply", "The Mac returned an invalid activity. Nothing on the headset changed.");
    }
}
