/** Person-triggered activity calls. A stop abandons pending work for journal recovery at startup. */
import { ActivityFileError, type ActivityStore, callFailure } from './activity.ts';
import {
  type ActivityCallView,
  ActivityRequestFile,
  ActivitySubmissionFile,
  activityAnswerSchema,
  readContainer,
  replyAnswerSchema,
} from './activity-contract.ts';
import { AssistantError, type OllamaActivityAssistant } from './activity-ollama.ts';
import { BoopyError } from './boopy.ts';

export const CALL_TIMEOUT_MS = 120_000;
const STOP = Symbol('Boopy stopping');
const TIMEOUT = Symbol('Activity deadline');
const ACTIVITY_SYSTEM =
  'Answer this exact Boopy activity request. Return only the activity and fallbackText fields; Boopy itself copies the binding and records who answered. Never claim the person mastered anything, and keep unknowns unknown.';
const REPLY_SYSTEM =
  'Answer this exact Boopy activity submission. Return only the reply and next fields, with next null when you offer no next activity; Boopy itself copies the binding and echo and records who answered. Never claim the person mastered anything, and keep unknowns unknown.';

export class ActivityCalls {
  readonly #store: ActivityStore;
  readonly #assistant: Pick<OllamaActivityAssistant, 'provider' | 'model' | 'ask'>;
  readonly #timeoutMs: number;
  #closed = false;
  #busy = false;
  #pending: { callId: string; controller: AbortController; settled: Promise<void> } | null = null;

  constructor(input: {
    store: ActivityStore;
    assistant: Pick<OllamaActivityAssistant, 'provider' | 'model' | 'ask'>;
    timeoutMs?: number;
  }) {
    this.#store = input.store;
    this.#assistant = input.assistant;
    this.#timeoutMs = input.timeoutMs ?? CALL_TIMEOUT_MS;
  }

  get capability() {
    return { provider: this.#assistant.provider, model: this.#assistant.model };
  }

  async askForPractice(input: unknown): Promise<ActivityCallView> {
    if (this.#closed) throw unavailable();
    if (this.#busy)
      throw new BoopyError(409, 'assistant_busy', 'Boopy is already waiting for the local model.');
    // Reserve before prepareRequest awaits packet reading, so concurrent actions cannot start two calls.
    this.#busy = true;
    try {
      const rendered = await this.#store.prepareRequest(input, { delivery: 'sent-to-local-model' });
      if (this.#closed) throw unavailable();
      const file = ActivityRequestFile.parse(JSON.parse(rendered.file));
      const call = this.#store.askCall({
        kind: 'activity',
        actor: 'person',
        ...this.capability,
        requestId: file.requestId,
        submissionId: null,
        fileSha256: rendered.fileSha256,
      });
      this.#start(call, file, rendered.file);
      return call;
    } catch (error) {
      this.#busy = false;
      throw error;
    }
  }

  submit(activityId: string, input: unknown) {
    const view = this.#store.submit(activityId, input);
    if (!view.provenance.call || this.#closed) return view;
    const submission = view.submissions.at(-1);
    if (!submission) throw new Error('Submission missing.');
    const rendered = this.#store.renderSubmissionForCall(submission.submissionId);
    const file = ActivitySubmissionFile.parse(JSON.parse(rendered.file));
    const call = this.#store.askCall({
      kind: 'reply',
      actor: 'system',
      ...this.capability,
      requestId: view.provenance.requestId,
      submissionId: submission.submissionId,
      fileSha256: rendered.fileSha256,
    });
    if (this.#busy)
      this.#store.finishCall({
        callId: call.callId,
        outcome: 'failed',
        durationMs: null,
        failure: callFailure('reply', 'assistant_busy'),
        issues: [],
        activityId,
        replyId: null,
        nextActivityId: null,
        metrics: null,
      });
    else {
      this.#busy = true;
      this.#start(call, file, rendered.file);
    }
    return this.#store.view(activityId);
  }

  async finished(callId: string): Promise<ActivityCallView> {
    if (this.#pending?.callId === callId) await this.#pending.settled;
    return this.#store.call(callId);
  }

  async close(graceMs: number): Promise<void> {
    this.#closed = true;
    const pending = this.#pending;
    if (!pending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pending.settled,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, graceMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (this.#pending === pending) {
      pending.controller.abort(STOP);
      await pending.settled;
    }
  }

  #start(
    call: ActivityCallView,
    file:
      | ReturnType<typeof ActivityRequestFile.parse>
      | ReturnType<typeof ActivitySubmissionFile.parse>,
    text: string,
  ) {
    const controller = new AbortController();
    const settled = this.#run(call, file, text, controller).finally(() => {
      this.#busy = false;
      this.#pending = null;
    });
    this.#pending = { callId: call.callId, controller, settled };
  }

  async #run(
    call: ActivityCallView,
    file:
      | ReturnType<typeof ActivityRequestFile.parse>
      | ReturnType<typeof ActivitySubmissionFile.parse>,
    text: string,
    controller: AbortController,
  ) {
    const started = performance.now();
    const timer = setTimeout(() => controller.abort(TIMEOUT), this.#timeoutMs);
    let metrics = null;
    try {
      const request = file.type === 'boopy.activity-request' ? file : null;
      const submission = file.type === 'boopy.activity-submission' ? file : null;
      const sources = request
        ? request.sources.map((source) => source.sourceId)
        : sourceIdsOf(submission?.activity.body);
      const schema = request ? activityAnswerSchema(sources) : replyAnswerSchema(sources);
      const result = await this.#assistant.ask(
        {
          system: `${request ? ACTIVITY_SYSTEM : REPLY_SYSTEM}\n\nAnswer with one JSON object, and nothing else, that matches this JSON Schema:\n${JSON.stringify(schema)}`,
          user: `${file.instructions.join('\n')}\n\n${text}`,
        },
        controller.signal,
      );
      metrics = result.metrics;
      if (controller.signal.aborted) throw controller.signal.reason;
      const read = readContainer(result.content);
      if (
        !read ||
        read.value === null ||
        typeof read.value !== 'object' ||
        Array.isArray(read.value)
      )
        throw new AnswerUnreadable();
      const value = read.value as Record<string, unknown>;
      const durationMs = Math.round(performance.now() - started);
      const provenance = { callId: call.callId, ...this.capability, durationMs };
      let activityId = call.activityId;
      let replyId = null;
      let nextActivityId = null;
      if (request) {
        const envelope = {
          type: 'boopy.activity',
          version: 1,
          binding: request.respondWith.binding,
          activity: value.activity,
          fallbackText: value.fallbackText,
        };
        activityId = this.#store.importActivity(
          `${JSON.stringify(envelope, null, 2)}\n`,
          provenance,
        ).activityId;
      } else if (submission) {
        const envelope = {
          type: 'boopy.activity-reply',
          version: 1,
          binding: submission.respondWith.binding,
          echo: submission.respondWith.echo,
          reply: value.reply,
          next: value.next,
        };
        const imported = this.#store.importReply(
          `${JSON.stringify(envelope, null, 2)}\n`,
          provenance,
        );
        replyId = imported.replyId;
        nextActivityId = imported.nextActivityId;
      }
      this.#store.finishCall({
        callId: call.callId,
        outcome: 'imported',
        durationMs,
        failure: null,
        issues: [],
        activityId,
        replyId,
        nextActivityId,
        metrics,
      });
    } catch (error) {
      if (controller.signal.reason === STOP) return;
      const code =
        controller.signal.reason === TIMEOUT
          ? 'assistant_timeout'
          : error instanceof AnswerUnreadable
            ? 'answer_unreadable'
            : error instanceof ActivityFileError
              ? 'answer_invalid'
              : error instanceof AssistantError
                ? error.code
                : 'assistant_error';
      this.#store.finishCall({
        callId: call.callId,
        outcome: 'failed',
        durationMs: Math.round(performance.now() - started),
        failure: callFailure(call.kind, code),
        issues: error instanceof ActivityFileError ? error.issues : [],
        activityId: call.kind === 'reply' ? call.activityId : null,
        replyId: null,
        nextActivityId: null,
        metrics,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

class AnswerUnreadable extends Error {}
function unavailable() {
  return new BoopyError(
    503,
    'assistant_unavailable',
    'The local activity assistant is unavailable.',
  );
}
function sourceIdsOf(body: Record<string, unknown> | undefined): string[] {
  if (!Array.isArray(body?.components)) return [];
  return [
    ...new Set(
      body.components.flatMap((component) =>
        component.type === 'arrange'
          ? component.tokens.flatMap((token: { sourceId: unknown }) =>
              typeof token.sourceId === 'string' ? [token.sourceId] : [],
            )
          : [],
      ),
    ),
  ] as string[];
}
