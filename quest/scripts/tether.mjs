import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const execute = promisify(execFile);
const defaultAdb = '/Applications/Unity/Hub/Editor/6000.3.25f1/PlaybackEngines/AndroidPlayer/SDK/platform-tools/adb';

// Development USB plumbing only. Never sends or retries a capture, changes providers or opens a network listener.
export async function restoreTether(run, selectedSerial) {
  const devices = (await run(['devices'])).split('\n')
    .map(line => line.trim().split(/\s+/))
    .filter(parts => parts[1] === 'device').map(parts => parts[0]);
  const serial = selectedSerial ? devices.find(value => value === selectedSerial)
    : devices.length === 1 ? devices[0] : undefined;
  if (!serial) return { connected: false, restored: 0, ambiguous: devices.length > 1 };
  const prefix = ['-s', serial];
  const existing = await run([...prefix, 'reverse', '--list']);
  const mappings = existing.split('\n').map(line => line.trim().split(/\s+/));
  let restored = 0;
  for (const port of [47900]) {
    const address = `tcp:${port}`;
    if (mappings.some(parts => parts[1] === address && parts[2] === address)) continue;
    await run([...prefix, 'reverse', address, address]);
    restored++;
  }
  return { connected: true, restored, ambiguous: false };
}

async function main() {
  const run = async args => (await execute(process.env.BOOPY_ADB || defaultAdb, args,
    { timeout: 5000, maxBuffer: 65536 })).stdout;
  let previous = '';
  do {
    let message;
    try {
      const state = await restoreTether(run, process.env.BOOPY_QUEST_SERIAL);
      message = state.ambiguous ? 'Select a headset with BOOPY_QUEST_SERIAL.'
        : state.connected ? 'Quest USB connection ready for Boopy.' : 'Waiting for the USB headset.';
      if (state.restored) console.log('Restored development USB connections.');
    } catch { message = 'USB connection unavailable; waiting to reconnect.'; }
    if (message !== previous) console.log(message);
    previous = message;
    if (process.argv.includes('--once')) break;
    await setTimeout(2000);
  } while (true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
