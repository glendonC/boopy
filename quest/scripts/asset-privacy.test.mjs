import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assetFindings } from './asset-privacy.mjs';

// A synthetic project: quest/Assets with the given files, and a private folder standing in for the owner's footage.
function project(assets, secret = {}) {
  const root = mkdtempSync(join(tmpdir(), 'boopy-asset-privacy-'));
  const write = (base, files) => { for (const [name, bytes] of Object.entries(files)) { mkdirSync(dirname(join(base, name)), { recursive: true }); writeFileSync(join(base, name), bytes); } };
  write(join(root, 'Assets'), assets); write(join(root, 'private'), secret);
  return { root, assets: join(root, 'Assets'), secret: join(root, 'private'), done: () => rmSync(root, { recursive: true, force: true }) };
}
const box = brand => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp' + brand), Buffer.alloc(12)]);

test('finds media in quest/Assets by name or first bytes, git-ignored folders included', () => {
  const p = project({
    'StreamingAssets/clip.bin': box('qt  '),
    'Boopy/Resources/still.bytes': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]),
    'Boopy/Textures/photo.HEIC': 'synthetic, named only',
    'Boopy/Audio/voice.wav': Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]),
    'Boopy/icon.png': Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG synthetic')]),
  });
  try {
    assert.deepEqual(assetFindings(p.assets).sort(), ['Boopy/Audio/voice.wav', 'Boopy/Resources/still.bytes', 'Boopy/Textures/photo.HEIC',
      'Boopy/icon.png', 'StreamingAssets/clip.bin'].map(name => `media file ${name}`));
  } finally { p.done(); }
});

test('finds a copy of a private file under any name, and only an exact copy', () => {
  const p = project({ 'Boopy/Resources/notes.bytes': 'synthetic footage bytes', 'Boopy/Resources/other.bytes': 'synthetic footage byteS' },
    { 'footage.MOV': 'synthetic footage bytes', 'deeper/still.jpg': 'synthetic still' });
  try {
    assert.deepEqual(assetFindings(p.assets, [p.secret]), ['copy of a private file Boopy/Resources/notes.bytes']);
  } finally { p.done(); }
});

test('finds a link, which could point anywhere', () => {
  const p = project({ 'Boopy/A.cs': '// synthetic' }, { 'footage.MOV': 'synthetic footage bytes' });
  try {
    symlinkSync(join(p.secret, 'footage.MOV'), join(p.assets, 'Boopy', 'clip.bytes'));
    assert.deepEqual(assetFindings(p.assets, [p.secret]), ['link Boopy/clip.bytes']);
  } finally { p.done(); }
});

test('passes code, metadata, scenes and fonts', () => {
  const p = project({
    'Boopy/Runtime/A.cs': '// synthetic', 'Boopy/Runtime/A.cs.meta': 'fileFormatVersion: 2', 'Boopy/Scenes/Boopy.unity': '%YAML 1.1',
    'Boopy/Resources/Fonts/Face.ttf': Buffer.from([0, 1, 0, 0, 0, 16]), 'TextMesh Pro/Resources/Fonts & Materials/Face SDF.asset': '%YAML 1.1',
  }, { 'footage.MOV': 'synthetic footage bytes' });
  try {
    assert.deepEqual(assetFindings(p.assets, [p.secret]), []);
  } finally { p.done(); }
});
