#nullable enable
using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Boopy.Client
{
    /// <summary>Opaque identity of the person's one deliberately selected preparation. No content or geometry.</summary>
    public sealed class HandoffRecoveryRecord
    {
        public string SessionId { get; set; } = "";
        public string RequestId { get; set; } = "";
        public string? PackageId { get; set; }
        [JsonIgnore]
        public bool Valid => Regex.IsMatch(SessionId ?? "", "\\A[a-zA-Z0-9_-]{1,160}\\z")
            && Guid.TryParseExact(RequestId, "D", out var id) && RequestId == id.ToString("D")
            && (PackageId == null || HandoffWords.Package(PackageId));
    }

    /// <summary>Atomic bounded ID-only cache in an app-private directory; the Mac journal remains authoritative.</summary>
    public sealed class HandoffRecoveryStore
    {
        private readonly string path;
        public HandoffRecoveryStore(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) throw new ArgumentException("A private record path is required.", nameof(path));
            this.path = Path.GetFullPath(path);
        }
        public HandoffRecoveryRecord? Load()
        {
            FileStream file;
            try { file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read); }
            catch (FileNotFoundException) { return null; }
            catch (DirectoryNotFoundException) { return null; }
            using (file)
            {
                var bytes = new byte[1025]; var count = 0;
                while (count < bytes.Length)
                {
                    var read = file.Read(bytes, count, bytes.Length - count);
                    if (read == 0) break;
                    count += read;
                }
                if (count > 1024) throw new InvalidDataException("Preparation identity record is too large.");
                var text = new UTF8Encoding(false, true).GetString(bytes, 0, count);
                var document = JObject.Parse(text, new JsonLoadSettings { DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error });
                if (document.Properties().Any(property => property.Name != "sessionId" && property.Name != "requestId" && property.Name != "packageId")
                    || document["sessionId"]?.Type != JTokenType.String || document["requestId"]?.Type != JTokenType.String
                    || (document["packageId"] != null && document["packageId"]!.Type != JTokenType.String && document["packageId"]!.Type != JTokenType.Null))
                    throw new InvalidDataException("Preparation identity record is invalid.");
                var record = Wire.Read<HandoffRecoveryRecord>(text);
                Validate(record);
                return record;
            }
        }
        public void Save(HandoffRecoveryRecord record)
        {
            Validate(record);
            var directory = Path.GetDirectoryName(path)!; Directory.CreateDirectory(directory);
            var temporary = Path.Combine(directory, ".handoff-recovery-" + Guid.NewGuid().ToString("N"));
            try
            {
                using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    var bytes = Encoding.ASCII.GetBytes(Wire.Write(record));
                    file.Write(bytes, 0, bytes.Length); file.Flush(true);
                }
                if (File.Exists(path)) File.Replace(temporary, path, null);
                else File.Move(temporary, path);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
        public void Clear()
        {
            try { File.Delete(path); }
            catch (DirectoryNotFoundException) { }
        }
        private static void Validate(HandoffRecoveryRecord record)
        {
            if (record == null || !record.Valid) throw new InvalidDataException("Preparation identity record is invalid.");
        }
    }
}
