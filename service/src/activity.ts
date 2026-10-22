/**
 * Arrange and sequence activities (docs/activity-contract.md). Imported files, what the person
 * arranges or orders, frozen submissions, exports, and replies. Every change is a journal event.
 * This store is rebuilt from those events at startup. The events share a session id and do not
 * change that session's items, packages, or confirmations.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  type ActivityBody,
  ActivityCallView,
  ActivityRequestInput,
  type ActivitySummary,
  type ActivityView,
  type ArrangeComponent,
  ArrangementRequest,
  allowedSources,
  arrangeOf,
  type CallFailure,
  CallMetrics,
  type CallProvenance,
  CallState,
  type Container,
  type Derived,
  deriveArrangement,
  digestOf,
  normalizeEcho,
  type ReplyContent,
  RevisionRequest,
  readActivityFile,
  readReplyFile,
  type SequenceComponent,
  SequenceRequest,
  Sha256,
  type SourceEntry,
  sequenceOf,
  sequenceText,
  snapValue,
  type TextItem,
  tileDisplayOrder,
  validateActivityBody,
} from './activity-contract.ts';
import { type RenderedFile, renderRequestFile, renderSubmissionFile } from './activity-files.ts';
import { BoopyError } from './boopy.ts';
import type { ContextPackage } from './contracts.ts';
import type { Supersession } from './evidence-contract.ts';
import type { HandoffPreparation } from './handoff-preparation.ts';
import type { Journal, Recorded } from './journal.ts';

type Parent = { activityId: string; submissionId: string; replyId: string };
type PositionMap = Record<string, number | null>;

interface Event<Type extends string, Data> {
  readonly type: Type;
  readonly session: string;
  readonly actor: 'person' | 'system';
  readonly data: Data;
}

/** Activity events. The session projection ignores them. */
export type ActivityEvent =
  | Event<'activity.call-asked', CallAsked>
  | Event<'activity.call-finished', CallFinished>
  | Event<
      'activity.request-prepared',
      {
        readonly requestId: string;
        readonly packageId: string;
        readonly preparation: { requestId: string; receiptId: string; packetSha256: string };
        readonly goal: string;
        readonly personLanguage: string;
        readonly background: string | null;
        readonly sources: SourceEntry[];
        readonly fileSha256: string;
        readonly delivery: 'not-sent' | 'sent-to-local-model';
      }
    >
  | Event<
      'activity.imported',
      {
        readonly activityId: string;
        readonly requestId: string;
        readonly artifactSha256: string;
        readonly container: Container;
        readonly claimedAuthor: string | null;
        readonly call?: CallProvenance;
        readonly fallbackText: string;
        readonly activity: ActivityBody | null;
        readonly issues: string[];
        readonly parent: Parent | null;
      }
    >
  | Event<
      'activity.arranged',
      { readonly activityId: string; readonly revision: number; readonly positions: PositionMap }
    >
  | Event<
      'activity.sequenced',
      { readonly activityId: string; readonly revision: number; readonly chosen: string[] }
    >
  | Event<
      'activity.hint-revealed',
      { readonly activityId: string; readonly revision: number; readonly index: number }
    >
  | Event<
      'activity.submitted',
      {
        readonly activityId: string;
        readonly revision: number;
        readonly submissionId: string;
        readonly positions: PositionMap | null;
        readonly derived: Derived | null;
        readonly chosen: string[] | null;
        readonly text: string | null;
        readonly hintsRevealed: number[];
        readonly digest: string;
      }
    >
  | Event<
      'activity.submission-exported',
      {
        readonly submissionId: string;
        readonly activityId: string;
        readonly fileSha256: string;
        readonly delivery: 'not-sent';
      }
    >
  | Event<
      'activity.reply-imported',
      {
        readonly replyId: string;
        readonly submissionId: string;
        readonly activityId: string;
        readonly artifactSha256: string;
        readonly container: Container;
        readonly claimedAuthor: string | null;
        readonly call?: CallProvenance;
        readonly reply: ReplyContent;
        readonly nextActivityId: string | null;
      }
    >;

export type CallAsked = {
  callId: string;
  kind: 'activity' | 'reply';
  provider: 'ollama';
  model: string;
  requestId: string;
  submissionId: string | null;
  fileSha256: string;
};
export type CallFinished = {
  callId: string;
  outcome: 'imported' | 'failed' | 'interrupted';
  durationMs: number | null;
  failure: CallFailure | null;
  issues: string[];
  activityId: string | null;
  replyId: string | null;
  nextActivityId: string | null;
  metrics: CallMetrics | null;
};

/** A refused file, with up to eight `path: message` issues for the person or assistant. */
export class ActivityFileError extends BoopyError {
  override name = 'ActivityFileError';
  readonly issues: string[];

  constructor(status: number, code: string, message: string, issues: string[]) {
    super(status, code, message);
    this.issues = issues;
  }
}

export type ImportResult = {
  activityId: string;
  status: 'active' | 'fallback-only';
  issues: string[];
  duplicate: boolean;
};

export type ReplyResult = {
  replyId: string;
  submissionId: string;
  activityId: string;
  nextActivityId: string | null;
  nextStatus: 'active' | 'fallback-only' | null;
  duplicate: boolean;
};

type RequestState = {
  requestId: string;
  sessionId: string;
  packageId: string;
  packetSha256: string;
  sources: SourceEntry[];
};

type ReplyState = {
  call?: CallProvenance;
  replyId: string;
  importedAt: string;
  claimedAuthor: string | null;
  artifactSha256: string;
  reply: ReplyContent;
  nextActivityId: string | null;
};

type SubmissionState = {
  submissionId: string;
  number: number;
  submittedAt: string;
  revision: number;
  positions: PositionMap | null;
  derived: Derived | null;
  chosen: string[] | null;
  text: string | null;
  hintsRevealed: number[];
  /** Derived from the frozen lists of this and the previous submission, so replay agrees. */
  hintsRevealedSincePrevious: number[];
  digest: string;
  export: { fileSha256: string; exportedAt: string } | null;
  reply: ReplyState | null;
  replyCall: string | null;
};

type ActivityState = {
  call?: CallProvenance;
  activityId: string;
  request: RequestState;
  seq: number;
  importedAt: string;
  artifactSha256: string;
  claimedAuthor: string | null;
  fallbackText: string;
  activity: ActivityBody | null;
  issues: string[];
  parent: Parent | null;
  revision: number;
  positions: PositionMap;
  chosen: string[];
  hintsRevealed: number;
  submissions: SubmissionState[];
};

type Prefix = 'arq' | 'act' | 'sub' | 'rep' | 'cal';
type Dependencies = {
  readonly journal: Journal;
  readonly now?: () => Date;
  /** Boopy-owned identifiers; event IDs are always random. */
  readonly newId?: (prefix: Prefix) => string;
  /** Request files only: the local preparation, the committed package and later corrections. */
  readonly preparation?: Pick<HandoffPreparation, 'forPackage' | 'readPacket'>;
  readonly packageForId?: (id: string) => ContextPackage | undefined;
  readonly supersessions?: () => readonly Supersession[];
};

const randomId = (prefix: Prefix) => `${prefix}_${randomBytes(12).toString('base64url')}`;
const LIST_LIMIT = 20;
const CallAskedFields = ActivityCallView.pick({
  callId: true,
  kind: true,
  provider: true,
  model: true,
  requestId: true,
  submissionId: true,
}).extend({ fileSha256: Sha256 });
const CallFinishedFields = ActivityCallView.pick({
  callId: true,
  durationMs: true,
  failure: true,
  issues: true,
  activityId: true,
  replyId: true,
  nextActivityId: true,
}).extend({ outcome: CallState.exclude(['running']), metrics: CallMetrics.nullable() });

export class ActivityStore {
  readonly #dependencies: Dependencies;
  readonly #journal: Journal;
  readonly #now: () => Date;
  readonly #newId: (prefix: Prefix) => string;
  readonly #calls = new Map<string, { view: ActivityCallView; seq: number }>();
  readonly #requests = new Map<string, RequestState>();
  readonly #activities = new Map<string, ActivityState>();
  readonly #submissions = new Map<
    string,
    { activity: ActivityState; submission: SubmissionState }
  >();
  /** Files imported directly, by artifact SHA-256; next activities from replies are not here. */
  readonly #imports = new Map<string, ActivityState>();
  /** Imported reply files, by artifact SHA-256. */
  readonly #replies = new Map<string, { activity: ActivityState; submission: SubmissionState }>();

  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
    this.#journal = dependencies.journal;
    this.#now = dependencies.now ?? (() => new Date());
    this.#newId = dependencies.newId ?? randomId;
    for (const event of this.#journal.all()) this.#apply(event);
    for (const { view } of this.#calls.values())
      if (view.state === 'running')
        this.finishCall({
          callId: view.callId,
          outcome: 'interrupted',
          durationMs: null,
          failure: callFailure(view.kind, 'interrupted'),
          issues: [],
          activityId: view.kind === 'reply' ? view.activityId : null,
          replyId: null,
          nextActivityId: null,
          metrics: null,
        });
  }

  /** Newest import first, at most twenty. */
  list(): ActivitySummary[] {
    return [...this.#activities.values()]
      .sort((a, b) => b.importedAt.localeCompare(a.importedAt) || b.seq - a.seq)
      .slice(0, LIST_LIMIT)
      .map((state) => ({
        activityId: state.activityId,
        title: state.activity?.title ?? null,
        status: state.activity === null ? 'fallback-only' : 'active',
        importedAt: state.importedAt,
        claimedAuthor: state.claimedAuthor,
        submissions: state.submissions.length,
        awaitingReply: state.submissions.some((entry) =>
          state.call
            ? entry.replyCall !== null && this.call(entry.replyCall).state === 'running'
            : entry.export !== null && !entry.reply,
        ),
        ...(state.call ? { call: { provider: state.call.provider, model: state.call.model } } : {}),
        replyAvailable: state.submissions.some((entry) => entry.reply !== null),
        parentActivityId: state.parent?.activityId ?? null,
      }));
  }

  view(activityId: string): ActivityView {
    return this.#view(this.#find(activityId));
  }

  /**
   * Section 1: a request bound to exactly one completed, unchanged local preparation. The packet
   * is read only through HandoffPreparation.readPacket, which journals the disclosure.
   */
  async prepareRequest(
    input: unknown,
    options?: { delivery: 'sent-to-local-model' },
  ): Promise<RenderedFile & { requestId: string }> {
    const request = ActivityRequestInput.parse(input);
    const { preparation, packageForId, supersessions } = this.#dependencies;
    if (!preparation || !packageForId || !supersessions)
      throw new Error('Activity requests need a local preparation.');
    let status: ReturnType<typeof preparation.forPackage>;
    try {
      status = preparation.forPackage(request.packageId, request.preparationRequestId);
    } catch {
      throw unprepared();
    }
    if (status.sourceState !== 'unchanged') throw sourcesChanged();
    const pkg = packageForId(request.packageId);
    if (pkg === undefined || pkg.sessionId !== status.sessionId) throw unprepared();
    let packet: string;
    try {
      packet = await preparation.readPacket(status.sessionId, status.requestId);
    } catch (error) {
      throw /sources changed/i.test((error as Error).message) ? sourcesChanged() : unprepared();
    }
    const requestId = this.#newId('arq');
    const exportedAt = this.#now().toISOString();
    const sources = allowedSources(pkg, supersessions());
    const background = request.background ?? null;
    const packetSha256 = status.receipt.packetSha256;
    const file = renderRequestFile({
      requestId,
      exportedAt,
      goal: request.goal,
      personLanguage: request.personLanguage,
      background,
      sources,
      packageId: request.packageId,
      packetSha256,
      packet,
      ...(options ? { delivery: 'sent-by-boopy-to-local-model' as const } : {}),
    });
    this.#record(
      {
        type: 'activity.request-prepared',
        session: status.sessionId,
        actor: 'person',
        data: {
          requestId,
          packageId: request.packageId,
          preparation: { requestId: status.requestId, receiptId: status.receiptId, packetSha256 },
          goal: request.goal,
          personLanguage: request.personLanguage,
          background,
          sources,
          fileSha256: file.fileSha256,
          delivery: options?.delivery ?? 'not-sent',
        },
      },
      exportedAt,
    );
    return { requestId, ...file };
  }

  /**
   * Section 6. The attempt is frozen; the instructions around it are current. A repeat that
   * renders the latest export's bytes journals nothing. Bytes that differ, because instructions
   * changed in an upgrade, are rendered afresh and journaled as a new export; earlier exports stay
   * in the journal and the view shows the latest.
   */
  exportSubmission(submissionId: string): RenderedFile & { submissionId: string } {
    const found =
      typeof submissionId === 'string' ? this.#submissions.get(submissionId) : undefined;
    if (found === undefined) throw new BoopyError(404, 'submission_unknown', 'No such submission.');
    const { activity: state, submission } = found;
    const activity = state.activity;
    if (activity === null) throw new Error('Submission without an active activity.');
    const render = (exportedAt: string) =>
      renderSubmissionFile({
        submissionId,
        activityId: state.activityId,
        requestId: state.request.requestId,
        exportedAt,
        claimedAuthor: state.claimedAuthor,
        authorship: state.call ? 'called-by-boopy' : 'claimed-by-file',
        artifactSha256: state.artifactSha256,
        activity,
        submission,
      });
    const latest = submission.export;
    if (latest !== null) {
      const again = render(latest.exportedAt);
      if (again.fileSha256 === latest.fileSha256) return { submissionId, ...again };
    }
    const exportedAt = this.#now().toISOString();
    const file = render(exportedAt);
    this.#record(
      {
        type: 'activity.submission-exported',
        session: state.request.sessionId,
        actor: 'person',
        data: {
          submissionId,
          activityId: state.activityId,
          fileSha256: file.fileSha256,
          delivery: 'not-sent',
        },
      },
      exportedAt,
    );
    return { submissionId, ...file };
  }

  /** Section 2 import order: container, envelope, binding, duplicate, then the body. */
  importActivity(content: string, call?: CallProvenance): ImportResult {
    const read = readActivityFile(content);
    if (read.kind === 'unreadable') throw unreadable();
    if (read.kind === 'invalid') throw invalid(read.issues);
    const { binding } = read.file;
    const request = this.#requests.get(binding.requestId);
    if (
      request === undefined ||
      request.packageId !== binding.packageId ||
      request.packetSha256 !== binding.packetSha256
    )
      throw new BoopyError(
        409,
        'activity_binding_mismatch',
        'This file is not bound to a request recorded in Boopy.',
      );
    const existing = this.#imports.get(read.artifactSha256);
    if (existing && !call) return { ...importResult(existing), duplicate: true };
    const body = validateActivityBody(read.file.activity, sourceIds(request));
    if (call && body.issues.length) throw invalid(body.issues);
    const activityId = this.#newId('act');
    this.#record({
      type: 'activity.imported',
      session: request.sessionId,
      actor: call ? 'system' : 'person',
      data: {
        activityId,
        ...(call ? { call } : {}),
        requestId: request.requestId,
        artifactSha256: read.artifactSha256,
        container: read.container,
        claimedAuthor: read.file.author ?? null,
        fallbackText: read.file.fallbackText,
        activity: body.activity,
        issues: body.issues,
        parent: null,
      },
    });
    return { ...importResult(this.#find(activityId)), duplicate: false };
  }

  /** Replaces every position at once; only a released drag reaches the service. */
  arrange(activityId: string, input: unknown): ActivityView {
    const state = this.#find(activityId);
    const request = ArrangementRequest.parse(input);
    const activity = this.#changeable(state, request.revision);
    const component = arrangeOf(activity);
    if (component === null) throw missing('arrangement');
    // z.record drops a __proto__ key, so the raw keys are checked as sent.
    const sent = Object.keys((input as { positions: object }).positions);
    const keys = component.tokens.map((token) => token.key);
    if (sent.length !== keys.length || !keys.every((key) => sent.includes(key)))
      throw new BoopyError(
        400,
        'invalid_request',
        `positions: Send a position or null for exactly ${keys.join(', ')}.`,
      );
    const positions = Object.fromEntries(
      keys.map((key) => {
        const x = request.positions[key] ?? null;
        return [key, x === 0 ? 0 : x];
      }),
    );
    this.#record({
      type: 'activity.arranged',
      session: state.request.sessionId,
      actor: 'person',
      data: { activityId, revision: state.revision + 1, positions },
    });
    return this.view(activityId);
  }

  sequence(activityId: string, input: unknown): ActivityView {
    const state = this.#find(activityId);
    const request = SequenceRequest.parse(input);
    const activity = this.#changeable(state, request.revision);
    const component = sequenceOf(activity);
    if (component === null) throw missing('sequence');
    const keys = component.tiles.map((tile) => tile.key);
    if (!request.chosen.every((key) => keys.includes(key)))
      throw new BoopyError(400, 'invalid_request', 'chosen: Choose tiles from this activity.');
    this.#record({
      type: 'activity.sequenced',
      session: state.request.sessionId,
      actor: 'person',
      data: { activityId, revision: state.revision + 1, chosen: [...request.chosen] },
    });
    return this.view(activityId);
  }

  /** Hints are revealed in order. */
  revealHint(activityId: string, input: unknown): ActivityView {
    const state = this.#find(activityId);
    const request = RevisionRequest.parse(input);
    const activity = this.#changeable(state, request.revision);
    if (state.hintsRevealed >= activity.hints.length)
      throw new BoopyError(409, 'no_more_hints', 'There are no more hints.');
    this.#record({
      type: 'activity.hint-revealed',
      session: state.request.sessionId,
      actor: 'person',
      data: { activityId, revision: state.revision + 1, index: state.hintsRevealed },
    });
    return this.view(activityId);
  }

  /** Freezes what the person did; Boopy never says whether it is correct. */
  submit(activityId: string, input: unknown): ActivityView {
    const state = this.#find(activityId);
    const request = RevisionRequest.parse(input);
    const activity = this.#changeable(state, request.revision);
    if (!submittable(state, activity))
      throw new BoopyError(
        409,
        'nothing_to_submit',
        'Place something or choose a tile before submitting.',
      );
    const arrange = arrangeOf(activity);
    const sequence = sequenceOf(activity);
    this.#record({
      type: 'activity.submitted',
      session: state.request.sessionId,
      actor: 'person',
      data: {
        activityId,
        revision: state.revision + 1,
        submissionId: this.#newId('sub'),
        positions: arrange ? { ...state.positions } : null,
        derived: arrange ? deriveArrangement(arrange, state.positions) : null,
        chosen: sequence ? [...state.chosen] : null,
        text: sequence ? sequenceText(sequence, state.chosen) : null,
        hintsRevealed: Array.from({ length: state.hintsRevealed }, (_, index) => index),
        digest: digestOf(activity, {
          positions: state.positions,
          chosen: state.chosen,
          hintsRevealed: state.hintsRevealed,
        }),
      },
    });
    return this.view(activityId);
  }

  /** Section 7: one reply per exported submission, proven by echoing its digest. */
  importReply(content: string, call?: CallProvenance): ReplyResult {
    const read = readReplyFile(content);
    if (read.kind === 'unreadable') throw unreadable();
    if (read.kind === 'invalid') throw invalid(read.issues);
    const { binding } = read.file;
    const found = this.#submissions.get(binding.submissionId);
    if (
      found === undefined ||
      found.activity.activityId !== binding.activityId ||
      (found.submission.export === null && !(call && found.submission.replyCall === call.callId))
    )
      throw new BoopyError(
        409,
        'reply_binding_mismatch',
        'This reply is not bound to a submission exported from Boopy.',
      );
    const earlier = this.#replies.get(read.artifactSha256);
    if (earlier && !call) return { ...this.#replyResult(earlier), duplicate: true };
    const { activity, submission } = found;
    if (submission.reply !== null)
      throw new BoopyError(
        409,
        'reply_exists',
        'This submission already has a reply. Submit again in Boopy for a new one.',
      );
    if (normalizeEcho(read.file.echo) !== normalizeEcho(submission.digest))
      throw new BoopyError(
        409,
        'reply_not_matched',
        'This reply does not quote the exported submission exactly.',
      );
    const next = read.file.next;
    const body = next
      ? validateActivityBody(next.activity, sourceIds(activity.request), ['next', 'activity'])
      : null;
    if (call && body?.issues.length) throw invalid(body.issues);
    const replyId = this.#newId('rep');
    const nextActivityId = next ? this.#newId('act') : null;
    const claimedAuthor = read.file.author ?? null;
    this.#record({
      type: 'activity.reply-imported',
      session: activity.request.sessionId,
      actor: call ? 'system' : 'person',
      data: {
        replyId,
        submissionId: submission.submissionId,
        activityId: activity.activityId,
        artifactSha256: read.artifactSha256,
        container: read.container,
        claimedAuthor,
        ...(call ? { call } : {}),
        reply: JSON.parse(JSON.stringify(read.file.reply)),
        nextActivityId,
      },
    });
    if (next && body && nextActivityId)
      this.#record({
        type: 'activity.imported',
        session: activity.request.sessionId,
        actor: call ? 'system' : 'person',
        data: {
          activityId: nextActivityId,
          requestId: activity.request.requestId,
          artifactSha256: read.artifactSha256,
          container: read.container,
          claimedAuthor,
          ...(call ? { call } : {}),
          fallbackText: next.fallbackText,
          activity: body.activity,
          issues: body.issues,
          parent: {
            activityId: activity.activityId,
            submissionId: submission.submissionId,
            replyId,
          },
        },
      });
    return { ...this.#replyResult(found), duplicate: false };
  }

  call(callId: string): ActivityCallView {
    const found = this.#calls.get(callId);
    if (!found) throw new BoopyError(404, 'call_unknown', 'No such call.');
    return structuredClone(found.view);
  }

  calls(): ActivityCallView[] {
    return [...this.#calls.values()]
      .sort((a, b) => b.view.askedAt.localeCompare(a.view.askedAt) || b.seq - a.seq)
      .slice(0, LIST_LIMIT)
      .map(({ view }) => structuredClone(view));
  }

  askCall(input: Omit<CallAsked, 'callId'> & { actor: 'person' | 'system' }): ActivityCallView {
    const request = this.#requests.get(input.requestId);
    if (!request) throw new Error('Missing call request.');
    const { actor, ...data } = input;
    const callId = this.#newId('cal');
    this.#record({
      type: 'activity.call-asked',
      actor,
      session: request.sessionId,
      data: { ...data, callId },
    });
    return this.call(callId);
  }

  finishCall(data: CallFinished): ActivityCallView {
    const call = this.call(data.callId);
    const request = this.#requests.get(call.requestId);
    if (!request) throw new Error('Missing call request.');
    this.#record({
      type: 'activity.call-finished',
      actor: 'system',
      session: request.sessionId,
      data,
    });
    return this.call(data.callId);
  }

  renderSubmissionForCall(submissionId: string): RenderedFile {
    const found = this.#submissions.get(submissionId);
    if (!found?.activity.activity) throw new Error('Missing called submission.');
    const { activity: state, submission } = found;
    return renderSubmissionFile({
      submissionId,
      activityId: state.activityId,
      requestId: state.request.requestId,
      exportedAt: this.#now().toISOString(),
      claimedAuthor: null,
      authorship: 'called-by-boopy',
      artifactSha256: state.artifactSha256,
      activity: found.activity.activity,
      submission,
      delivery: 'sent-by-boopy-to-local-model',
    });
  }

  #replyResult(found: { activity: ActivityState; submission: SubmissionState }) {
    const reply = found.submission.reply;
    if (reply === null) throw new Error('Reply missing.');
    const next = reply.nextActivityId ? this.#activities.get(reply.nextActivityId) : undefined;
    return {
      replyId: reply.replyId,
      submissionId: found.submission.submissionId,
      activityId: found.activity.activityId,
      nextActivityId: next?.activityId ?? null,
      nextStatus: next ? statusOf(next) : null,
    };
  }

  #find(activityId: string): ActivityState {
    const state = typeof activityId === 'string' ? this.#activities.get(activityId) : undefined;
    if (state === undefined) throw new BoopyError(404, 'activity_unknown', 'No such activity.');
    return state;
  }

  /** Only an active activity at the named revision can change. */
  #changeable(state: ActivityState, revision: number): ActivityBody {
    if (state.activity === null)
      throw new BoopyError(409, 'activity_unavailable', 'This activity can only be shown as text.');
    if (revision !== state.revision)
      throw new BoopyError(409, 'stale_activity', 'This activity changed. Refresh it first.');
    return state.activity;
  }

  #record(event: ActivityEvent, at = this.#now().toISOString()): Recorded {
    const recorded = this.#journal.append(event, `evt_${randomUUID()}`, at);
    this.#apply(recorded);
    return recorded;
  }

  /** The same projection for live changes and startup replay; inconsistent events are refused. */
  #apply(event: Recorded): void {
    const corrupt: () => never = () => {
      throw new Error(`Activity event ${event.id} does not fit the recorded activities.`);
    };
    switch (event.type) {
      case 'activity.call-asked': {
        const data = event.data;
        if (
          !CallAskedFields.safeParse(data).success ||
          event.actor !== (data.kind === 'activity' ? 'person' : 'system')
        )
          corrupt();
        const request = this.#requests.get(data.requestId) ?? corrupt();
        if (this.#calls.has(data.callId) || request.sessionId !== event.session) corrupt();
        const found = data.submissionId ? this.#submissions.get(data.submissionId) : undefined;
        if (
          data.kind === 'reply' &&
          (!found?.activity.call ||
            found.activity.request !== request ||
            found.submission.replyCall !== null)
        )
          corrupt();
        if (data.kind === 'activity' && data.submissionId !== null) corrupt();
        const view: ActivityCallView = {
          callId: data.callId,
          kind: data.kind,
          state: 'running',
          provider: data.provider,
          model: data.model,
          askedAt: event.at,
          finishedAt: null,
          durationMs: null,
          packageId: request.packageId,
          requestId: request.requestId,
          submissionId: data.submissionId,
          activityId: found?.activity.activityId ?? null,
          replyId: null,
          nextActivityId: null,
          failure: null,
          issues: [],
        };
        this.#calls.set(data.callId, { view, seq: event.seq });
        if (found) found.submission.replyCall = data.callId;
        return;
      }
      case 'activity.call-finished': {
        const data = event.data;
        const parsed = CallFinishedFields.safeParse(data);
        if (
          !parsed.success ||
          parsed.data.issues.some((issue, index) => issue !== data.issues[index])
        )
          corrupt();
        const state = this.#calls.get(data.callId) ?? corrupt();
        if (state.view.state !== 'running') corrupt();
        const request = this.#requests.get(state.view.requestId) ?? corrupt();
        if (event.session !== request.sessionId || event.actor !== 'system') corrupt();
        if (data.failure !== null) {
          const code = data.failure.code;
          if (
            data.failure.message !== callFailure(state.view.kind, code).message ||
            (data.outcome === 'interrupted') !== (code === 'interrupted') ||
            (code === 'answer_invalid' ? data.issues.length === 0 : data.issues.length !== 0)
          )
            corrupt();
          if (code === 'interrupted' || code === 'assistant_busy') {
            if (
              data.durationMs !== null ||
              data.metrics !== null ||
              (code === 'assistant_busy' && state.view.kind !== 'reply')
            )
              corrupt();
          } else if (data.durationMs === null) corrupt();
        }
        if (data.outcome === 'imported') {
          if (data.failure !== null || data.issues.length !== 0 || data.durationMs === null)
            corrupt();
          if (state.view.kind === 'activity') {
            const activity = data.activityId ? this.#activities.get(data.activityId) : undefined;
            if (
              activity?.call?.callId !== data.callId ||
              activity.call.durationMs !== data.durationMs ||
              data.replyId !== null ||
              data.nextActivityId !== null
            )
              corrupt();
          } else {
            const found = this.#submissions.get(state.view.submissionId ?? '') ?? corrupt();
            if (
              data.activityId !== found.activity.activityId ||
              found.submission.reply?.call?.callId !== data.callId ||
              found.submission.reply.call.durationMs !== data.durationMs ||
              data.replyId !== found.submission.reply.replyId ||
              data.nextActivityId !== found.submission.reply.nextActivityId ||
              (data.nextActivityId !== null &&
                this.#activities.get(data.nextActivityId)?.call?.durationMs !== data.durationMs)
            )
              corrupt();
          }
        } else if (
          data.failure === null ||
          data.replyId !== null ||
          data.nextActivityId !== null ||
          data.activityId !== (state.view.kind === 'reply' ? state.view.activityId : null)
        )
          corrupt();
        Object.assign(state.view, {
          state: data.outcome,
          finishedAt: event.at,
          durationMs: data.durationMs,
          failure: data.failure,
          issues: data.issues,
          activityId: data.activityId,
          replyId: data.replyId,
          nextActivityId: data.nextActivityId,
        });
        return;
      }
      case 'activity.request-prepared': {
        const data = event.data;
        if (this.#requests.has(data.requestId)) corrupt();
        this.#requests.set(data.requestId, {
          requestId: data.requestId,
          sessionId: event.session,
          packageId: data.packageId,
          packetSha256: data.preparation.packetSha256,
          sources: data.sources,
        });
        return;
      }
      case 'activity.imported': {
        const data = event.data;
        const request = this.#requests.get(data.requestId) ?? corrupt();
        if (this.#activities.has(data.activityId)) corrupt();
        if (data.call) {
          const call = this.#pendingProvenance(
            data.call,
            data.requestId,
            data.parent ? 'reply' : 'activity',
            corrupt,
          );
          if (
            event.actor !== 'system' ||
            event.session !== request.sessionId ||
            data.claimedAuthor !== null ||
            data.activity === null ||
            data.issues.length !== 0 ||
            (data.parent && call.submissionId !== data.parent.submissionId)
          )
            corrupt();
        }
        if (data.parent !== null) {
          const parent = this.#submissions.get(data.parent.submissionId);
          if (
            parent?.activity.activityId !== data.parent.activityId ||
            parent.submission.reply?.replyId !== data.parent.replyId ||
            parent.submission.reply.nextActivityId !== data.activityId
          )
            corrupt();
        }
        const state: ActivityState = {
          activityId: data.activityId,
          request,
          seq: event.seq,
          importedAt: event.at,
          artifactSha256: data.artifactSha256,
          claimedAuthor: data.claimedAuthor,
          ...(data.call ? { call: data.call } : {}),
          fallbackText: data.fallbackText,
          activity: data.activity,
          issues: data.issues,
          parent: data.parent,
          revision: 0,
          positions: Object.fromEntries(
            (data.activity ? (arrangeOf(data.activity)?.tokens ?? []) : []).map((token) => [
              token.key,
              null,
            ]),
          ),
          chosen: [],
          hintsRevealed: 0,
          submissions: [],
        };
        this.#activities.set(data.activityId, state);
        if (data.parent === null && !data.call) this.#imports.set(data.artifactSha256, state);
        return;
      }
      case 'activity.arranged': {
        const state = this.#next(event.data, corrupt);
        state.positions = { ...event.data.positions };
        return;
      }
      case 'activity.sequenced': {
        const state = this.#next(event.data, corrupt);
        state.chosen = [...event.data.chosen];
        return;
      }
      case 'activity.hint-revealed': {
        const state = this.#next(event.data, corrupt);
        if (event.data.index !== state.hintsRevealed) corrupt();
        state.hintsRevealed += 1;
        return;
      }
      case 'activity.submitted': {
        const data = event.data;
        const state = this.#next(data, corrupt);
        if (this.#submissions.has(data.submissionId)) corrupt();
        const previous = state.submissions.at(-1)?.hintsRevealed ?? [];
        const submission: SubmissionState = {
          submissionId: data.submissionId,
          number: state.submissions.length + 1,
          submittedAt: event.at,
          revision: data.revision,
          positions: data.positions,
          derived: data.derived,
          chosen: data.chosen,
          text: data.text,
          hintsRevealed: data.hintsRevealed,
          hintsRevealedSincePrevious: data.hintsRevealed.filter(
            (index) => !previous.includes(index),
          ),
          digest: data.digest,
          export: null,
          reply: null,
          replyCall: null,
        };
        state.submissions.push(submission);
        this.#submissions.set(data.submissionId, { activity: state, submission });
        return;
      }
      case 'activity.submission-exported': {
        const found = this.#submissions.get(event.data.submissionId);
        if (found === undefined || found.activity.activityId !== event.data.activityId) corrupt();
        // A later export after an upgrade replaces the latest; earlier ones stay in the journal.
        found.submission.export = { fileSha256: event.data.fileSha256, exportedAt: event.at };
        return;
      }
      case 'activity.reply-imported': {
        const data = event.data;
        const found = this.#submissions.get(data.submissionId);
        if (
          found === undefined ||
          found.activity.activityId !== data.activityId ||
          (found.submission.export === null &&
            !(data.call && found.submission.replyCall === data.call.callId)) ||
          found.submission.reply !== null ||
          this.#replies.has(data.artifactSha256)
        )
          corrupt();
        if (data.call) {
          const call = this.#pendingProvenance(
            data.call,
            found.activity.request.requestId,
            'reply',
            corrupt,
          );
          if (
            call.submissionId !== data.submissionId ||
            data.claimedAuthor !== null ||
            event.actor !== 'system' ||
            event.session !== found.activity.request.sessionId
          )
            corrupt();
        }
        found.submission.reply = {
          replyId: data.replyId,
          importedAt: event.at,
          claimedAuthor: data.claimedAuthor,
          artifactSha256: data.artifactSha256,
          reply: data.reply,
          nextActivityId: data.nextActivityId,
          ...(data.call ? { call: data.call } : {}),
        };
        this.#replies.set(data.artifactSha256, found);
        return;
      }
      default:
        return;
    }
  }

  #pendingProvenance(
    provenance: CallProvenance,
    requestId: string,
    kind: 'activity' | 'reply',
    corrupt: () => never,
  ): ActivityCallView {
    const call = this.#calls.get(provenance.callId)?.view ?? corrupt();
    if (
      call.state !== 'running' ||
      call.kind !== kind ||
      call.requestId !== requestId ||
      call.provider !== provenance.provider ||
      call.model !== provenance.model ||
      !Number.isSafeInteger(provenance.durationMs) ||
      provenance.durationMs < 0
    )
      corrupt();
    return call;
  }

  /** A change event must name an active activity and the revision after its current one. */
  #next(data: { activityId: string; revision: number }, corrupt: () => never): ActivityState {
    const state = this.#activities.get(data.activityId);
    if (state?.activity === null || state === undefined || data.revision !== state.revision + 1)
      return corrupt();
    state.revision = data.revision;
    return state;
  }

  #view(state: ActivityState): ActivityView {
    const activity = state.activity;
    const sources = new Map(state.request.sources.map((source) => [source.sourceId, source]));
    return {
      activityId: state.activityId,
      revision: state.revision,
      status: statusOf(state),
      title: activity?.title ?? null,
      purpose: activity?.purpose ?? null,
      instruction: activity ? textView(activity.instruction) : null,
      fallbackText: state.fallbackText,
      issues: [...state.issues],
      provenance: {
        requestId: state.request.requestId,
        packageId: state.request.packageId,
        packetSha256: state.request.packetSha256,
        artifactSha256: state.artifactSha256,
        claimedAuthor: state.claimedAuthor,
        authorship: state.call ? 'called-by-boopy' : 'claimed-by-file',
        ...(state.call ? { call: { ...state.call } } : {}),
        importedAt: state.importedAt,
        parent: state.parent ? { ...state.parent } : null,
      },
      components: (activity?.components ?? []).map((component) =>
        component.type === 'arrange'
          ? arrangeView(component, state.positions, sources)
          : sequenceView(state.activityId, component, state.chosen),
      ),
      hints: {
        total: activity?.hints.length ?? 0,
        revealed: (activity?.hints ?? [])
          .slice(0, state.hintsRevealed)
          .map((hint, index) => ({ index, ...textView(hint) })),
      },
      canSubmit: activity !== null && submittable(state, activity),
      submissions: state.submissions.map((submission) => this.#submissionView(submission, state)),
    };
  }

  #submissionView(
    submission: SubmissionState,
    state: ActivityState,
  ): ActivityView['submissions'][number] {
    const reply = submission.reply;
    const next = reply?.nextActivityId ? this.#activities.get(reply.nextActivityId) : undefined;
    return {
      submissionId: submission.submissionId,
      number: submission.number,
      submittedAt: submission.submittedAt,
      revision: submission.revision,
      digest: submission.digest,
      arrange:
        submission.positions && submission.derived
          ? { positions: { ...submission.positions }, ...structuredClone(submission.derived) }
          : null,
      sequence:
        submission.chosen && submission.text !== null
          ? { chosen: [...submission.chosen], text: submission.text }
          : null,
      hintsRevealed: [...submission.hintsRevealed],
      hintsRevealedSincePrevious: [...submission.hintsRevealedSincePrevious],
      export: submission.export
        ? {
            state: 'exported-not-sent',
            fileSha256: submission.export.fileSha256,
            exportedAt: submission.export.exportedAt,
          }
        : null,
      ...(state.call
        ? {
            replyCall: submission.replyCall
              ? (({ callId, state, failure }) => ({ callId, state, failure }))(
                  this.call(submission.replyCall),
                )
              : null,
          }
        : {}),
      reply: reply
        ? {
            replyId: reply.replyId,
            ...(reply.call ? { call: { ...reply.call } } : {}),
            importedAt: reply.importedAt,
            claimedAuthor: reply.claimedAuthor,
            artifactSha256: reply.artifactSha256,
            summary: textView(reply.reply.summary),
            points: reply.reply.points.map((point) => ({
              about: point.about,
              text: point.text,
              language: point.language,
              gloss: point.gloss ?? null,
            })),
            nextActivityId: next?.activityId ?? null,
          }
        : null,
    };
  }
}

function unreadable() {
  return new BoopyError(
    400,
    'activity_unreadable',
    'This is not one JSON object, or one fenced json block, of at most 64 KiB.',
  );
}

function invalid(issues: string[]) {
  return new ActivityFileError(
    400,
    'activity_invalid',
    'This file does not match the Boopy activity format.',
    issues,
  );
}

function unprepared() {
  return new BoopyError(
    404,
    'prepared_unavailable',
    'No single completed local preparation is available for that package.',
  );
}

function sourcesChanged() {
  return new BoopyError(
    409,
    'sources_changed',
    'The sources changed after preparation. Prepare the handoff again.',
  );
}

function missing(component: 'arrangement' | 'sequence') {
  return new BoopyError(400, 'invalid_request', `This activity has no ${component}.`);
}

function sourceIds(request: RequestState): ReadonlySet<string> {
  return new Set(request.sources.map((source) => source.sourceId));
}

function statusOf(state: ActivityState): 'active' | 'fallback-only' {
  return state.activity === null ? 'fallback-only' : 'active';
}

function importResult(state: ActivityState) {
  return { activityId: state.activityId, status: statusOf(state), issues: [...state.issues] };
}

/** Something placed or some tile chosen. */
function submittable(state: ActivityState, activity: ActivityBody): boolean {
  const placed =
    arrangeOf(activity) !== null && Object.values(state.positions).some((x) => x !== null);
  return placed || (sequenceOf(activity) !== null && state.chosen.length > 0);
}

function textView(item: TextItem) {
  return { text: item.text, language: item.language, gloss: item.gloss ?? null };
}

function arrangeView(
  component: ArrangeComponent,
  positions: PositionMap,
  sources: ReadonlyMap<string, SourceEntry>,
) {
  const axis = component.axis;
  return {
    type: 'arrange' as const,
    axis:
      axis.kind === 'number'
        ? {
            kind: axis.kind,
            min: axis.min,
            max: axis.max,
            step: axis.step,
            unit: axis.unit ?? null,
          }
        : { ...axis },
    tokens: component.tokens.map((token) => {
      const position = positions[token.key] ?? null;
      const source = token.sourceId === null ? undefined : sources.get(token.sourceId);
      return {
        key: token.key,
        label: textView(token.label),
        source: source ? { sourceId: source.sourceId, label: source.label } : null,
        position,
        value: axis.kind === 'number' ? snapValue(axis, position) : null,
      };
    }),
    target: component.target ? { ...component.target } : null,
    derived: deriveArrangement(component, positions),
  };
}

function sequenceView(activityId: string, component: SequenceComponent, chosen: string[]) {
  return {
    type: 'sequence' as const,
    joiner: component.joiner,
    language: component.language,
    tiles: tileDisplayOrder(activityId, component.tiles).map((tile) => ({
      key: tile.key,
      text: tile.text,
      used: chosen.includes(tile.key),
    })),
    chosen: [...chosen],
    text: sequenceText(component, chosen),
  };
}

export function callFailure(kind: 'activity' | 'reply', code: CallFailure['code']): CallFailure {
  const reasons = {
    assistant_unreachable: "the local model isn't answering on this Mac.",
    assistant_timeout: "the local model didn't answer in time.",
    assistant_error: 'the local model reported an error.',
    answer_unreadable: "its answer wasn't one JSON object.",
    answer_invalid: "its answer didn't fit Boopy's format.",
    assistant_busy: 'Boopy was already waiting for the local model. Submit again in a moment.',
    interrupted: 'Boopy stopped before the local model answered.',
  };
  return {
    code,
    message:
      (kind === 'activity'
        ? "Boopy couldn't make practice from this: "
        : "Boopy couldn't make a reply from this: ") + reasons[code],
  };
}
