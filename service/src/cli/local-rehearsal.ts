/** Isolated synthetic route from the headset API to the connector. Reads no saved service data. */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SessionView } from '../contracts.ts';
import { evidenceRecords } from '../evidence-contract.ts';
import { connectorApp } from '../http/connector.ts';
import { headsetApp } from '../http/headset.ts';
import { FixtureInterpreter } from '../interpret/fixture.ts';
import type { InterpretInput } from '../interpret/interpreter.ts';
import { Projection } from '../session.ts';
import { startRequest, testBoopy } from '../testing.ts';

const answers = [
  'This synthetic photograph appears to show a desert trip.',
  'The selected photograph may show desert dunes.',
];
export async function localRehearsal() {
  const inputs: InterpretInput[] = [];
  const fixture = new FixtureInterpreter();
  const test = testBoopy({
    interpreter: {
      provider: 'fixture',
      model: 'synthetic-local-rehearsal',
      async interpret(input) {
        inputs.push(input);
        const result = await fixture.interpret(input);
        result.output.response = answers[input.selectedReference ? 1 : 0] ?? null;
        return result;
      },
    },
  });
  const headset = headsetApp(test.boopy, { logger: false });
  const token = 'synthetic-rehearsal-token-0123456789';
  const connector = connectorApp(test.boopy, { token, baseUrl: 'http://127.0.0.1', logger: false });
  const client = new Client(
    { name: 'boopy-local-rehearsal', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  try {
    const route = (url: string, payload?: unknown) =>
      headset.inject({
        method: payload === undefined ? 'GET' : 'POST',
        url,
        headers: { host: '127.0.0.1' },
        ...(payload === undefined
          ? {}
          : {
              payload: JSON.stringify(payload),
              headers: { host: '127.0.0.1', 'content-type': 'application/json' },
            }),
      });
    const request = {
      ...startRequest('Describe this synthetic photograph.'),
      requestId: 'b42ff75d-5f3a-4a3b-8240-adac42b104be',
    };
    const response = await route('/v1/sessions', request);
    assert.equal(response.statusCode, 200);
    const first = SessionView.parse(response.json());
    assert.equal(first.dialogue?.text, answers[0]);
    assert.equal(first.items.find((item) => item.id.endsWith('.__reply'))?.status, 'proposed');
    const target = first.items.find((item) => item.id === first.referentId);
    assert.ok(target?.grounding.observationId);
    const replay = await route('/v1/sessions', request);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().id, first.id);
    assert.equal(inputs.length, 1);
    const conflict = await route('/v1/sessions', {
      ...request,
      speech: { text: 'Different synthetic request.' },
    });
    assert.equal(conflict.statusCode, 409);
    const recovery = await route(`/v1/session-starts/${request.requestId}`);
    assert.equal(recovery.json().status, 'succeeded');
    const before = test.journal.all().length;
    const bad = await route(`/v1/sessions/${first.id}/utterances`, {
      speech: { text: 'What is this?' },
      cues: { targetItemId: 'synthetic-missing-item' },
    });
    assert.equal(bad.statusCode, 404);
    assert.equal(test.journal.all().length, before);
    const followup = await route(`/v1/sessions/${first.id}/utterances`, {
      speech: { text: 'What does this selected photograph show?' },
      cues: { targetItemId: target.id },
    });
    assert.equal(followup.statusCode, 200);
    const second = SessionView.parse(followup.json());
    assert.equal(second.dialogue?.text, answers[1]);
    assert.equal(inputs[1]?.selectedReference?.itemId, target.id);
    assert.equal(inputs[1]?.selectedReference?.observationId, target.grounding.observationId);
    assert.equal(second.items.find((item) => item.id === target.id)?.status, 'proposed');
    const savedResponse = await route(`/v1/sessions/${first.id}/utterances`, {
      speech: { text: 'Save it' },
    });
    assert.equal(savedResponse.statusCode, 200);
    const saved = SessionView.parse(savedResponse.json());
    assert.ok(saved.committed);
    const pkg = test.boopy.package(saved.committed.packageId);
    const records = evidenceRecords(pkg);
    assert.ok(
      test.journal
        .all()
        .some(
          (event) =>
            event.type === 'interpretation.proposed' &&
            event.data.items.some((item) => item.statement === answers[0]),
        ),
    );
    for (const answer of answers.slice(1)) {
      const record = records.find((item) => item.statement === answer);
      assert.ok(record);
      assert.equal(record.origin, 'model');
      assert.equal(record.verification, 'accepted');
      assert.equal(record.modelConfidence, null);
      assert.equal(record.observationId, target.grounding.observationId);
      assert.ok(record.utteranceId);
      assert.ok(record.interpretationId);
      assert.deepEqual(record.model, { provider: 'fixture', id: 'synthetic-local-rehearsal' });
      assert.equal(
        record.humanActions.some((action) => action.op === 'confirm'),
        false,
      );
    }
    assert.equal(Projection.from(test.journal.all()).session(first.id)?.state, 'committed');
    await connector.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(connector.server.address() as AddressInfo).port}`;
    const headers = { authorization: `Bearer ${token}`, 'x-boopy-agent': 'local-rehearsal-rest' };
    assert.equal((await fetch(`${base}/v1/context`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
      401,
    );
    const rest = await fetch(`${base}/v1/context/${saved.committed.packageId}`, { headers });
    assert.equal(rest.status, 200);
    assert.deepEqual(await rest.json(), JSON.parse(JSON.stringify(pkg)));
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { ...headers, 'x-boopy-agent': 'local-rehearsal-mcp' } },
      }),
    );
    const search = await client.callTool({ name: 'search', arguments: { query: 'desert' } });
    const searchPart = search.content.find((part) => part.type === 'text');
    assert.ok(searchPart && searchPart.type === 'text');
    assert.ok(JSON.parse(searchPart.text).results.some((r: { id: string }) => r.id === pkg?.id));
    const fetched = await client.callTool({
      name: 'fetch',
      arguments: { id: saved.committed.packageId },
    });
    const part = fetched.content.find((block) => block.type === 'text');
    assert.ok(part && part.type === 'text');
    const document = JSON.parse(part.text);
    assert.deepEqual(document.metadata.package, JSON.parse(JSON.stringify(pkg)));
    assert.match(document.text, /not individually confirmed/);
    assert.ok(
      test.boopy.disclosures.some((d) => d.agent === 'local-rehearsal-rest' && d.tool === 'get'),
    );
    assert.ok(
      test.boopy.disclosures.some((d) => d.agent === 'local-rehearsal-mcp' && d.tool === 'fetch'),
    );
    return {
      mode: 'synthetic-fixture',
      passed: true,
      interpretationCalls: inputs.length,
      answerRecords: 1,
      authenticatedReadbacks: ['REST', 'MCP'],
      storage: 'in-memory',
      limits:
        'No real adapters, headset capture, audio playback, Muse delivery or wearer acceptance.',
    };
  } finally {
    await client.close();
    await headset.close();
    connector.server.closeAllConnections();
    await connector.close();
    test.journal.close();
  }
}
if (import.meta.main) {
  try {
    console.log(JSON.stringify(await localRehearsal(), null, 2));
  } catch {
    console.error('Synthetic local rehearsal failed. Run its test for assertion details.');
    process.exitCode = 1;
  }
}
