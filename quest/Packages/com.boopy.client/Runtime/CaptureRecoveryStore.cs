#nullable enable
using System;
using System.IO;
using System.Text;

namespace Boopy.Client
{
    /// <summary>Stores only an unresolved capture UUID. The caller supplies an app-private directory.
    /// .NET Standard 2.1 has no portable file permission API; directory privacy is a host boundary.</summary>
    public sealed class CaptureRecoveryStore
    {
        private readonly string path;
        public CaptureRecoveryStore(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) throw new ArgumentException("A private record path is required.", nameof(path));
            this.path = Path.GetFullPath(path);
        }
        public string? Load()
        {
            FileStream file;
            try { file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read); }
            catch (FileNotFoundException) { return null; }
            catch (DirectoryNotFoundException) { return null; }
            using (file)
            {
                var bytes = new byte[129];
                var count = 0;
                while (count < bytes.Length)
                {
                    var read = file.Read(bytes, count, bytes.Length - count);
                    if (read == 0) break;
                    count += read;
                }
                if (count > 128) throw new InvalidDataException("Recovery record is too large.");
                // UUID records are ASCII; decoding malformed bytes must never replace them silently.
                var id = new UTF8Encoding(false, true).GetString(bytes, 0, count);
                Validate(id);
                return id;
            }
        }
        public void Save(string requestId)
        {
            Validate(requestId);
            var directory = Path.GetDirectoryName(path)!;
            Directory.CreateDirectory(directory);
            var temporary = Path.Combine(directory, ".capture-recovery-" + Guid.NewGuid().ToString("N"));
            try
            {
                using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    var bytes = Encoding.ASCII.GetBytes(requestId);
                    file.Write(bytes, 0, bytes.Length);
                    file.Flush(true);
                }
                if (File.Exists(path)) File.Replace(temporary, path, null);
                else File.Move(temporary, path);
            }
            finally
            {
                if (File.Exists(temporary)) File.Delete(temporary);
            }
        }
        public void Clear()
        {
            try { File.Delete(path); }
            catch (DirectoryNotFoundException) { }
        }
        private static void Validate(string requestId)
        {
            if (requestId == null || !Guid.TryParseExact(requestId, "D", out var parsed) ||
                !string.Equals(requestId, parsed.ToString("D"), StringComparison.Ordinal))
                throw new InvalidDataException("Recovery file must contain a request UUID.");
        }
    }
}
