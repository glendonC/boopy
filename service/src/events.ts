import type { ActivityEvent } from './activity.ts';
import type {
  AttentionView,
  Box,
  Camera,
  ChoiceCard,
  ChoiceSelection,
  ContextPackage,
  ContextualAction,
  ContextualActionSelection,
  Cues,
  DepthGrid,
  Item,
  ItemAction,
  Point,
  Relation,
  Scope,
  SpatialEvidence,
} from './contracts.ts';
import type { SupersedeRequest } from './evidence-contract.ts';
import type { HandoffPreparationEvent } from './handoff-preparation.ts';
import type { TaskEvent } from './interaction/contract.ts';
import type { RecordedEvent, RecordedObservation } from './recorded-source.ts';
import type { Reading } from './utterance.ts';

/** Who caused an event: the person, Boopy itself, a model, or an agent reading context. */
export type Actor = 'person' | 'system' | `model:${string}` | `agent:${string}`;

/**
 * How the Mac chose the subject at a pointing boop's gaze: the model's own box, the recording's
 * outline, or nothing found there, which leaves the boop with no subject.
 */
export interface ReferentPoint {
  readonly cue: 'gaze';
  readonly from: 'model-object' | 'recorded-outline' | 'nothing';
}

/** A line of text read by OCR, with its box in the frame. */
export interface TextLine {
  readonly text: string;
  readonly confidence: number;
  readonly box: Box;
}

type Via = 'pinch' | 'voice';
export type TurnStage = 'transcribing' | 'reading-text' | 'interpreting' | 'refining-geometry';

/** A person's correction. Model output never produces one. */
export type Correction =
  | {
      readonly op: ItemAction;
      readonly itemId: string;
      readonly via: Via;
      readonly utteranceId: string | null;
      readonly reason?: string;
    }
  | {
      readonly op: 'relabel';
      readonly itemId: string;
      readonly label: string;
      readonly via: Via;
      readonly utteranceId: string | null;
    }
  | {
      readonly op: 'note';
      readonly itemId: string;
      readonly note: string;
      readonly via: Via;
      readonly utteranceId: string | null;
    }
  | {
      readonly op: 'add';
      readonly item: Item;
      readonly via: Via;
      readonly utteranceId: string | null;
    }
  | {
      readonly op: 'rescope';
      readonly scope: Scope;
      readonly via: Via;
      readonly utteranceId: string | null;
    };

interface Event<Type extends string, Data> {
  readonly type: Type;
  readonly session: string;
  readonly actor: Actor;
  readonly data: Data;
}

export type BoopyEvent =
  | ActivityEvent
  | TaskEvent
  | Event<
      'turn.processing',
      {
        readonly stage: TurnStage;
        readonly utteranceId: string | null;
        readonly observationId: string | null;
      }
    >
  | HandoffPreparationEvent
  | RecordedEvent
  | Event<
      'scene.observed',
      {
        readonly streamId: string;
        readonly frameId: string;
        readonly sequence: number;
        readonly capturedAt: string;
        readonly frameSha256: string;
        readonly camera: Camera | null;
        readonly width: number;
        readonly height: number;
        readonly provider: string;
        readonly model: string;
        readonly verification: 'proposed';
        readonly frameRetained: false;
        readonly latencyMs: number;
        /** Outlines left out because their edges cross or touch; older events have none. */
        readonly outlinesLeftOut?: number;
        readonly objects: readonly {
          label: string;
          confidence: number;
          box: Box;
          contour: Point[];
        }[];
      }
    >
  | Event<
      'session.started',
      {
        readonly device: { model: string; app: string } | null;
        readonly startRequest?: { readonly requestId: string; readonly requestSha256: string };
      }
    >
  | Event<
      'session.start.finished',
      {
        readonly requestId: string;
        readonly outcome: 'succeeded' | 'failed' | 'interrupted';
        readonly failureCode: string | null;
      }
    >
  | Event<
      'observation.recorded',
      {
        readonly observationId: string;
        readonly frameSha256: string;
        readonly width: number;
        readonly height: number;
        /** Null only for a recorded frame whose file gives no capture time. */
        readonly capturedAt: string | null;
        readonly source?: import('./attention.ts').AttentionSource;
        readonly timestampTrusted?: boolean;
        readonly camera: Camera | null;
        readonly depth: DepthGrid | null;
        readonly cues: Cues;
        /** A frame of recorded footage the operator showed, never a live view. */
        readonly recorded?: RecordedObservation;
      }
    >
  | Event<
      'utterance.heard',
      {
        readonly utteranceId: string;
        readonly observationId: string | null;
        readonly text: string;
        readonly language: string;
        readonly source: 'speech' | 'typed' | 'suggestion' | 'choice' | 'pointing';
        readonly selection?: ContextualActionSelection;
        readonly choiceSelection?: ChoiceSelection;
        readonly evidenceSource?: import('./attention.ts').AttentionSource;
        readonly audioSha256: string | null;
        readonly transcriber: string | null;
        readonly targetItemId: string | null;
        readonly reading: Reading;
      }
    >
  | Event<
      'text.read',
      {
        readonly observationId: string;
        readonly engine: string;
        readonly region: Box | null;
        readonly lines: readonly TextLine[];
      }
    >
  | Event<
      'interpretation.proposed',
      {
        readonly interpretationId: string;
        readonly observationId: string;
        readonly utteranceId: string;
        readonly provider: string;
        readonly model: string;
        readonly latencyMs: number;
        readonly scope: Scope;
        readonly referentId: string | null;
        /** Set when the Mac, not the model, chose the subject from the person's near cue. */
        readonly referentCue?: import('./interpret/cue-referent.ts').ReferentCue;
        /** Set on a pointing boop whose subject the Mac, not the model, chose at the gaze. */
        readonly referentPoint?: ReferentPoint;
        /** Set when the model was told the words Boopy can teach, from this term snapshot. */
        readonly hint?: {
          readonly kind: 'teachable-words';
          readonly count: number;
          readonly snapshotSha256: string;
        };
        readonly intentId: string | null;
        readonly items: readonly Item[];
        readonly relations: readonly Relation[];
        /** The model's own output, kept for audit. */
        readonly raw: string;
        readonly actions?: readonly ContextualAction[];
        readonly choice?: ChoiceCard;
        /** The model saw this part of the frame around the gaze; its boxes were mapped back. */
        readonly view?: { readonly kind: 'gaze-crop'; readonly region: Box };
      }
    >
  | Event<
      'interpretation.retried',
      {
        readonly observationId: string;
        readonly utteranceId: string;
        readonly provider: string;
        readonly model: string;
        /** The model answered with JSON that does not match the schema; it is asked once more. */
        readonly reason: 'output-not-schema';
        readonly elapsedMs: number;
      }
    >
  | Event<
      'interpretation.failed',
      {
        readonly observationId: string;
        readonly utteranceId: string;
        readonly provider: string;
        readonly model: string;
        readonly message: string;
        readonly code?: 'interpreter_unavailable' | 'interpreter_failed';
      }
    >
  | Event<'attention.decided', AttentionView>
  | Event<'interaction.choice-selected', ChoiceSelection>
  | Event<'interaction.focused', { readonly utteranceId: string; readonly itemId: string }>
  | Event<
      'interaction.responded',
      {
        readonly speaker: 'boopy';
        readonly text: string;
        readonly utteranceId: string;
        readonly actions?: ContextualAction[];
        readonly choice?: ChoiceCard;
      }
    >
  | Event<
      'speech.requested',
      { readonly attemptId: string; readonly utteranceId: string; readonly responseAt: string }
    >
  | Event<
      'speech.finished',
      {
        readonly attemptId: string;
        readonly utteranceId: string;
        readonly responseAt: string;
        readonly outcome: 'generated' | 'failed' | 'cancelled' | 'stale';
        readonly voice?: string;
        readonly language?: string;
        readonly latencyMs?: number;
        readonly bytes?: number;
      }
    >
  | Event<'item.corrected', Correction>
  | Event<'evidence.superseded', SupersedeRequest>
  | Event<
      'grounding.refined',
      {
        readonly itemId: string;
        readonly observationId: string;
        readonly interpretationId: string;
        readonly contour?: readonly Point[];
        readonly spatial: SpatialEvidence;
      }
    >
  | Event<'context.committed', { readonly packageId: string; readonly package: ContextPackage }>
  | Event<
      'context.disclosed',
      {
        readonly packageId: string;
        readonly agent: string;
        readonly via: 'mcp' | 'rest';
        readonly tool: string;
      }
    >
  | Event<
      'grokbot.delivery.started',
      {
        readonly momentId: string;
        readonly attempt: number;
        readonly taskId: string;
        readonly runUuid: string | null;
      }
    >
  | Event<
      'grokbot.delivery.failed',
      {
        readonly momentId: string;
        readonly attempt: number;
        readonly taskId: string;
        readonly status: number | null;
      }
    >;

export type EventType = BoopyEvent['type'];
