#nullable enable
using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Boopy.Client
{
    public sealed partial class ServiceClient
    {
        /// <summary>The recorded scene the Mac shows, or null when it shows none, has the routes off or predates them.</summary>
        public async Task<RecordedSceneView?> ReadRecordedSceneAsync(CancellationToken cancel = default)
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            deadline.CancelAfter(controlTimeout);
            try
            {
                using var response = await http.GetAsync("v1/recorded-scene", deadline.Token).ConfigureAwait(false);
                deadline.Token.ThrowIfCancellationRequested();
                if (response.StatusCode == HttpStatusCode.NotFound) return null;
                if (!response.IsSuccessStatusCode)
                    throw new ServiceException((int)response.StatusCode, "recorded_scene_failed", "Could not read the recorded scene on the Mac.");
                var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                deadline.Token.ThrowIfCancellationRequested();
                RecordedSceneEnvelope envelope;
                try { envelope = Wire.Read<RecordedSceneEnvelope>(text); }
                catch (Newtonsoft.Json.JsonException) { throw InvalidScene(); }
                if (envelope.Scene == null) return null;
                if (!RecordedScenes.Valid(envelope.Scene)) throw InvalidScene();
                return envelope.Scene;
            }
            catch (OperationCanceledException) when (!cancel.IsCancellationRequested)
            {
                throw new ServiceException(408, "recorded_scene_timeout", "Reading the recorded scene on the Mac timed out.");
            }
            catch (HttpRequestException)
            {
                throw new ServiceException(503, "recorded_scene_failed", "The Mac connection was interrupted while reading the recorded scene.");
            }
        }

        /// <summary>One still's exact bytes, checked against the digest its scene named. Held in memory only.</summary>
        public async Task<byte[]> ReadRecordedFrameAsync(string frameId, string frameSha256, CancellationToken cancel = default)
        {
            if (!RecordedScenes.IsFrameId(frameId) || !RecordedScenes.IsDigest(frameSha256))
                throw new ArgumentException("A recorded still needs the frame id and digest its scene named.");
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            deadline.CancelAfter(controlTimeout);
            try
            {
                using var response = await http.GetAsync("v1/recorded-scene/frames/" + frameId, HttpCompletionOption.ResponseHeadersRead, deadline.Token).ConfigureAwait(false);
                deadline.Token.ThrowIfCancellationRequested();
                if (response.StatusCode == HttpStatusCode.NotFound)
                    throw new ServiceException(404, "recorded_frame_unknown", "That recorded still is no longer on the Mac.");
                if (!response.IsSuccessStatusCode)
                    throw new ServiceException((int)response.StatusCode, "recorded_frame_failed", "Could not read the recorded still on the Mac.");
                if (response.Content.Headers.ContentType?.MediaType != "image/jpeg"
                    || response.Content.Headers.ContentLength > RecordedScenes.MaxFrameBytes) throw InvalidFrame();
                using var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
                using var bytes = new MemoryStream();
                var buffer = new byte[16384];
                while (true)
                {
                    var read = await stream.ReadAsync(buffer, 0, buffer.Length, deadline.Token).ConfigureAwait(false);
                    deadline.Token.ThrowIfCancellationRequested();
                    if (read == 0) break;
                    if (bytes.Length + read > RecordedScenes.MaxFrameBytes) throw InvalidFrame();
                    bytes.Write(buffer, 0, read);
                }
                var still = bytes.ToArray();
                if (still.Length < 4 || still[0] != 0xff || still[1] != 0xd8 || still[2] != 0xff) throw InvalidFrame();
                if (Hex(still) != frameSha256)
                    throw new ServiceException(502, "recorded_frame_mismatch", "The recorded still did not match the one the Mac named.");
                return still;
            }
            catch (OperationCanceledException) when (!cancel.IsCancellationRequested)
            {
                throw new ServiceException(408, "recorded_frame_timeout", "Reading the recorded still on the Mac timed out.");
            }
            catch (HttpRequestException)
            {
                throw new ServiceException(503, "recorded_frame_failed", "The Mac connection was interrupted while reading the recorded still.");
            }
        }

        private static ServiceException InvalidScene() =>
            new ServiceException(502, "recorded_scene_invalid", "The Mac sent a recorded scene the headset cannot show.");

        private static ServiceException InvalidFrame() =>
            new ServiceException(502, "recorded_frame_invalid", "The Mac sent a recorded still the headset cannot show.");

        private static string Hex(byte[] bytes)
        {
            using var sha = SHA256.Create();
            var digest = sha.ComputeHash(bytes);
            var text = new StringBuilder(digest.Length * 2);
            foreach (var value in digest) text.Append(value.ToString("x2"));
            return text.ToString();
        }
    }
}
