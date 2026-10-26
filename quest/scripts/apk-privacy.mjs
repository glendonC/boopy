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

// The owner's footage reaches the headset only by streaming from the Mac; no picture, clip or sound rides in the APK.
// A media file is found by its first bytes or by its name, anywhere; Android's own PNG resources under res/ are allowed.
// A clip Unity stores whole inside a .resource or .resS file is found by its ISO BMFF 'ftyp' box (a size, the tag and a
// known brand). Footage imported as a texture would be raw pixels inside an asset file, which this cannot see; nothing is
// imported, and asset-privacy.mjs checks quest/Assets itself.
export const mediaName = /\.(mp4|m4v|mov|qt|webm|mkv|3gp|avi|heic|heif|avif|jpe?g|dng|gif|webp|bmp|tiff?|wav|mp3|m4a|aac|ogg|opus|flac|png)$/i;
const androidResource = /^res\/.+\.png$/;

export function mediaKind(head) {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.length >= 8 && head.toString('latin1', 4, 8) === 'ftyp') return 'iso-bmff';
  const start = head.toString('latin1', 0, 4);
  if (start === 'RIFF' || start === 'OggS' || start === 'fLaC' || start === 'GIF8') return start;
  if (start.startsWith('ID3')) return 'mp3';
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'matroska';
  if (head.length >= 4 && head[0] === 0x89 && start.slice(1) === 'PNG') return 'png';
  return null;
}

const unityResource = /\.(resource|resS)$/;
const brands = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4A ', 'qt  ', 'heic', 'heix',
  'mif1', 'msf1', 'hevc', 'avif', 'dash', '3gp4', '3gp5', '3g2a', 'MSNV', 'XAVC', 'crx ']);

function holdsClip(bytes) {
  for (let at = bytes.indexOf('ftyp', 4, 'latin1'); at >= 4; at = bytes.indexOf('ftyp', at + 1, 'latin1')) {
    const size = bytes.readUInt32BE(at - 4);
    if (size >= 16 && size <= 1024 && at + 8 <= bytes.length && brands.has(bytes.toString('latin1', at + 4, at + 8))) return true;
  }
  return false;
}

export function mediaFindings(names, read) {
  const findings = [];
  for (const name of names) {
    if (name.endsWith('/')) continue;
    if (androidResource.test(name)) continue;
    const bytes = read(name);
    if (mediaName.test(name) || mediaKind(bytes.subarray(0, 12)) !== null || (unityResource.test(name) && holdsClip(bytes)))
      findings.push(`media file ${name}`);
  }
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
  const findings = [...telemetryFindings(names, read), ...mediaFindings(names, read)];
  for (const finding of findings) console.log(`Found ${finding}.`);
  if (findings.length) process.exit(1);
  console.log(`No Interaction SDK telemetry in ${path}.`);
  console.log(`No media file in ${path}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
