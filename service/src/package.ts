import type { ContextPackage, Item, PackageItem } from './contracts.ts';
import { type EvidenceRecord, evidenceSourceId } from './evidence-contract.ts';
import type { SessionState } from './session.ts';

type Verification = PackageItem['verification'];

/** How the person verified an item: they wrote it, changed it, approved it, or let it stand. */
export function verificationOf(item: Item): Verification {
  if (item.origin === 'person') return 'authored';
  if (item.proposedLabel !== undefined) return 'corrected';
  return item.status === 'confirmed' ? 'confirmed' : 'accepted';
}

/**
 * The context package for a session at the moment of commit. Deterministic: the same session
 * always gives the same package, and no model writes any of it.
 */
export function buildPackage(
  session: SessionState,
  meta: { readonly packageId: string; readonly committedAt: string; readonly service: string },
): ContextPackage {
  const live = (item: Item) => item.status === 'proposed' || item.status === 'confirmed';
  const intentItem = session.items.find((item) => item.id === session.intentId);
  const referentItem = session.items.find((item) => item.id === session.referentId);
  const items = session.items
    .filter((item) => item.kind !== 'question' && item.id !== session.intentId && live(item))
    .map(
      (item): PackageItem => ({
        id: item.id,
        kind: item.kind,
        label: item.label,
        ...(item.gloss !== undefined && { gloss: item.gloss }),
        statement: item.statement,
        verification: verificationOf(item),
        emphasis: item.emphasis,
        confidence: item.confidence,
        ...(item.note !== undefined && { note: item.note }),
        ...(item.proposedLabel !== undefined && { proposedLabel: item.proposedLabel }),
        ...(item.text !== undefined && { text: item.text }),
        grounding: item.grounding,
        ...(item.interpretationId !== undefined && { proposedBy: item.interpretationId }),
      }),
    );
  const included = new Set([...items.map((item) => item.id), session.intentId]);
  const evidence = buildEvidence(session, meta.packageId);
  const references = new Map(evidence.map((record) => [record.itemId, record]));
  const said = saidFor(session, intentItem);
  const intent =
    intentItem !== undefined && live(intentItem)
      ? {
          said,
          reading: intentItem.statement,
          verification: verificationOf(intentItem),
          confidence: intentItem.confidence,
        }
      : null;
  const textEngines = [...new Set(session.text.map((read) => read.engine))];
  const pkg = {
    type: 'boopy.context-package' as const,
    version: 2 as const,
    evidence: { version: 1 as const, records: evidence },
    id: meta.packageId,
    sessionId: session.id,
    committedAt: meta.committedAt,
    title: intent?.reading ?? referentItem?.label ?? 'Saved context',
    intent,
    scope: session.scope,
    referent: referentItem !== undefined && live(referentItem) ? referentItem.label : null,
    items,
    known: session.items
      .filter((item) => item.status === 'known')
      .map((item) => ({
        id: item.id,
        label: item.label,
        ...(item.gloss !== undefined && { gloss: item.gloss }),
      })),
    rejected: session.items
      .filter((item) => item.status === 'rejected')
      .map((item) => ({
        id: item.id,
        label: item.label,
        ...(item.note !== undefined && { reason: item.note }),
      })),
    questions: session.items
      .filter((item) => item.kind === 'question' && live(item))
      .map((item) => ({
        text: item.label,
        ...(item.note !== undefined && { answer: item.note }),
      })),
    relations: session.relations.filter(
      (relation) => included.has(relation.from) && included.has(relation.to),
    ),
    provenance: {
      device: session.device?.model ?? null,
      app: session.device?.app ?? null,
      service: meta.service,
      observations: session.observations.map((observation) => ({
        id: observation.id,
        capturedAt: observation.capturedAt,
        frameSha256: observation.frameSha256,
        source: observation.source,
        timestampTrusted: observation.timestampTrusted,
      })),
      utterances: session.utterances.map((utterance) => ({
        id: utterance.id,
        text: utterance.text,
        language: utterance.language,
        source: utterance.source,
        ...(utterance.selection === undefined ? {} : { selection: utterance.selection }),
        ...(utterance.choiceSelection === undefined
          ? {}
          : { choiceSelection: utterance.choiceSelection }),
        observationId: utterance.observationId,
        targetItemId: references.get(utterance.targetItemId ?? '')?.itemId ?? null,
        targetObservationId: references.get(utterance.targetItemId ?? '')?.observationId ?? null,
        evidenceSource: utterance.evidenceSource,
      })),
      models: session.interpretations.map((interpretation) => ({
        interpretationId: interpretation.id,
        provider: interpretation.provider,
        id: interpretation.model,
      })),
      textEngine: textEngines.length === 0 ? null : textEngines.join(', '),
      corrections: session.corrections,
    },
  };
  return { ...pkg, text: renderText(pkg) };
}

/** The person's own words behind the intent: the utterance that led to it. */
function saidFor(session: SessionState, intent: Item | undefined): string {
  const interpretation = session.interpretations.find(
    (candidate) => candidate.id === intent?.interpretationId,
  );
  const produced = session.utterances.findIndex(
    (candidate) => candidate.id === interpretation?.utteranceId,
  );
  // A rescope or refocus refines the question; the intent is in the last question asked.
  const upTo = produced < 0 ? session.utterances.length - 1 : produced;
  for (let index = upTo; index >= 0; index -= 1) {
    const utterance = session.utterances[index];
    if (
      utterance?.reading.kind === 'ask' &&
      utterance.source !== 'suggestion' &&
      utterance.source !== 'choice'
    )
      return utterance.text;
  }
  return '';
}

const VERIFICATION_TEXT: Record<Verification, string> = {
  confirmed: 'confirmed',
  accepted: 'accepted',
  authored: 'added by the person',
  corrected: 'corrected by the person',
};

/** The package as plain text, for agents that read text only. Generated, never model-written. */
type WithoutText<T> = T extends unknown ? Omit<T, 'text'> : never;

export function renderText(pkg: WithoutText<ContextPackage>): string {
  const lines: string[] = [];
  const device = pkg.provenance.device ?? 'an unspecified device';
  lines.push(`Boopy package ID: ${pkg.id}.`);
  lines.push(`Boopy context committed ${pkg.committedAt} from ${device}.`);
  lines.push(
    'Saving does not confirm every claim. "Confirmed" items were explicitly confirmed by the person; "corrected" and "added by the person" record their changes and additions. "Accepted" items were proposed by a model and left uncorrected, not individually confirmed. A save does not establish that every item was reviewed.',
  );
  lines.push('');
  if (pkg.intent !== null) {
    lines.push(`Intent (${VERIFICATION_TEXT[pkg.intent.verification]}): ${pkg.intent.reading}`);
    if (pkg.intent.said !== '') lines.push(`The person said: "${pkg.intent.said}"`);
  }
  if (pkg.referent !== null) lines.push(`They were referring to: ${pkg.referent} (${pkg.scope}).`);
  const account = pkg.items.flatMap((item) => [
    ...(item.verification === 'authored'
      ? [`- Item ${item.id}: ${JSON.stringify(item.statement)}`]
      : []),
    ...(item.note === undefined ? [] : [`- Note on item ${item.id}: ${JSON.stringify(item.note)}`]),
  ]);
  if (account.length > 0) {
    lines.push('', 'Personal account (exact words, not independently verified):', ...account);
    lines.push(
      'When retelling or translating, preserve what these words actually say. Do not add activities, travel methods, feelings or intensity from model interpretations. Capture/commit times do not establish when a described experience happened. A question or uncertain statement is not an assertion of its premise.',
    );
  }
  if (pkg.items.length > 0) {
    lines.push('');
    lines.push('Context:');
    for (const item of pkg.items) {
      const tags = [VERIFICATION_TEXT[item.verification]];
      if (item.emphasis) tags.push('the person said this matters');
      if (item.verification === 'accepted' && item.confidence !== null) {
        tags.push(`model confidence ${item.confidence.toFixed(2)}`);
      }
      const gloss = item.gloss === undefined ? '' : ` (${item.gloss})`;
      const was =
        item.proposedLabel === undefined ? '' : ` [model proposed "${item.proposedLabel}"]`;
      lines.push(`- [${tags.join(', ')}] ${item.label}${gloss}${was}: ${item.statement}`);
      if (item.text !== undefined) lines.push(`  Text as written: ${item.text.join(' / ')}`);
      if (pkg.version === 2) {
        const record = pkg.evidence.records.find((entry) => entry.itemId === item.id);
        if (record?.sourceContext !== undefined && record.sourceContext !== 'unknown') {
          lines.push(
            `  Requested evidence context: ${record.sourceContext}. This does not verify the depicted place or event time.`,
          );
        }
      }
      if (item.note !== undefined) lines.push(`  The person added: ${item.note}`);
    }
  }
  if (pkg.known.length > 0) {
    const known = pkg.known.map((item) =>
      item.gloss === undefined ? item.label : `${item.label} (${item.gloss})`,
    );
    lines.push('');
    lines.push(`Already known by the person: ${known.join('; ')}.`);
  }
  if (pkg.rejected.length > 0) {
    const rejected = pkg.rejected.map((item) =>
      item.reason === undefined ? item.label : `${item.label} (${item.reason})`,
    );
    lines.push(`Rejected by the person: ${rejected.join('; ')}.`);
  }
  if (pkg.questions.length > 0) {
    lines.push('');
    lines.push('Recorded questions:');
    lines.push(
      'These are retained questions, not proof that an answer is still missing. Check the exact personal account above before asking again; do not infer an answer from a model proposal.',
    );
    for (const question of pkg.questions) {
      lines.push(
        question.answer === undefined
          ? `- ${question.text}`
          : `- ${question.text} The person answered: ${question.answer}`,
      );
    }
  }
  const p = pkg.provenance;
  if (pkg.version === 2) {
    const references = p.utterances.flatMap((utterance) => {
      if (utterance.targetItemId == null) return [];
      const target = pkg.evidence.records.find(
        (record) => record.itemId === utterance.targetItemId,
      );
      if (target === undefined) return [];
      return [
        `- ${utterance.source === 'choice' ? 'Submitted model-proposed choice' : utterance.source === 'suggestion' ? 'Selected model-suggested question' : 'Utterance'} ${utterance.id}: ${JSON.stringify(utterance.text)} -> item ${target.itemId} (${JSON.stringify(target.label)}; ${target.disposition}; ${target.verification}). Target source: ${utterance.targetObservationId ?? 'no recorded view'}; turn source: ${utterance.observationId ?? 'no recorded view'}.`,
      ];
    });
    if (references.length > 0) {
      lines.push('');
      lines.push('Spatial references (selecting an item does not confirm its interpretation):');
      lines.push(...references);
    }
  }
  const models = [...new Set(p.models.map((model) => `${model.provider}:${model.id}`))];
  lines.push('');
  lines.push(
    `Provenance: ${p.observations.length} camera frame(s) kept on the person's Mac; interpreted by ${models.join(', ') || 'no model'}${p.textEngine === null ? '' : `; text read by ${p.textEngine}`}; ${p.corrections} correction(s) by the person.`,
  );
  return lines.join('\n');
}

/** Retain links even for known/rejected items and questions; omit ignored records entirely. */
function buildEvidence(session: SessionState, packageId: string): EvidenceRecord[] {
  return session.items
    .filter((item) => item.status !== 'ignored')
    .map((item) => {
      const interpretation = session.interpretations.find(
        (entry) => entry.id === item.interpretationId,
      );
      const humanActions = session.humanActions.filter((action) => action.itemId === item.id);
      const authored = humanActions.find((action) => action.op === 'add');
      const utteranceId = interpretation?.utteranceId ?? authored?.utteranceId ?? null;
      return {
        sourceId: evidenceSourceId({ packageId, itemId: item.id }),
        packageId,
        itemId: item.id,
        kind: item.kind,
        label: item.label,
        statement: item.statement,
        ...(item.note !== undefined && { note: item.note }),
        ...(item.gloss !== undefined && { gloss: item.gloss }),
        origin: item.origin,
        disposition:
          item.status === 'known'
            ? 'known'
            : item.status === 'rejected'
              ? 'rejected'
              : item.id === session.intentId
                ? 'intent'
                : item.kind === 'question'
                  ? 'question'
                  : 'context',
        verification:
          item.origin === 'model' &&
          item.proposedLabel === undefined &&
          (item.status === 'known' || item.status === 'rejected')
            ? 'unconfirmed'
            : verificationOf(item),
        modelConfidence: item.confidence,
        observationId: interpretation?.observationId ?? item.grounding.observationId ?? null,
        utteranceId,
        sourceContext:
          session.utterances.find((utterance) => utterance.id === utteranceId)?.evidenceSource ??
          'unknown',
        interpretationId: interpretation?.id ?? null,
        model:
          interpretation === undefined
            ? null
            : { provider: interpretation.provider, id: interpretation.model },
        text: item.text ?? [],
        humanActions: humanActions.map(({ itemId: _itemId, ...action }) => action),
      };
    });
}
