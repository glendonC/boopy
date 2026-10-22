import type { z } from 'zod';
import type {
  AttentionView,
  Camera,
  ChoiceCard,
  ChoiceSelection,
  ContextPackage,
  ContextualAction,
  ContextualActionSelection,
  Cues,
  DepthGrid,
  DialogueView,
  Item,
  Relation,
  Scope,
  UtteranceKind,
} from './contracts.ts';
import type { Correction, TextLine } from './events.ts';
import type { HumanAction, Supersession } from './evidence-contract.ts';
import type { Recorded } from './journal.ts';
import type { Reading } from './utterance.ts';

export interface Observation {
  readonly id: string;
  readonly capturedAt: string;
  readonly source: import('./attention.ts').AttentionSource;
  readonly timestampTrusted: boolean;
  readonly frameSha256: string;
  readonly width: number;
  readonly height: number;
  readonly camera: Camera | null;
  readonly depth: DepthGrid | null;
  readonly cues: Cues;
}

export interface Utterance {
  readonly id: string;
  readonly text: string;
  readonly language: string;
  readonly source: 'speech' | 'typed' | 'suggestion' | 'choice';
  readonly selection?: ContextualActionSelection;
  readonly choiceSelection?: ChoiceSelection;
  readonly evidenceSource: import('./attention.ts').AttentionSource;
  readonly reading: Reading;
  readonly targetItemId: string | null;
  readonly observationId: string | null;
}

export interface Interpretation {
  readonly actions?: readonly ContextualAction[];
  readonly choice?: ChoiceCard;
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly observationId: string;
  readonly utteranceId: string;
}

export interface SessionState {
  readonly id: string;
  readonly startedAt: string;
  device: { model: string; app: string } | null;
  state: 'review' | 'committed';
  scope: Scope;
  referentId: string | null;
  intentId: string | null;
  items: Item[];
  relations: Relation[];
  observations: Observation[];
  utterances: Utterance[];
  interpretations: Interpretation[];
  interpretationFailure?: import('./contracts.ts').InterpretationFailure;
  text: { observationId: string; engine: string; lines: readonly TextLine[] }[];
  attention: AttentionView | null;
  dialogue: DialogueView | null;
  conversation: {
    speaker: 'person' | 'boopy';
    text: string;
    utteranceId: string;
    observationId: string | null;
    inputSource?: 'speech' | 'typed' | 'suggestion' | 'choice';
  }[];
  corrections: number;
  humanActions: (z.infer<typeof HumanAction> & { itemId: string })[];
  committed: { packageId: string; at: string } | null;
}

export interface Disclosure {
  readonly packageId: string;
  readonly agent: string;
  readonly via: 'mcp' | 'rest';
  readonly tool: string;
  readonly at: string;
}

/** Current state, rebuilt from the journal by applying every event in order. */
export class Projection {
  readonly sessions = new Map<string, SessionState>();
  readonly startRequests = new Map<
    string,
    {
      requestId: string;
      requestSha256: string;
      sessionId: string;
      status: 'pending' | 'succeeded' | 'failed' | 'interrupted';
      failureCode: string | null;
    }
  >();
  readonly packages = new Map<string, ContextPackage>();
  readonly disclosures: Disclosure[] = [];
  readonly supersessions: Supersession[] = [];

  static from(events: Iterable<Recorded>): Projection {
    const projection = new Projection();
    for (const event of events) projection.apply(event);
    return projection;
  }

  session(id: string): SessionState | undefined {
    return this.sessions.get(id);
  }

  apply(event: Recorded): void {
    if (event.type === 'session.started') {
      if (event.data.startRequest !== undefined) {
        const request = event.data.startRequest;
        if (this.startRequests.has(request.requestId))
          throw new Error('Duplicate session start identity.');
        this.startRequests.set(request.requestId, {
          ...request,
          sessionId: event.session,
          status: 'pending',
          failureCode: null,
        });
      }
      this.sessions.set(event.session, {
        id: event.session,
        startedAt: event.at,
        device: event.data.device,
        state: 'review',
        scope: 'object',
        referentId: null,
        intentId: null,
        items: [],
        relations: [],
        observations: [],
        utterances: [],
        interpretations: [],
        text: [],
        attention: null,
        dialogue: null,
        conversation: [],
        corrections: 0,
        humanActions: [],
        committed: null,
      });
      return;
    }
    if (event.type === 'session.start.finished') {
      const request = this.startRequests.get(event.data.requestId);
      if (
        request === undefined ||
        request.sessionId !== event.session ||
        request.status !== 'pending'
      )
        throw new Error('Invalid session start outcome.');
      request.status = event.data.outcome;
      request.failureCode = event.data.failureCode;
      return;
    }
    if (event.type === 'evidence.superseded') {
      this.supersessions.push({ ...event.data, eventId: event.id, at: event.at });
      return;
    }
    if (event.type === 'context.disclosed') {
      this.disclosures.push({ ...event.data, at: event.at });
      return;
    }
    // Live geometry has its own journal and never creates conversation facts.
    if (event.type === 'scene.observed') return;
    // Task revisions are a separate projection. They must not create conversation facts.
    if (
      event.type === 'task.opened' ||
      event.type === 'task.action-accepted' ||
      event.type === 'task.action-rejected' ||
      event.type === 'task.provider-accepted' ||
      event.type === 'task.provider-rejected'
    )
      return;
    const session = this.sessions.get(event.session);
    if (session === undefined) throw new Error(`Event ${event.id} names unknown session.`);
    switch (event.type) {
      case 'observation.recorded':
        session.observations.push({
          id: event.data.observationId,
          capturedAt: event.data.capturedAt,
          source: event.data.source ?? 'unknown',
          timestampTrusted: event.data.timestampTrusted ?? false,
          frameSha256: event.data.frameSha256,
          width: event.data.width,
          height: event.data.height,
          camera: event.data.camera,
          depth: event.data.depth,
          cues: event.data.cues,
        });
        return;
      case 'attention.decided':
        session.attention = event.data;
        return;
      case 'interaction.focused': {
        const item = session.items.find((candidate) => candidate.id === event.data.itemId);
        const utterance = session.utterances.find(
          (candidate) => candidate.id === event.data.utteranceId,
        );
        if (
          event.actor !== 'person' ||
          item === undefined ||
          item.status === 'ignored' ||
          item.status === 'rejected' ||
          utterance?.reading.kind !== 'refocus' ||
          utterance.targetItemId !== item.id
        )
          throw new Error('Invalid spatial reference selection.');
        session.referentId = item.id;
        return;
      }
      case 'interaction.choice-selected': {
        const dialogue = session.dialogue;
        const choice = dialogue?.choice;
        if (
          event.actor !== 'person' ||
          dialogue?.utteranceId !== event.data.utteranceId ||
          dialogue.at !== event.data.responseAt ||
          choice?.id !== event.data.cardId ||
          !choice.options.some((option) => option.id === event.data.optionId)
        )
          throw new Error('Invalid choice selection.');
        session.dialogue = {
          ...dialogue,
          choice: { ...choice, selectedOptionId: event.data.optionId },
        };
        return;
      }
      case 'interaction.responded':
        session.dialogue = { ...event.data, at: event.at };
        session.conversation.push({
          speaker: 'boopy',
          text: event.data.text,
          utteranceId: event.data.utteranceId,
          observationId:
            session.interpretations.find(
              (interpretation) => interpretation.utteranceId === event.data.utteranceId,
            )?.observationId ??
            session.utterances.find((u) => u.id === event.data.utteranceId)?.observationId ??
            null,
        });
        session.conversation = session.conversation.slice(-12);
        return;
      case 'utterance.heard':
        session.conversation.push({
          speaker: 'person',
          text: event.data.text,
          utteranceId: event.data.utteranceId,
          observationId: event.data.observationId,
          inputSource: event.data.source,
        });
        session.conversation = session.conversation.slice(-12);
        session.attention = null;
        session.dialogue = null;
        session.utterances.push({
          id: event.data.utteranceId,
          text: event.data.text,
          language: event.data.language,
          source: event.data.source,
          ...(event.data.choiceSelection === undefined
            ? {}
            : { choiceSelection: event.data.choiceSelection }),
          ...(event.data.selection === undefined ? {} : { selection: event.data.selection }),
          evidenceSource: event.data.evidenceSource ?? 'unknown',
          reading: event.data.reading,
          targetItemId: event.data.targetItemId,
          observationId: event.data.observationId,
        });
        return;
      case 'text.read':
        session.text.push({
          observationId: event.data.observationId,
          engine: event.data.engine,
          lines: event.data.lines,
        });
        return;
      case 'interpretation.proposed':
        session.interpretationFailure = undefined;
        acceptProposal(session, event.data);
        session.interpretations.push({
          id: event.data.interpretationId,
          ...(event.data.actions === undefined ? {} : { actions: event.data.actions }),
          ...(event.data.choice === undefined ? {} : { choice: event.data.choice }),
          provider: event.data.provider,
          model: event.data.model,
          latencyMs: event.data.latencyMs,
          observationId: event.data.observationId,
          utteranceId: event.data.utteranceId,
        });
        return;
      case 'interpretation.failed':
        session.interpretationFailure = {
          code: event.data.code ?? 'interpreter_failed',
          utteranceId: event.data.utteranceId,
          message: event.data.message,
        };
        return;
      case 'grounding.refined': {
        const item = session.items.find((candidate) => candidate.id === event.data.itemId);
        if (
          item === undefined ||
          item.interpretationId !== event.data.interpretationId ||
          item.grounding.observationId !== event.data.observationId
        )
          return;
        item.grounding = {
          ...item.grounding,
          ...(event.data.contour !== undefined && { contour: [...event.data.contour] }),
          spatial: event.data.spatial,
        };
        return;
      }
      case 'item.corrected':
        session.dialogue = null;
        if (event.data.utteranceId === null) session.attention = null;
        if (event.data.op !== 'rescope') {
          session.humanActions.push({
            itemId: event.data.op === 'add' ? event.data.item.id : event.data.itemId,
            eventId: event.id,
            at: event.at,
            op: event.data.op,
            utteranceId: event.data.utteranceId,
          });
        }
        correct(session, event.data);
        session.corrections += 1;
        return;
      case 'context.committed':
        session.dialogue = null;
        session.state = 'committed';
        session.committed = { packageId: event.data.packageId, at: event.at };
        this.packages.set(event.data.packageId, event.data.package);
        return;
    }
  }
}
