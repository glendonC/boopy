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
}
