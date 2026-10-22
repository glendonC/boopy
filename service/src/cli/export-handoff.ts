/** Explicit local modular handoff; no account connection, clipboard, public endpoint or delivery. */
import { createHash } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ContextPackage } from '../contracts.ts';
import {
  EvidenceRecord,
  evidenceRecords,
  evidenceSourceId,
  Supersession,
} from '../evidence-contract.ts';
import {
  evidenceRecordSha256,
  renderSelectedSupplement,
  type SelectedSupplement,
  SemanticRanking,
} from '../handoff-supplement.ts';
import { exportContext, readConnectorToken } from '../manual-handoff.ts';
import { lookupZetarisReference, ZetarisReferenceAssociation } from '../references/zetaris.ts';

const PackageId = z.string().regex(/^ctx_[a-zA-Z0-9_-]{1,128}$/);
const MemorySelection = z.object({
  packageIds: z.array(PackageId).min(1).max(10),
  query: z.string().trim().min(1).max(500),
});
const ReferenceSelection = z
  .object({
    packageId: PackageId,
    itemId: z.string().min(1).max(256),
    credentialFile: z.string().min(1),
  })
  .and(ZetarisReferenceAssociation);
const RecallResponse = z
  .object({
    type: z.literal('boopy.recall'),
    version: z.literal(1),
    engine: z.literal('hmem-subset'),
    semantic: SemanticRanking.optional(),
    results: z
      .array(
        z.object({
          evidence: EvidenceRecord,
          relevance: z.number().finite(),
          retrievalConfidence: z.number().min(0).max(1),
        }),
      )
      .max(20),
    constraints: z.array(EvidenceRecord).max(500),
    openQuestions: z.array(EvidenceRecord).max(500),
    supersededCount: z.number().int().nonnegative(),
  })
  .strict();
type ModuleState = {
  status: 'disabled' | 'available' | 'unavailable';
  reason?: 'request_failed';
  selectedPackageIds: string[];
  returnedSources: number;
  querySha256?: string;
  semantic?: SelectedSupplement['memory']['semantic'];
};
export type HandoffOptions = {
  packageId: string;
  dataDir: string;
  outputDirectory: string;
  port?: number;
  memory?: { packageIds: string[]; query: string };
  synthetic?: boolean;
  references?: z.infer<typeof ReferenceSelection>;
};

export async function exportHandoff(
  options: HandoffOptions,
  dependencies: { lookupReference?: typeof lookupZetarisReference } = {},
) {
  PackageId.parse(options.packageId);
  const selection = options.memory ? MemorySelection.parse(options.memory) : null;
  const referenceSelection = options.references
    ? ReferenceSelection.parse(options.references)
    : null;
  const port = options.port ?? 47901;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Choose a valid local connector port.');
  const directory = resolve(options.outputDirectory);
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0)
    throw new Error('Choose an existing private output directory.');
  const files = {
    baseline: 'baseline-context.txt',
    supplement: 'selected-supplement.txt',
    packet: 'manual-handoff-packet.txt',
    manifest: 'handoff-manifest.json',
  };
  for (const name of Object.values(files)) {
    try {
      await lstat(join(directory, name));
      throw new Error('Output files must be new.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  // Baseline completes before optional work. A module refusal/failure cannot erase this export.
  const baseline = await exportContext({
    packageId: options.packageId,
    dataDir: options.dataDir,
    output: join(directory, files.baseline),
    port,
  });
  const baselineText = await readFile(baseline.path, 'utf8');
  const selectedPackageIds = [
    ...new Set([
      ...(selection?.packageIds ?? []),
      options.packageId,
      ...(referenceSelection ? [referenceSelection.packageId] : []),
    ]),
  ];
  const supplement: SelectedSupplement = {
    synthetic: options.synthetic ?? false,
    baselinePackageId: options.packageId,
    selectedPackageIds,
    memory: {
      mode: selection ? 'hmem-subset' : 'disabled',
      status: selection ? 'unavailable' : 'disabled',
      hits: [],
      constraints: [],
      openQuestions: [],
    },
    references: { mode: 'disabled', status: 'disabled', rows: [] },
  };
  const memory: ModuleState = {
    status: selection ? 'unavailable' : 'disabled',
    selectedPackageIds: selection ? [...new Set(selection.packageIds)] : [],
    returnedSources: 0,
    ...(selection
      ? { querySha256: createHash('sha256').update(selection.query).digest('hex') }
      : {}),
  };
  if (selection) {
    try {
      const token = await readConnectorToken(options.dataDir);
      const response = await fetch(`http://127.0.0.1:${port}/v1/recall`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-boopy-agent': 'local-modular-handoff',
        },
        body: JSON.stringify({
          packageIds: memory.selectedPackageIds,
          query: selection.query,
          limit: 20,
        }),
      });
      const recall = RecallResponse.parse(await boundedJson(response));
      const check = (record: z.infer<typeof EvidenceRecord>) => {
        if (
          !memory.selectedPackageIds.includes(record.packageId) ||
          record.sourceId !== evidenceSourceId(record)
        )
          throw new Error('Unselected recall source.');
      };
      for (const hit of recall.results) {
        check(hit.evidence);
        if (!['context', 'intent'].includes(hit.evidence.disposition))
          throw new Error('Invalid ranked disposition.');
      }
      for (const record of recall.constraints) {
        check(record);
        if (!['known', 'rejected'].includes(record.disposition))
          throw new Error('Invalid constraint disposition.');
      }
      for (const record of recall.openQuestions) {
        check(record);
        if (record.disposition !== 'question') throw new Error('Invalid question disposition.');
      }
      supplement.memory = {
        mode: 'hmem-subset',
        status: 'available',
        ...(recall.semantic ? { semantic: recall.semantic } : {}),
        hits: recall.results,
        constraints: recall.constraints,
        openQuestions: recall.openQuestions,
      };
      if (recall.semantic) memory.semantic = recall.semantic;
      memory.status = 'available';
      memory.returnedSources = recall.results.length;
    } catch {
      memory.reason = 'request_failed';
    }
  }
  const references: {
    status: 'disabled' | 'available' | 'unavailable';
    mode: 'disabled' | 'zetaris-reference-lookup';
    selectedSourceIds: string[];
    referenceIds: string[];
    returnedAssociations: number;
    reason?: 'request_failed';
    sourceRecordSha256?: string;
  } = {
    status: referenceSelection ? 'unavailable' : 'disabled',
    mode: referenceSelection ? 'zetaris-reference-lookup' : 'disabled',
    selectedSourceIds: referenceSelection ? [evidenceSourceId(referenceSelection)] : [],
    referenceIds: referenceSelection ? [referenceSelection.referenceId] : [],
    returnedAssociations: 0,
  };
  if (referenceSelection) {
    supplement.references = { mode: 'zetaris-reference-lookup', status: 'unavailable', rows: [] };
    try {
      const token = await readConnectorToken(options.dataDir);
      const response = await fetch(
        `http://127.0.0.1:${port}/v1/context/${encodeURIComponent(referenceSelection.packageId)}`,
        {
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
          headers: {
            authorization: `Bearer ${token}`,
            'x-boopy-agent': 'local-modular-reference-handoff',
          },
        },
      );
      const raw = await boundedJson(response);
      const pkg = ContextPackage.parse(raw);
      if (pkg.id !== referenceSelection.packageId || pkg.version !== 2)
        throw new Error('Selected source unavailable.');
      const overlay = z
        .object({
          correctionOverlay: z
            .object({ version: z.literal(1), supersessions: z.array(Supersession) })
            .optional(),
        })
        .parse(raw).correctionOverlay;
      if (
        overlay?.supersessions.some(
          (link) =>
            link.predecessor.packageId === pkg.id &&
            link.predecessor.itemId === referenceSelection.itemId,
        )
      )
        throw new Error('Selected source superseded.');
      const evidence = evidenceRecords(pkg).find(
        (record) => record.itemId === referenceSelection.itemId,
      );
      if (
        evidence?.disposition !== 'context' ||
        evidence.sourceId !== evidenceSourceId(referenceSelection)
      )
        throw new Error('Select an included context source.');
      // Only the independent QID and read-only credential path leave this layer. No context is staged/uploaded.
      const result = await (dependencies.lookupReference ?? lookupZetarisReference)({
        referenceId: referenceSelection.referenceId,
        credentialFile: referenceSelection.credentialFile,
        signal: AbortSignal.timeout(30000),
      });
      if (
        result.mode !== 'zetaris-runtime' ||
        result.operation !== 'reference-lookup' ||
        result.rows.length !== 1
      )
        throw new Error('Reference unavailable.');
      // Recheck after asynchronous reference inference: a later correction cannot enter as current.
      const latestResponse = await fetch(
        `http://127.0.0.1:${port}/v1/context/${encodeURIComponent(referenceSelection.packageId)}`,
        {
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
          headers: {
            authorization: `Bearer ${token}`,
            'x-boopy-agent': 'local-modular-reference-handoff',
          },
        },
      );
      const latestRaw = await boundedJson(latestResponse);
      const latestPackage = ContextPackage.parse(latestRaw);
      const latestEvidence = evidenceRecords(latestPackage).find(
        (record) => record.itemId === referenceSelection.itemId,
      );
      const latestOverlay = z
        .object({
          correctionOverlay: z
            .object({ version: z.literal(1), supersessions: z.array(Supersession) })
            .optional(),
        })
        .parse(latestRaw).correctionOverlay;
      if (
        latestPackage.id !== pkg.id ||
        !latestEvidence ||
        evidenceRecordSha256(latestEvidence) !== evidenceRecordSha256(evidence) ||
        latestOverlay?.supersessions.some(
          (link) =>
            link.predecessor.packageId === pkg.id &&
            link.predecessor.itemId === referenceSelection.itemId,
        )
      )
        throw new Error('Selected source changed.');
      const hash = evidenceRecordSha256(evidence);
      const rows = result.rows.map((reference) => {
        if (reference.referenceId !== referenceSelection.referenceId)
          throw new Error('Reference identity mismatch.');
        return {
          evidence,
          reference: {
            sourceId: evidence.sourceId,
            packageId: evidence.packageId,
            itemId: evidence.itemId,
            revisionId: null,
            sourceRecordSha256: hash,
            conceptKey: referenceSelection.conceptKey,
            referenceSource: reference.referenceSourceId,
            referenceId: reference.referenceId,
            referenceVersion: reference.referenceVersion,
            updatedAt: reference.updatedAt,
            referenceStatus: reference.referenceStatus,
            referenceUrl: reference.referenceUrl,
            koreanTerm: reference.koreanTerm,
            englishGloss: reference.englishGloss,
            license: reference.license,
          },
        };
      });
      supplement.references = { mode: 'zetaris-reference-lookup', status: 'available', rows };
      // Run the same renderer validation before reporting module availability.
      renderSelectedSupplement(supplement);
      references.status = 'available';
      references.returnedAssociations = rows.length;
      references.sourceRecordSha256 = hash;
    } catch {
      references.reason = 'request_failed';
      supplement.references = { mode: 'zetaris-reference-lookup', status: 'unavailable', rows: [] };
    }
  }
  // Optional reference work may outlive the recall response. Recheck the emitted memory
  // against current correction overlays before rendering; this is not an atomic read/write.
  if (memory.status === 'available') {
    try {
      const token = await readConnectorToken(options.dataDir);
      const records = [
        ...supplement.memory.hits.map((hit) => hit.evidence),
        ...supplement.memory.constraints,
        ...supplement.memory.openQuestions,
      ];
      await Promise.all(
        [...new Set(records.map((record) => record.packageId))].map(async (packageId) => {
          const response = await fetch(
            `http://127.0.0.1:${port}/v1/context/${encodeURIComponent(packageId)}`,
            {
              redirect: 'error',
              signal: AbortSignal.timeout(10000),
              headers: {
                authorization: `Bearer ${token}`,
                'x-boopy-agent': 'local-modular-handoff',
              },
            },
          );
          const raw = await boundedJson(response);
          const pkg = ContextPackage.parse(raw);
          if (pkg.id !== packageId || pkg.version !== 2) throw new Error();
          const overlay = z
            .object({
              correctionOverlay: z
                .object({ version: z.literal(1), supersessions: z.array(Supersession) })
                .optional(),
            })
            .parse(raw).correctionOverlay;
          const latest = evidenceRecords(pkg);
          for (const record of records.filter((entry) => entry.packageId === packageId)) {
            const current = latest.find((entry) => entry.sourceId === record.sourceId);
            if (
              !current ||
              evidenceRecordSha256(current) !== evidenceRecordSha256(record) ||
              overlay?.supersessions.some(
                (link) =>
                  link.predecessor.packageId === packageId &&
                  link.predecessor.itemId === record.itemId,
              )
            )
              throw new Error();
          }
        }),
      );
    } catch {
      memory.status = 'unavailable';
      memory.reason = 'request_failed';
      memory.returnedSources = 0;
      delete memory.semantic;
      supplement.memory = {
        mode: 'hmem-subset',
        status: 'unavailable',
        hits: [],
        constraints: [],
        openQuestions: [],
      };
    }
  }
}
