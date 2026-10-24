import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

// The headset talks only to the Boopy service. This reads a built APK and reports any part of the Interaction SDK's
// telemetry it carries: the native library, or its managed types in the IL2CPP metadata or a Mono assembly. An APK with
// no managed code to read fails: passing it would prove nothing. (The namespace alone is no sign: the core SDK names
// Oculus.Interaction.OVR in its InternalsVisibleTo attributes.)
const nativeLibrary = /^lib\/[^/]+\/libISDKEngineTelemetry\.so$/;
const managed = /^assets\/bin\/Data\/Managed\/(Metadata\/global-metadata\.dat|[^/]+\.dll)$/;
const managedName = Buffer.from('ISDKTelemetry');

export function telemetryFindings(names, read) {
  const findings = [];
  let scanned = 0;
  for (const name of names) {
    if (nativeLibrary.test(name)) { findings.push(`native telemetry library ${name}`); continue; }
    if (!managed.test(name)) continue;
    scanned++;
    if (read(name).includes(managedName)) findings.push(`telemetry types in ${name}`);
  }
  if (scanned === 0) findings.push('no managed code to read (no global-metadata.dat and no Managed assembly)');
  return findings;
}

// The zip's central directory: each entry's name, method and where its data starts. No ZIP64: an APK this size never
// needs it, and one that does is refused rather than misread.
export function readZip(bytes) {
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65535); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error('not a zip archive');
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('broken central directory');
    const method = bytes.readUInt16LE(at + 10);
    const size = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.toString('utf8', at + 46, at + 46 + nameLength);
    entries.set(name, { method, size, local });
    at += 46 + nameLength + extraLength + commentLength;
  }
  const read = name => {
    const entry = entries.get(name);
    if (!entry) throw new Error(`no entry ${name}`);
    if (bytes.readUInt32LE(entry.local) !== 0x04034b50) throw new Error(`broken local header for ${name}`);
    const start = entry.local + 30 + bytes.readUInt16LE(entry.local + 26) + bytes.readUInt16LE(entry.local + 28);
    const data = bytes.subarray(start, start + entry.size);
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateRawSync(data);
    throw new Error(`unsupported compression ${entry.method} for ${name}`);
  };
  return { names: [...entries.keys()], read };
}

function main() {
  const path = process.argv[2];
  if (!path) { console.error('Usage: node apk-privacy.mjs <built APK>'); process.exit(2); }
  const { names, read } = readZip(readFileSync(path));
  const findings = telemetryFindings(names, read);
  for (const finding of findings) console.log(`Found ${finding}.`);
  if (findings.length) process.exit(1);
  console.log(`No Interaction SDK telemetry in ${path}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
