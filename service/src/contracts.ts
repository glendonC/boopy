/**
 * The wire vocabulary between the headset, the service and agents. Image coordinates are always
 * normalized 0 to 1 with the origin at the top-left (x right, y down); provider grids are
 * converted at their adapters, and the headset flips y into its camera viewport.
 */
import { z } from 'zod';
import { EvidenceBundle } from './evidence-contract.ts';

const Unit = z.number().min(0).max(1);

export const Point = z.object({ x: Unit, y: Unit });
export type Point = z.infer<typeof Point>;

export const Box = z
  .object({ x0: Unit, y0: Unit, x1: Unit, y1: Unit })
  .refine((box) => box.x0 < box.x1 && box.y0 < box.y1, 'A box needs a positive area.');
export type Box = z.infer<typeof Box>;

export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export const Quat = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export const Pose = z.object({ position: Vec3, rotation: Quat });
export type Pose = z.infer<typeof Pose>;

/** The passthrough camera at the frame's own timestamp, as MRUK's PassthroughCameraAccess reports it. */
export const Camera = z.object({
  eye: z.enum(['left', 'right']),
  pose: Pose,
  focalLength: z.tuple([z.number(), z.number()]),
  principalPoint: z.tuple([z.number(), z.number()]),
  sensorResolution: z.tuple([z.number().int(), z.number().int()]),
});
export type Camera = z.infer<typeof Camera>;

/**
 * Distances in meters along rays through the centers of a grid over the frame, row by row from
 * the top-left, sampled when the frame was captured; null where depth had no answer.
 */
export const DepthGrid = z
  .object({
    columns: z.number().int().min(1).max(64),
    rows: z.number().int().min(1).max(64),
    meters: z.array(z.number().nullable()),
  })
  .refine((grid) => grid.meters.length === grid.columns * grid.rows, 'One distance per cell.');
export type DepthGrid = z.infer<typeof DepthGrid>;

export const AttentionSource = z.enum([
  'current-surroundings',
  'displayed-image',
  'virtual-scene',
  'past-recollection',
  'unknown',
]);
export const AttentionInput = z.object({
  scope: z.enum(['scene', 'target']),
  evidence: z.enum(['none', 'visual']),
  source: AttentionSource,
  observationId: z.string().min(1).optional(),
  ambiguousTarget: z.boolean().default(false),
  ocrRequested: z.boolean().default(false),
  segmentationRequested: z.boolean().default(false),
  maxAgeMs: z.number().finite().min(0).max(60000).default(15000),
});
export type AttentionInput = z.infer<typeof AttentionInput>;
export const AttentionView = z.object({
  utteranceId: z.string(),
  source: AttentionSource,
  action: z.enum(['no-visual-work', 'reuse', 'fresh-view', 'clarify']),
  reason: z.string(),
  observationId: z.string().nullable(),
  work: z.object({ ocr: z.boolean(), segmentation: z.boolean() }),
});
export type AttentionView = z.infer<typeof AttentionView>;
export const ContextualAction = z.object({
  id: z.string().min(1),
  question: z.string().trim().min(1).max(120),
  targetItemId: z.string().nullable(),
  observationId: z.string().nullable(),
});
export type ContextualAction = z.infer<typeof ContextualAction>;
export const ContextualActionSelection = z.object({
  utteranceId: z.string().min(1),
  responseAt: z.string().min(1),
  actionId: z.string().min(1),
});
export type ContextualActionSelection = z.infer<typeof ContextualActionSelection>;
export const ChoiceCard = z.object({
  id: z.string().min(1),
  kind: z.literal('choice'),
  prompt: z.string().trim().min(1).max(160),
  options: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().trim().min(1).max(60),
        value: z.string().trim().min(1).max(240),
      }),
    )
    .min(2)
    .max(3),
  selectedOptionId: z.string().nullable(),
});
export type ChoiceCard = z.infer<typeof ChoiceCard>;
export const ChoiceSelection = z.strictObject({
  utteranceId: z.string().min(1),
  responseAt: z.string().min(1),
  cardId: z.string().min(1),
  optionId: z.string().min(1),
});
export type ChoiceSelection = z.infer<typeof ChoiceSelection>;
export const DialogueView = z.object({
  speaker: z.literal('boopy'),
  choice: ChoiceCard.optional(),
  actions: z.array(ContextualAction).max(2).optional(),
  text: z.string(),
  utteranceId: z.string(),
  at: z.string(),
});
export type DialogueView = z.infer<typeof DialogueView>;

export const Frame = z.object({
  /** JPEG, base64. */
  jpeg: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  capturedAt: z.iso.datetime({ offset: true }),
  source: AttentionSource.optional(),
  timestampTrusted: z.boolean().optional(),
  camera: Camera.optional(),
  depth: DepthGrid.optional(),
});
export type Frame = z.infer<typeof Frame>;

/** Where a ray met the room, projected into the frame. */
export const Cue = z.object({
  point: Point,
  world: Vec3.optional(),
  /** The ray met a surface in depth, rather than being placed at a fallback distance. */
  onSurface: z.boolean(),
});
export type Cue = z.infer<typeof Cue>;

export const Cues = z.object({
  gaze: Cue.optional(),
  pointer: Cue.extend({ hand: z.enum(['left', 'right']) }).optional(),
  /** The card under the ray when the pinch began. */
  targetItemId: z.string().optional(),
});
export type Cues = z.infer<typeof Cues>;

export const RecordingId = z.string().regex(/^rec_[a-f0-9]{32}$/);
export const RecordedFrameId = z.string().regex(/^rfr_[a-f0-9]{32}$/);

/** A frame of the recording the Mac is showing, named by its opaque ids. The Mac sends the still. */
export const RecordedFrameRef = z.strictObject({
  recordingId: RecordingId,
  frameId: RecordedFrameId,
});
export type RecordedFrameRef = z.infer<typeof RecordedFrameRef>;

/** Where an observation's recorded still came from, as views and packages show it. */
const RecordedProvenance = z.object({
  recordingId: z.string(),
  frameId: z.string(),
  seconds: z.number().nullable(),
});

/**
 * A recorded frame has no room behind it: no camera, depth, pointer, world point or surface, and
 * its source is the person's recording, never their surroundings.
 */
function recordedTurn(
  request: {
    frame?: unknown;
    recordedFrame?: unknown;
    cues?: { gaze?: { world?: unknown; onSurface: boolean }; pointer?: unknown };
    attention?: { source: string; evidence: string };
  },
  context: z.RefinementCtx,
): void {
  if (request.recordedFrame === undefined) return;
  const problem = (message: string, path: string[]) =>
    context.addIssue({ code: 'custom', message, path });
  if (request.frame !== undefined)
    problem('Send a frame or a recorded frame, not both.', ['recordedFrame']);
  if (request.cues?.pointer !== undefined)
    problem('A recorded frame takes no pointer.', ['cues', 'pointer']);
  if (request.cues?.gaze?.world !== undefined || request.cues?.gaze?.onSurface === true)
    problem('A recorded frame has no room surface behind it.', ['cues', 'gaze']);
  if (request.attention !== undefined && request.attention.source !== 'past-recollection')
    problem('A recorded frame is a past recollection.', ['attention', 'source']);
  if (request.attention?.evidence === 'none')
    problem('A recorded frame is visual evidence.', ['attention', 'evidence']);
}

export const Speech = z.union([
  z.object({ wav: z.string().min(1) }),
  z.object({ text: z.string().trim().min(1).max(2000), language: z.string().optional() }),
]);
export type Speech = z.infer<typeof Speech>;

export const Device = z.object({ model: z.string().max(100), app: z.string().max(100) });
export const StartRequestId = z.uuid();

export const StartSessionRequest = z
  .object({
    requestId: StartRequestId.optional(),
    frame: Frame.optional(),
    recordedFrame: RecordedFrameRef.optional(),
    attention: AttentionInput.optional(),
    cues: Cues,
    speech: Speech,
    device: Device.optional(),
  })
  .refine(
    (request) =>
      request.frame !== undefined ||
      request.recordedFrame !== undefined ||
      request.attention?.evidence === 'none',
    {
      message: 'A frame is required unless this is an explicit nonvisual turn.',
      path: ['frame'],
    },
  )
  .superRefine(recordedTurn);
export type StartSessionRequest = z.infer<typeof StartSessionRequest>;

export const UtteranceRequest = z
  .object({
    selection: ContextualActionSelection.optional(),
    attention: AttentionInput.optional(),
    frame: Frame.optional(),
    recordedFrame: RecordedFrameRef.optional(),
    cues: Cues.optional(),
    speech: Speech,
  })
  .superRefine(recordedTurn);
export type UtteranceRequest = z.infer<typeof UtteranceRequest>;

/** What a pinch on a card does. */
export const ItemAction = z.enum(['confirm', 'reject', 'ignore', 'known', 'matters', 'reset']);
export type ItemAction = z.infer<typeof ItemAction>;

export const ActionRequest = z.object({ itemId: z.string(), action: ItemAction });
export type ActionRequest = z.infer<typeof ActionRequest>;

export const Scope = z.enum(['object', 'region', 'text', 'scene']);
export type Scope = z.infer<typeof Scope>;

export const ItemStatus = z.enum(['proposed', 'confirmed', 'rejected', 'ignored', 'known']);
export type ItemStatus = z.infer<typeof ItemStatus>;

export const Origin = z.enum(['model', 'person']);
export type Origin = z.infer<typeof Origin>;

/** Spatial detector evidence is proposed independently of a person's item confirmation. */
export const SpatialEvidence = z.object({
  /** Hosted SAM, or the local outline pass over a recorded frame. */
  provider: z.enum(['meta', 'local']),
  model: z.string().min(1).max(100),
  concept: z.string().min(1).max(120),
  latencyMs: z.number().nonnegative(),
  confidence: Unit.nullable(),
  verification: z.literal('proposed'),
  outcome: z.enum(['contour', 'no-match', 'ambiguous', 'failed']),
  frameSha256: z.string(),
  utteranceId: z.string(),
  maskSha256: z.string().optional(),
  /** Set when the shape came from the recording's own outline pass on this exact frame. */
  from: z.literal('recorded-outline').optional(),
  /** How much the outline's box overlapped the item's box (intersection over union). */
  overlap: Unit.optional(),
});
export type SpatialEvidence = z.infer<typeof SpatialEvidence>;

/** Original grounding plus separately attributed, proposed segmentation when enabled. */
export const Grounding = z.object({
  kind: z.enum(['box', 'point', 'scene']),
  observationId: z.string().optional(),
  box: Box.optional(),
  point: Point.optional(),
  /** Ordered outer boundary, closed implicitly; the original model box is retained. */
  contour: z.array(Point).min(3).max(256).optional(),
  spatial: SpatialEvidence.optional(),
});
export type Grounding = z.infer<typeof Grounding>;

/**
 * Anything the person and the model talk about. `kind` is open: object, text, place, activity,
 * quality, topic, goal, vocabulary, grammar, question, note, and new kinds without a schema change.
 */
export const Item = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  gloss: z.string().optional(),
  statement: z.string(),
  grounding: Grounding,
  /** The model's confidence; null for what the person said themselves. */
  confidence: z.number().min(0).max(1).nullable(),
  why: z.string().optional(),
  origin: Origin,
  status: ItemStatus,
  emphasis: z.boolean(),
  note: z.string().optional(),
  /** The model's label before the person changed it. */
  proposedLabel: z.string().optional(),
  /** Exact text read by OCR that backs this item. */
  text: z.array(z.string()).optional(),
  interpretationId: z.string().optional(),
});
export type Item = z.infer<typeof Item>;

export const Relation = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: z.string(),
  label: z.string().optional(),
});
export type Relation = z.infer<typeof Relation>;

export const UtteranceKind = z.enum(['ask', 'correct', 'commit', 'unclear']);
export type UtteranceKind = z.infer<typeof UtteranceKind>;

/** Headset-only request for the exact current Boopy reply; callers cannot supply speech text. */
export const SpeechOutputRequest = z
  .object({
    utteranceId: z.string().min(1).max(160),
    responseAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type SpeechOutputRequest = z.infer<typeof SpeechOutputRequest>;
export const SpeechOutputResponse = z.object({
  sessionId: z.string(),
  utteranceId: z.string(),
  responseAt: z.string(),
  speaker: z.literal('boopy'),
  mimeType: z.literal('audio/wav'),
  wav: z.string(),
  language: z.string(),
  voice: z.string(),
  latencyMs: z.number().nonnegative(),
});
export type SpeechOutputResponse = z.infer<typeof SpeechOutputResponse>;

export const InterpretationFailure = z.object({
  code: z.enum(['interpreter_unavailable', 'interpreter_failed']),
  utteranceId: z.string(),
  message: z.string(),
});
export type InterpretationFailure = z.infer<typeof InterpretationFailure>;

export const SessionView = z.object({
  id: z.string(),
  state: z.enum(['review', 'committed']),
  scope: Scope,
  referentId: z.string().nullable(),
  intentId: z.string().nullable(),
  items: z.array(Item),
  relations: z.array(Relation),
  observations: z.array(
    z.object({
      id: z.string(),
      capturedAt: z.string().nullable(),
      recorded: RecordedProvenance.optional(),
    }),
  ),
  utterances: z.array(
    z.object({ id: z.string(), text: z.string(), language: z.string(), kind: UtteranceKind }),
  ),
  model: z.object({ provider: z.string(), id: z.string(), latencyMs: z.number() }).nullable(),
  /** One line for the person: what was heard, what changed, or what Boopy needs. */
  notice: z.string().nullable(),
  interpretationFailure: InterpretationFailure.nullable().optional(),
  attention: AttentionView.nullable().optional(),
  dialogue: DialogueView.nullable().optional(),
  speechOutputAvailable: z.boolean().optional(),
  committed: z.object({ packageId: z.string(), at: z.string(), summary: z.string() }).nullable(),
});
export type SessionView = z.infer<typeof SessionView>;

export const StartRecoveryView = z.object({
  requestId: StartRequestId,
  sessionId: z.string(),
  status: z.enum(['pending', 'succeeded', 'failed', 'interrupted']),
  failureCode: z.string().nullable(),
  view: SessionView.nullable(),
});
export type StartRecoveryView = z.infer<typeof StartRecoveryView>;

const PackageItem = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  gloss: z.string().optional(),
  statement: z.string(),
  /** How the person verified it. */
  verification: z.enum(['confirmed', 'accepted', 'authored', 'corrected']),
  emphasis: z.boolean(),
  confidence: z.number().nullable(),
  note: z.string().optional(),
  proposedLabel: z.string().optional(),
  text: z.array(z.string()).optional(),
  grounding: Grounding,
  proposedBy: z.string().optional(),
});
export type PackageItem = z.infer<typeof PackageItem>;

/** What agents read: built deterministically from the journal, never written by a model. */
const LegacyContextPackage = z.object({
  type: z.literal('boopy.context-package'),
  version: z.literal(1),
  id: z.string(),
  sessionId: z.string(),
  committedAt: z.string(),
  title: z.string(),
  intent: z
    .object({
      said: z.string(),
      reading: z.string(),
      verification: z.enum(['confirmed', 'accepted', 'authored', 'corrected']),
      confidence: z.number().nullable(),
    })
    .nullable(),
  scope: Scope,
  referent: z.string().nullable(),
  items: z.array(PackageItem),
  known: z.array(z.object({ id: z.string(), label: z.string(), gloss: z.string().optional() })),
  rejected: z.array(z.object({ id: z.string(), label: z.string(), reason: z.string().optional() })),
  questions: z.array(z.object({ text: z.string(), answer: z.string().optional() })),
  relations: z.array(Relation),
  provenance: z.object({
    device: z.string().nullable(),
    app: z.string().nullable(),
    service: z.string(),
    observations: z.array(
      z.object({
        id: z.string(),
        /** Null only for a recorded frame whose file gives no capture time. */
        capturedAt: z.string().nullable(),
        frameSha256: z.string(),
        source: AttentionSource.optional(),
        timestampTrusted: z.boolean().optional(),
        /** Set for a frame of the person's recorded footage, never a live view. */
        recorded: RecordedProvenance.optional(),
      }),
    ),
    utterances: z.array(
      z.object({
        id: z.string(),
        text: z.string(),
        language: z.string(),
        source: z.string(),
        selection: ContextualActionSelection.optional(),
        choiceSelection: ChoiceSelection.optional(),
        observationId: z.string().nullable().optional(),
        /** Explicit selected item; selection does not verify its interpretation. */
        targetItemId: z.string().nullable().optional(),
        /** Original source of the selected item, separate from this turn's captured view. */
        targetObservationId: z.string().nullable().optional(),
        evidenceSource: AttentionSource.optional(),
      }),
    ),
    models: z.array(
      z.object({ interpretationId: z.string(), provider: z.string(), id: z.string() }),
    ),
    textEngine: z.string().nullable(),
    corrections: z.number().int(),
  }),
  /** The same content as plain text, for agents that read text only. */
  text: z.string(),
});
export const ContextPackage = z.discriminatedUnion('version', [
  LegacyContextPackage,
  LegacyContextPackage.extend({ version: z.literal(2), evidence: EvidenceBundle }),
]);
export type ContextPackage = z.infer<typeof ContextPackage>;
