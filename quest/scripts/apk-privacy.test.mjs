import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { mediaFindings, readZip, telemetryFindings } from './apk-privacy.mjs';

// A synthetic APK: a zip with the given entries, deflated unless stored, and an optional archive comment.
function apk(entries, comment = '') {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, text, stored } of entries) {
    const raw = Buffer.from(text), data = stored ? raw : deflateRawSync(raw), file = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(stored ? 0 : 8, 8); local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(file.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(stored ? 0 : 8, 10); central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(file.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, file, data); centrals.push(central, file);
    offset += 30 + file.length + data.length;
  }
  const directory = Buffer.concat(centrals), note = Buffer.from(comment), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(note.length, 20);
  return Buffer.concat([...locals, directory, end, note]);
}

const metadata = 'assets/bin/Data/Managed/Metadata/global-metadata.dat';
const findings = bytes => { const { names, read } = readZip(bytes); return telemetryFindings(names, read); };

test('finds the native telemetry library on any architecture', () => {
  assert.deepEqual(findings(apk([{ name: 'lib/arm64-v8a/libISDKEngineTelemetry.so', text: 'synthetic' },
    { name: 'lib/armeabi-v7a/libISDKEngineTelemetry.so', text: 'synthetic', stored: true }, { name: metadata, text: 'synthetic Boopy.Quest' }])),
  ['native telemetry library lib/arm64-v8a/libISDKEngineTelemetry.so', 'native telemetry library lib/armeabi-v7a/libISDKEngineTelemetry.so']);
});

test('finds the telemetry types in deflated IL2CPP metadata and in a Mono assembly', () => {
  assert.deepEqual(findings(apk([{ name: metadata, text: 'synthetic Boopy.Quest ISDKTelemetryInitializer synthetic' },
    { name: 'assets/bin/Data/Managed/Oculus.Interaction.dll', text: 'synthetic ISDKTelemetryRuntimeEvents', stored: true }])),
  [`telemetry types in ${metadata}`, 'telemetry types in assets/bin/Data/Managed/Oculus.Interaction.dll']);
});

test('fails an APK with no managed code to read, so passing always means it was read', () => {
  assert.deepEqual(findings(apk([{ name: 'lib/arm64-v8a/libil2cpp.so', text: 'synthetic' }])),
    ['no managed code to read (no global-metadata.dat and no Managed assembly)']);
});

test('passes an APK with other libraries and metadata, behind an archive comment', () => {
  assert.deepEqual(findings(apk([{ name: 'lib/arm64-v8a/libil2cpp.so', text: 'synthetic ISDKTelemetry outside the managed code' },
    { name: metadata, text: 'synthetic Boopy.Quest Boopy.Client OVRManager Oculus.Interaction.OVR' },
    { name: 'assets/notes/ISDKTelemetry.txt', text: 'synthetic ISDKTelemetry' }], 'synthetic comment')), []);
});

test('reads stored and deflated entries exactly', () => {
  const { names, read } = readZip(apk([{ name: 'a.txt', text: 'stored words', stored: true }, { name: 'b.txt', text: 'deflated words' }]));
  assert.deepEqual(names, ['a.txt', 'b.txt']);
  assert.equal(read('a.txt').toString(), 'stored words');
  assert.equal(read('b.txt').toString(), 'deflated words');
});

test('refuses what it cannot read instead of passing it', () => {
  assert.throws(() => readZip(Buffer.from('not a zip at all, synthetic')), /not a zip/);
  const archive = apk([{ name: 'a.txt', text: 'synthetic' }]);
  archive.writeUInt32LE(0xffffffff, archive.length - 6);
  assert.throws(() => readZip(archive), /ZIP64/);
});

// Footage reaches the headset only by streaming from the Mac, so no picture, clip or sound may ride in the APK.
const media = bytes => { const { names, read } = readZip(bytes); return mediaFindings(names, read); };
const box = brand => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp' + brand), Buffer.alloc(12)]);

test('finds footage-shaped media anywhere in the APK, by its bytes or by its name', () => {
  assert.deepEqual(media(apk([
    { name: 'assets/StreamingAssets/clip.bin', text: box('mp42'), stored: true },
    { name: 'assets/bin/Data/still.dat', text: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) },
    { name: 'assets/photo.bin', text: box('heic') },
    { name: 'assets/sound.bin', text: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]) },
    { name: 'assets/voice.bin', text: Buffer.from('OggS synthetic') },
    { name: 'assets/song.bin', text: Buffer.from('ID3 synthetic') },
    { name: 'assets/clip.webm', text: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0]) },
    { name: 'assets/Sahara.MOV', text: 'synthetic, named only' },
    { name: 'assets/icon.png', text: Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG synthetic')]) },
  ])), ['assets/StreamingAssets/clip.bin', 'assets/bin/Data/still.dat', 'assets/photo.bin', 'assets/sound.bin', 'assets/voice.bin',
    'assets/song.bin', 'assets/clip.webm', 'assets/Sahara.MOV', 'assets/icon.png'].map(name => `media file ${name}`));
});

test("passes Android's own PNG resources and the app's code and data", () => {
  assert.deepEqual(media(apk([
    { name: 'res/mipmap-mdpi-v4/app_icon.png', text: Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG synthetic')]) },
    { name: 'res/drawable-xxhdpi-v4/abc_list_focused_holo.9.png', text: Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG synthetic')]) },
    { name: metadata, text: 'synthetic Boopy.Quest' },
    { name: 'assets/bin/Data/data.unity3d', text: 'UnityFS synthetic' },
    { name: 'lib/arm64-v8a/libil2cpp.so', text: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) },
  ])), []);
});

test("finds a clip stored inside Unity's resource files, and not a chance 'ftyp' in raw pixels", () => {
  const clip = Buffer.concat([Buffer.from('synthetic texture bytes'), box('mp42'), Buffer.from('synthetic mdat')]);
  const chance = Buffer.concat([Buffer.from('synthetic pixels'), Buffer.from([0x7f, 0x7f, 0x7f, 0x7f]), Buffer.from('ftypzzzz pixels')]);
  assert.deepEqual(media(apk([
    { name: 'assets/bin/Data/sharedassets0.resource', text: clip },
    { name: 'assets/bin/Data/sharedassets1.assets.resS', text: clip, stored: true },
    { name: 'assets/bin/Data/sharedassets2.assets.resS', text: chance },
  ])), ['assets/bin/Data/sharedassets0.resource', 'assets/bin/Data/sharedassets1.assets.resS'].map(name => `media file ${name}`));
});
