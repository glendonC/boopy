import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { readTaskReply, renderTaskRequest } from './connection-files.ts';

const SHA = 'a'.repeat(64);
const NONCE = 'b'.repeat(32);
const request = {
  requestId: 'trq_one',
  taskId: 'tsk_mug',
  revision: 1,
  source: { sourceId: 'src_obs_1', sourceRevision: 1, sha256: SHA },
  nonce: NONCE,
  utterance: 'What is this?',
  subject: 'Mug',
  subjectConfidence: 0.85,
  boopyLine: 'It looks like a mug.',
  answers: [{ text: 'My coffee mug.', recognitionUncertain: true }],
  evidenceIds: ['int_1.mug'],
};

describe('the request file a person carries to a connection', () => {
  it('is the same bytes each time, names only ids and the digest, and says Boopy sent nothing', () => {
    const first = renderTaskRequest(request);
    assert.deepEqual(renderTaskRequest(request), first);
    assert.equal(first.fileName, 'boopy-request-trq_one.json');
    assert.equal(first.fileSha256, createHash('sha256').update(first.file).digest('hex'));
    assert.ok(first.file.endsWith('}\n'));
    assert.ok(Buffer.byteLength(first.file) <= 16 * 1024);
    const body = JSON.parse(first.file);
    assert.equal(body.type, 'boopy.task-request');
    assert.match(body.note, /Boopy did not send it\./);
    assert.deepEqual(body.task.subject, {
      label: 'Mug',
      origin: 'model',
      status: 'proposed',
      confidence: 0.85,
    });
    const unknown = JSON.parse(renderTaskRequest({ ...request, subjectConfidence: null }).file);
    assert.equal(unknown.task.subject.confidence, null);
    assert.deepEqual(body.respondWith, {
      type: 'boopy.task-reply',
      version: 1,
      requestId: 'trq_one',
      taskId: 'tsk_mug',
      baseTaskRevision: 1,
      source: request.source,
      nonce: NONCE,
      previousReplyId: null,
      components: [{ type: 'dialogue', text: '', evidenceIds: ['int_1.mug'] }],
    });
    assert.doesNotMatch(first.file, /jpeg|base64|\/Users\/|https?:/i);
  });
});

describe('reading a reply file', () => {
  it('reads one JSON object or one fenced json block and keeps the file digest', () => {
    const value = { type: 'boopy.task-reply' };
    const whole = JSON.stringify(value);
    assert.deepEqual(readTaskReply(whole), {
      value,
      fileSha256: createHash('sha256').update(whole).digest('hex'),
    });
    const fenced = `Here it is:\n\`\`\`json\n${whole}\n\`\`\`\n`;
    assert.deepEqual(readTaskReply(fenced)?.value, value);
  });

  it('cannot read prose, two blocks, or more than 16 KiB', () => {
    const block = '```json\n{}\n```';
    assert.equal(readTaskReply('Here is my reply.'), null);
    assert.equal(readTaskReply(`${block}\n${block}`), null);
    assert.equal(readTaskReply(JSON.stringify({ text: 'x'.repeat(16 * 1024) })), null);
  });
});
