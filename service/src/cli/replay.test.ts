import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
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

describe('the operator recording commands', () => {
  async function folder() {
    const root = await mkdtemp(join(tmpdir(), 'boopy-replay-cli-'));
    const input = join(root, 'Holiday-private-marker.MOV');
    await writeFile(input, 'synthetic clip bytes, not media');
    return { root, input, data: join(root, 'data') };
  }
  function recorder(answer: unknown = {}) {
    const calls: { path: string; body: unknown; method: string | undefined }[] = [];
    const lines: string[] = [];
    return {
      calls,
      lines,
      dependencies: {
        call: async (_connection: unknown, path: string, body?: unknown, method?: string) => {
          calls.push({ path, body, method });
          return answer;
        },
        print: (line: string) => {
          lines.push(line);
        },
      },
    };
  }
  const summary = {
    recordingId: `rec_${'1'.repeat(32)}`,
    kind: 'video',
    frames: 3,
    width: 960,
    height: 1280,
    durationSeconds: 12.2,
    captureTime: 'unverified',
    reused: false,
  };

  it('copies the chosen file into the private store under its SHA-256, never moving it', async () => {
    const { root, input, data } = await folder();
    const sha256 = createHash('sha256')
      .update(await readFile(input))
      .digest('hex');
    const run = recorder(summary);
    const exit = await runReplayCli(
      ['import', '--input', input, '--data-dir', data, '--stills', '3'],
      run.dependencies,
    );
    assert.equal(exit, 0, run.lines.join());
    assert.deepEqual(run.calls, [
      {
        path: '/v1/local-recorded/imports',
        body: { sha256, extension: 'mov', sampling: { mode: 'stills', count: 3 } },
        method: undefined,
      },
    ]);
    const stored = join(data, 'recorded', `${sha256}.mov`);
    assert.equal((await stat(stored)).mode & 0o777, 0o600);
    assert.equal((await stat(join(data, 'recorded'))).mode & 0o777, 0o700);
    assert.equal(await readFile(input, 'utf8'), 'synthetic clip bytes, not media');
    assert.deepEqual(await readdir(join(data, 'recorded')), [`${sha256}.mov`]);
    assert.deepEqual(run.lines, [
      `recorded: imported; recording=${summary.recordingId}; kind=video; frames=3; capture-time=unverified`,
    ]);
    // A second import finds the stored copy and changes nothing.
    const again = recorder({ ...summary, reused: true });
    assert.equal(
      await runReplayCli(
        ['import', '--input', input, '--data-dir', data, '--stills', '3'],
        again.dependencies,
      ),
      0,
    );
    assert.match(again.lines[0] ?? '', /; reused$/);
    assert.deepEqual(await readdir(join(data, 'recorded')), [`${sha256}.mov`]);
    assert.equal([...run.lines, ...again.lines].join().includes('private-marker'), false);
    await rm(root, { recursive: true, force: true });
  });

  it('turns sampling flags into one sampling, and refuses mixed or missing ones', async () => {
    const { root, input, data } = await folder();
    for (const [flags, sampling] of [
      [['--at', '1.5,3'], { mode: 'at', seconds: [1.5, 3] }],
      [
        ['--every', '0.2', '--start', '10', '--duration', '5'],
        { mode: 'every', seconds: 0.2, startSeconds: 10, durationSeconds: 5 },
      ],
      [[], undefined],
    ] as const) {
      const run = recorder(summary);
      assert.equal(
        await runReplayCli(
          ['import', '--input', input, '--data-dir', data, ...flags],
          run.dependencies,
        ),
        0,
      );
      assert.deepEqual(
        (run.calls[0]?.body as { sampling?: unknown } | undefined)?.sampling,
        sampling,
      );
    }
    for (const args of [
      ['import', '--input', input, '--data-dir', data, '--stills', '3', '--at', '1'],
      ['import', '--input', input, '--data-dir', data, '--stills', 'many'],
      ['import', '--input', input, '--data-dir', data, '--at', '1,,2'],
      ['import', '--input', join(root, 'clip.avi'), '--data-dir', data],
      ['import', '--input', input],
      ['show', '--data-dir', data],
      [
        'show',
        '--data-dir',
        data,
        '--recording',
        summary.recordingId,
        '--frame',
        `rfr_${'2'.repeat(32)}`,
        '--at',
        '1',
      ],
    ]) {
      const run = recorder(summary);
      assert.equal(await runReplayCli(args, run.dependencies), 1, args.join(' '));
      assert.deepEqual(run.lines, ['recorded-media: invalid_arguments']);
      assert.equal(run.calls.length, 0);
    }
    await rm(root, { recursive: true, force: true });
  });

  it('refuses a link as the chosen file and copies nothing', async () => {
    const { root, input, data } = await folder();
    const link = join(root, 'link.mov');
    await symlink(input, link);
    const run = recorder(summary);
    assert.equal(
      await runReplayCli(['import', '--input', link, '--data-dir', data], run.dependencies),
      1,
    );
    assert.deepEqual(run.lines, [
      'recorded: Choose a regular photo or video file, not a link or folder.',
    ]);
    assert.equal(run.calls.length, 0);
    await rm(root, { recursive: true, force: true });
  });

  it('lists, shows and clears with fixed lines and no capture time value', async () => {
    const { root, data } = await folder();
    const listed = recorder({ recordings: [summary] });
    assert.equal(await runReplayCli(['list', '--data-dir', data], listed.dependencies), 0);
    assert.deepEqual(listed.calls, [
      { path: '/v1/local-recorded/recordings', body: undefined, method: 'GET' },
    ]);
    assert.deepEqual(listed.lines, [
      `recorded: ${summary.recordingId}; kind=video; frames=3; capture-time=unverified`,
    ]);
    const scene = {
      scene: {
        recordingId: summary.recordingId,
        frameId: `rfr_${'2'.repeat(32)}`,
        frames: [{}, {}, {}],
        capturedAt: { value: '2001-02-03T04:05:06.000Z', trust: 'unverified' },
      },
    };
    const shown = recorder(scene);
    assert.equal(
      await runReplayCli(
        ['show', '--data-dir', data, '--recording', summary.recordingId, '--at', '4.5'],
        shown.dependencies,
      ),
      0,
    );
    assert.deepEqual(shown.calls[0]?.body, { recordingId: summary.recordingId, atSeconds: 4.5 });
    assert.deepEqual(shown.lines, [
      `recorded: showing; recording=${summary.recordingId}; frame=rfr_${'2'.repeat(32)}; frames=3`,
    ]);
    assert.equal(shown.lines.join().includes('2001'), false);
    const cleared = recorder({ scene: null });
    assert.equal(await runReplayCli(['clear', '--data-dir', data], cleared.dependencies), 0);
    assert.deepEqual(cleared.calls, [
      { path: '/v1/local-recorded/scene/clear', body: {}, method: undefined },
    ]);
    assert.deepEqual(cleared.lines, ['recorded: cleared']);
    const refused = recorder();
    refused.dependencies.call = async () => {
      throw new Error('No recording is shown. (recorded_scene_none)');
    };
    assert.equal(await runReplayCli(['clear', '--data-dir', data], refused.dependencies), 1);
    assert.deepEqual(refused.lines, ['recorded: No recording is shown. (recorded_scene_none)']);
    await rm(root, { recursive: true, force: true });
  });
});
