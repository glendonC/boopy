import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreTether } from './tether.mjs';

function fake(devices, mappings = '') {
  const calls = [];
  return { calls, run: async args => {
    calls.push(args);
    if (args[0] === 'devices') return devices;
    if (args.at(-1) === '--list') return mappings;
    return '';
  } };
}

test('restores only Boopy after a shared adb restart', async () => {
  const adb = fake('List of devices attached\nsynthetic-quest\tdevice\n');
  assert.deepEqual(await restoreTether(adb.run), { connected: true, restored: 1, ambiguous: false });
  assert.deepEqual(adb.calls.slice(2), [
    ['-s', 'synthetic-quest', 'reverse', 'tcp:47900', 'tcp:47900'],
  ]);
});

test('leaves working mappings and unrelated ports alone', async () => {
  const adb = fake('synthetic-quest\tdevice', 'UsbFfs tcp:47900 tcp:47900\nUsbFfs tcp:47800 tcp:47800\nUsbFfs tcp:9999 tcp:9999');
  assert.equal((await restoreTether(adb.run)).restored, 0);
  assert.equal(adb.calls.length, 2);
});

test('does not guess among headsets or target an unauthorized device', async () => {
  for (const listing of ['quest-a\tdevice\nquest-b\tdevice', 'quest-a\tunauthorized']) {
    const adb = fake(listing);
    assert.equal((await restoreTether(adb.run)).connected, false);
    assert.equal(adb.calls.length, 1);
  }
  const adb = fake('quest-a\tdevice\nquest-b\tdevice');
  assert.equal((await restoreTether(adb.run, 'quest-b')).connected, true);
  assert.equal(adb.calls[1][1], 'quest-b');
});

test('reports command failure rather than claiming the connection was restored', async () => {
  let calls = 0;
  const run = async () => { if (++calls === 1) return 'quest\tdevice'; throw new Error('synthetic failure'); };
  await assert.rejects(restoreTether(run), /synthetic failure/);
});

test('preserves an existing shared mapping while restoring only Boopy', async () => {
  const adb = fake('synthetic-quest\tdevice', 'UsbFfs tcp:47800 tcp:47800\nUsbFfs tcp:9999 tcp:9999');
  assert.equal((await restoreTether(adb.run)).restored, 1);
  assert.deepEqual(adb.calls.slice(2), [
    ['-s', 'synthetic-quest', 'reverse', 'tcp:47900', 'tcp:47900'],
  ]);
});
