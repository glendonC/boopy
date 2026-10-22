import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SessionView } from './contracts.ts';

/** The fixture the Quest client's .NET tests deserialize; both sides read the same file. */
const shared = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../quest/dotnet/Boopy.Client.Tests/Fixtures/session-view.json',
);

describe('the contract shared with the headset', () => {
  it('still accepts the session view the headset is tested against', () => {
    const view = SessionView.parse(JSON.parse(readFileSync(shared, 'utf8')));
    assert.ok(view.items.some((item) => item.status === 'rejected'));
    assert.ok(view.items.some((item) => item.origin === 'person'));
  });
});
