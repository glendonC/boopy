import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runReplayCli } from './replay.ts';

it('accepts only inspect with one explicit input and prints fixed summary fields', async () => {
  const lines: string[] = [];
  const exit = await runReplayCli(['inspect', '--input', '/synthetic/private-marker.mov'], {
    inspect: async () => ({ videoFrames: 4, audioTracks: 1, captureOrigin: { status: 'unknown' } }),
    print: (line) => {
      lines.push(line);
    },
  });
  assert.equal(exit, 0);
  assert.deepEqual(lines, [
    'recorded-media: inspected; video-frames=4; audio-tracks=1; capture-time=unknown',
  ]);
  assert.equal(lines.join().includes('private-marker'), false);
});
for (const args of [
  [],
  ['import', '--input', '/tmp/a'],
  ['inspect'],
  ['inspect', '--input', '/tmp/a', '--input', '/tmp/b'],
  ['inspect', '--input', 'https://example.invalid/a'],
]) {
  it('rejects unsupported CLI syntax without inspecting', async () => {
    let inspected = false;
    const lines: string[] = [];
    assert.equal(
      await runReplayCli(args, {
        inspect: async () => {
          inspected = true;
          throw new Error('private-marker');
        },
        print: (line) => {
          lines.push(line);
        },
      }),
      1,
    );
    assert.equal(inspected, false);
    assert.deepEqual(lines, ['recorded-media: invalid_arguments']);
  });
}
it('does not print raw diagnostic messages, paths or metadata when inspection fails', async () => {
  const lines: string[] = [];
  assert.equal(
    await runReplayCli(['inspect', '--input', '/synthetic/private-marker.mov'], {
      inspect: async () => {
        throw new Error('/private-marker.mov secret metadata');
      },
      print: (line) => {
        lines.push(line);
      },
    }),
    1,
  );
  assert.deepEqual(lines, ['recorded-media: inspect_failed']);
});
