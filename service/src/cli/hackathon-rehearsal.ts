/** Same synthetic source chain across routes, private manual export and optional real H-MEM. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { type ContextPackage, SessionView } from '../contracts.ts';
import { type EvidenceRecord, evidenceRecords, evidenceSourceId } from '../evidence-contract.ts';
import { HandoffPreparation, type HandoffPreparationReceipt } from '../handoff-preparation.ts';
import {
  ReferenceRow,
  renderSelectedSupplement,
  type SelectedSupplement,
  type SyntheticReferenceRow,
} from '../handoff-supplement.ts';
import { connectorApp } from '../http/connector.ts';
import { headsetApp } from '../http/headset.ts';
import { NvidiaEmbeddingWorker } from '../memory/nvidia.ts';
import type { RecallHit } from '../memory/recall.ts';
import type { lookupZetarisReference } from '../references/zetaris.ts';
import { exportHandoff } from './export-handoff.ts';
import { exportPrepared } from './export-prepared.ts';

export { renderSelectedSupplement } from '../handoff-supplement.ts';

import { providedSyntheticReferences } from '../provided-synthetic-reference.ts';
import { startRequest, testBoopy } from '../testing.ts';

export type SyntheticReferenceProvider = (selection: {
  packageIds: readonly string[];
  baselinePackageId: string;
  evidence: readonly EvidenceRecord[];
}) => Promise<{ mode: 'synthetic-contract'; rows: SyntheticReferenceRow[] }>;
type RecallResult = {
  engine: string;
  results: RecallHit[];
  constraints: EvidenceRecord[];
  openQuestions: EvidenceRecord[];
  supersededCount: number;
  semantic?: SelectedSupplement['memory']['semantic'];
};

export async function hackathonRehearsal(
  options: {
    memory?: boolean;
    memoryUnavailable?: boolean;
    semanticRanker?: Pick<NvidiaEmbeddingWorker, 'rank'>;
    referenceLookup?: typeof lookupZetarisReference;
    references?: SyntheticReferenceProvider;
    referenceReceiptPath?: string;
    referenceCredentials?: string;
    artifactDirectory?: string;
  } = {},
) {
  const test = testBoopy();
  // This retained rehearsal reproduces the already-recorded synthetic receipt exactly.
  // Its legacy Add path lowercased the short label but capitalized the statement. Author
  // that historical fixture shape before append; do not alter current Add behavior or hashes.
  const append = test.journal.append.bind(test.journal);
  test.journal.append = (event, id, at) => {
    if (
      event.type === 'item.corrected' &&
      event.data.op === 'add' &&
      event.data.item.origin === 'person' &&
      event.data.item.statement === 'I saw the synthetic dunes before noon.'
    ) {
      event = structuredClone(event);
      if (event.type === 'item.corrected' && event.data.op === 'add')
        event.data.item.label = 'i saw the synthetic dunes';
    }
    return append(event, id, at);
  };
  const memory = options.memory ?? true;
  const token = randomBytes(32).toString('hex');
  const directory = await mkdtemp(join(tmpdir(), 'boopy-composed-synthetic-'));
  const destination = options.artifactDirectory ? resolve(options.artifactDirectory) : directory;
  let port = 0;
  let observedExport: Awaited<ReturnType<typeof exportHandoff>> | undefined;
  const preparation = new HandoffPreparation({
    journal: test.journal,
    dataDir: directory,
    outputRoot: join(directory, 'preparations'),
    get port() {
      return port;
    },
    packageForId: (id) => test.boopy.package(id),
    sessionForId: (id) => test.boopy.view(id),
    supersessions: () => test.boopy.supersessions,
    referenceCredentialFile: options.referenceCredentials,
    compose: async (input, dependencies) => {
      observedExport = await exportHandoff(
        { ...input, synthetic: true },
        {
          ...dependencies,
          ...(options.referenceLookup ? { lookupReference: options.referenceLookup } : {}),
        },
      );
      return observedExport;
    },
  });
  const connector = connectorApp(test.boopy, {
    token,
    baseUrl: 'http://127.0.0.1',
    logger: false,
    memory: memory && !options.memoryUnavailable,
    semanticRanker: options.semanticRanker,
    handoff: preparation,
  });
}
