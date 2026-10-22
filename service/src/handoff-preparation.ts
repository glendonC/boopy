/** Local preparation only. A prepared receipt never constitutes consumer delivery. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { exportHandoff, type HandoffOptions } from './cli/export-handoff.ts';
import type { ContextPackage, SessionView } from './contracts.ts';
import type { Supersession } from './evidence-contract.ts';
import { evidenceRecords } from './evidence-contract.ts';
import type { Journal } from './journal.ts';
import { ZetarisReferenceAssociation } from './references/zetaris.ts';

const Identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const PackageId = z.string().regex(/^ctx_[a-zA-Z0-9_-]{1,128}$/);
export const HandoffPreparationRequest = z
  .object({
    requestId: Identifier,
    packageId: PackageId,
    memory: z
      .object({
        packageIds: z.array(PackageId).min(1).max(10),
        query: z.string().trim().min(1).max(500),
      })
      .strict()
      .optional(),
    references: z
      .union(
        ZetarisReferenceAssociation.options.map((option) =>
          option
            .extend({
              packageId: PackageId,
              itemId: z.string().min(1).max(256),
            })
            .strict(),
        ),
      )
      .optional(),
  })
  .strict();
export type HandoffPreparationRequest = z.infer<typeof HandoffPreparationRequest>;
type ModuleState = 'disabled' | 'available' | 'unavailable';
export type HandoffPreparationReceipt = {
  receiptId: string;
  requestId: string;
  state: 'prepared-local';
  packageId: string;
  selectionSha256: string;
  baselineSha256: string;
  packetSha256: string;
  selectedPackageIds: string[];
  selectedSourceIds: string[];
  memory: { status: ModuleState; returnedSources: number };
  references: { status: ModuleState; returnedAssociations: number; sourceRecordSha256?: string };
  delivery: 'not-sent';
  preparedAt: string;
  historicalSnapshot: true;
  sourceSnapshotSha256: string;
};
type Common = { requestId: string; receiptId: string; selectionSha256: string; attempt: number };
export type HandoffPreparationEvent = {
  session: string;
  actor: 'person' | 'system' | 'agent:local-operator';
} & (
  | {
      type: 'handoff.preparation-started';
      data: Common & {
        selection: HandoffPreparationRequest;
        consent: 'prepare-local-only';
      };
    }
  | { type: 'handoff.preparation-completed'; data: Common & { receipt: HandoffPreparationReceipt } }
  | {
      type: 'handoff.preparation-failed';
      data: Common & { reason: 'preparation_failed' | 'interrupted' };
    }
  | {
      type: 'handoff.packet-read';
      data: { requestId: string; receiptId: string; packetSha256: string; via: 'local-operator' };
    }
);
type Status = Common & { sessionId: string; packageId: string } & (
    | { state: 'preparing-local' }
    | { state: 'failed'; reason: 'preparation_failed' | 'interrupted' }
    | {
        state: 'prepared-local';
        receipt: HandoffPreparationReceipt;
        sourceState: 'unchanged' | 'changed';
      }
  );
type Dependencies = {
  journal: Journal;
  /** App-owned private directory, never accepted in a client request. */
  outputRoot: string;
  dataDir: string;
  port?: number;
  referenceCredentialFile?: string;
  packageForId: (id: string) => ContextPackage | undefined;
  sessionForId: (id: string) => SessionView;
  supersessions: () => readonly Supersession[];
  compose?: typeof exportHandoff;
};

export class HandoffPreparation {
  readonly #dependencies: Dependencies;
  readonly #active = new Map<string, Promise<HandoffPreparationReceipt>>();

  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
    // A fresh service instance cannot claim an old process is still preparing a packet.
    for (const status of this.#states().values()) {
      if (status.state === 'preparing-local')
        this.#record({
          type: 'handoff.preparation-failed',
          session: status.sessionId,
          actor: 'system',
          data: { ...common(status), reason: 'interrupted' },
        });
    }
  }

  status(sessionId: string, requestId: string): Status | null {
    Identifier.parse(requestId);
    const status = this.#states().get(requestId);
    if (status && status.sessionId !== sessionId) throw new Error('Handoff request unavailable.');
    if (status?.state === 'prepared-local')
      return { ...status, sourceState: this.#sourcesUnchanged(status) ? 'unchanged' : 'changed' };
    return status ?? null;
  }

  /** Exact single completed preparation only; never lists the journal or guesses a newest receipt. */
  forPackage(packageId: string, requestId?: string) {
    PackageId.parse(packageId);
    if (requestId !== undefined) Identifier.parse(requestId);
    const matches = [...this.#states().values()].filter(
      (status) =>
        status.packageId === packageId &&
        status.state === 'prepared-local' &&
        (requestId === undefined || status.requestId === requestId),
    );
    if (matches.length !== 1) throw new Error('Prepared handoff unavailable.');
    const match = matches[0];
    if (!match) throw new Error('Prepared handoff unavailable.');
    const status = this.status(match.sessionId, match.requestId);
    if (status?.state !== 'prepared-local') throw new Error('Prepared handoff unavailable.');
    return status;
  }

  listForPackage(packageId: string) {
    PackageId.parse(packageId);
    const prepared = [...this.#states().values()].filter(
      (status) => status.packageId === packageId && status.state === 'prepared-local',
    );
    if (!prepared.length || prepared.length > 50) throw new Error('Prepared handoff unavailable.');
    return {
      packageId,
      preparations: prepared.map((status) => {
        const current = this.forPackage(packageId, status.requestId);
        return {
          requestId: current.requestId,
          receiptId: current.receiptId,
          sourceState: current.sourceState,
          state: 'prepared-local' as const,
          delivery: 'not-sent' as const,
        };
      }),
    };
  }

  #sourcesUnchanged(status: Status) {
    if (status.state !== 'prepared-local') return false;
    const started = this.#dependencies.journal
      .all()
      .find(
        (event) =>
          event.type === 'handoff.preparation-started' && event.data.requestId === status.requestId,
      );
    return (
      started?.type === 'handoff.preparation-started' &&
      this.#snapshot(started.data.selection) === status.receipt.sourceSnapshotSha256
    );
  }

  prepare(sessionId: string, input: HandoffPreparationRequest): Promise<HandoffPreparationReceipt> {
    const request = HandoffPreparationRequest.parse(input);
    this.#dependencies.sessionForId(sessionId);
    const baseline = this.#dependencies.packageForId(request.packageId);
    if (!baseline || baseline.sessionId !== sessionId)
      throw new Error('Select a committed package from this session.');
    for (const id of request.memory?.packageIds ?? []) {
      if (!this.#dependencies.packageForId(id))
        throw new Error('Selected memory package unavailable.');
    }
    if (request.references) {
      const pkg = this.#dependencies.packageForId(request.references.packageId);
      const record =
        pkg && evidenceRecords(pkg).find((item) => item.itemId === request.references?.itemId);
      if (record?.disposition !== 'context')
        throw new Error('Selected reference source unavailable.');
      if (
        this.#dependencies
          .supersessions()
          .some(
            (link) =>
              link.predecessor.packageId === request.references?.packageId &&
              link.predecessor.itemId === request.references?.itemId,
          )
      )
        throw new Error('Selected reference source superseded.');
    }
    const selectionSha256 = sha256(canonical({ sessionId, ...request }));
    const previous = this.status(sessionId, request.requestId);
    if (previous && previous.selectionSha256 !== selectionSha256)
      throw new Error('Handoff request selection changed.');
    const active = this.#active.get(request.requestId);
    if (active) return active;
    if (previous?.state === 'prepared-local') return Promise.resolve(previous.receipt);
    if (
      this.#active.size >= 2 ||
      [...this.#states().values()].some(
        (status) => status.state === 'preparing-local' && status.sessionId === sessionId,
      )
    )
      throw new Error('Handoff preparation is busy.');
    if ((previous?.attempt ?? 0) >= 3) throw new Error('Handoff preparation retry limit reached.');
    const attempt = (previous?.attempt ?? 0) + 1;
    const receiptId = previous?.receiptId ?? `handoff_${randomUUID()}`;
    const context = { requestId: request.requestId, receiptId, selectionSha256, attempt };
    this.#record({
      type: 'handoff.preparation-started',
      session: sessionId,
      actor: 'person',
      data: { ...context, selection: request, consent: 'prepare-local-only' },
    });
    const work = this.#prepare(request, context, sessionId).finally(() => {
      this.#active.delete(request.requestId);
    });
    this.#active.set(request.requestId, work);
    return work;
  }

  /** Local operator route only: callers must enforce its distinct disclosure boundary. */
  async readPacket(sessionId: string, requestId: string): Promise<string> {
    const status = this.status(sessionId, requestId);
    if (status?.state !== 'prepared-local') throw new Error('Handoff packet unavailable.');
    if (!this.#sourcesUnchanged(status))
      throw new Error('Handoff sources changed. Prepare a new handoff.');
    const directory = await this.#directory(status.receiptId, status.attempt, false);
    const path = join(directory, 'manual-handoff-packet.txt');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await file.stat();
      const limit = 8 * 1024 * 1024;
      if (!metadata.isFile() || metadata.mode & 0o077 || metadata.size > limit)
        throw new Error('Handoff packet unavailable.');
      const bytes = Buffer.alloc(limit + 1);
      let total = 0;
      while (total < bytes.length) {
        const read = await file.read(bytes, total, bytes.length - total, total);
        if (read.bytesRead === 0) break;
        total += read.bytesRead;
      }
      const packet = bytes.subarray(0, total);
      if (total > limit || sha256(packet) !== status.receipt.packetSha256)
        throw new Error('Handoff packet integrity check failed.');
      if (!this.#sourcesUnchanged(status))
        throw new Error('Handoff sources changed. Prepare a new handoff.');
      this.#record({
        type: 'handoff.packet-read',
        session: sessionId,
        actor: 'agent:local-operator',
        data: {
          requestId,
          receiptId: status.receiptId,
          packetSha256: status.receipt.packetSha256,
          via: 'local-operator',
        },
      });
      return packet.toString('utf8');
    } finally {
      await file.close();
    }
  }

  async #prepare(request: HandoffPreparationRequest, context: Common, sessionId: string) {
    try {
      const sourceSnapshotSha256 = this.#snapshot(request);
      const baselineRecords = evidenceRecords(this.#dependencies.packageForId(request.packageId));
      const outputDirectory = await this.#directory(context.receiptId, context.attempt, true);
      const options: HandoffOptions = {
        packageId: request.packageId,
        dataDir: this.#dependencies.dataDir,
        outputDirectory,
        port: this.#dependencies.port,
        memory: request.memory,
      };
      if (request.references)
        options.references = {
          ...request.references,
          credentialFile: this.#dependencies.referenceCredentialFile ?? 'unavailable',
        };
      const result = await (this.#dependencies.compose ?? exportHandoff)(
        options,
        request.references && !this.#dependencies.referenceCredentialFile
          ? {
              lookupReference: async () => {
                throw new Error('Reference provider unavailable.');
              },
            }
          : {},
      );
      if (sourceSnapshotSha256 !== this.#snapshot(request))
        throw new Error('Selected sources changed.');
      const receipt: HandoffPreparationReceipt = {
        ...context,
        state: 'prepared-local',
        packageId: request.packageId,
        baselineSha256: result.baseline.sha256,
        packetSha256: sha256(result.artifacts.packet),
        selectedPackageIds: result.artifacts.supplement.selectedPackageIds,
        selectedSourceIds: [
          ...new Set([
            ...baselineRecords.map((record) => record.sourceId),
            ...result.artifacts.supplement.memory.hits.map((hit) => hit.evidence.sourceId),
            ...result.artifacts.supplement.memory.constraints.map((record) => record.sourceId),
            ...result.artifacts.supplement.memory.openQuestions.map((record) => record.sourceId),
            ...result.artifacts.supplement.references.rows.map((row) => row.evidence.sourceId),
          ]),
        ],
        memory: { status: result.memory.status, returnedSources: result.memory.returnedSources },
        references: {
          status:
            request.references && !this.#dependencies.referenceCredentialFile
              ? 'unavailable'
              : result.references.status,
          returnedAssociations: result.references.returnedAssociations,
          ...(result.references.sourceRecordSha256
            ? { sourceRecordSha256: result.references.sourceRecordSha256 }
            : {}),
        },
        delivery: 'not-sent',
        preparedAt: new Date().toISOString(),
        historicalSnapshot: true,
        sourceSnapshotSha256,
      };
      this.#record({
        type: 'handoff.preparation-completed',
        session: sessionId,
        actor: 'system',
        data: { ...context, receipt },
      });
      return receipt;
    } catch {
      this.#record({
        type: 'handoff.preparation-failed',
        session: sessionId,
        actor: 'system',
        data: { ...context, reason: 'preparation_failed' },
      });
      throw new Error('Local handoff preparation failed.');
    }
  }

  async #directory(receiptId: string, attempt: number, create: boolean) {
    const root = resolve(this.#dependencies.outputRoot);
    if (create) await mkdir(root, { mode: 0o700, recursive: true });
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.mode & 0o077)
      throw new Error('Private handoff storage unavailable.');
    const directory = join(root, `${receiptId}-attempt-${attempt}`);
    if (create) await mkdir(directory, { mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.mode & 0o077)
      throw new Error('Private handoff storage unavailable.');
    return directory;
  }

  #record(event: HandoffPreparationEvent) {
    this.#dependencies.journal.append(event, `evt_${randomUUID()}`, new Date().toISOString());
  }

  #snapshot(request: HandoffPreparationRequest) {
    const ids = [
      ...new Set([
        request.packageId,
        ...(request.memory?.packageIds ?? []),
        ...(request.references ? [request.references.packageId] : []),
      ]),
    ];
    return sha256(
      canonical({
        packages: ids.map((id) => this.#dependencies.packageForId(id)),
        corrections: this.#dependencies
          .supersessions()
          .filter(
            (link) =>
              ids.includes(link.predecessor.packageId) || ids.includes(link.successor.packageId),
          ),
      }),
    );
  }

  #states(): Map<string, Status> {
    const states = new Map<string, Status>();
    for (const event of this.#dependencies.journal.all()) {
      if (event.type === 'handoff.preparation-started')
        states.set(event.data.requestId, {
          ...common(event.data),
          sessionId: event.session,
          state: 'preparing-local',
          packageId: event.data.selection.packageId,
        });
      else if (event.type === 'handoff.preparation-completed')
        states.set(event.data.requestId, {
          ...common(event.data),
          sessionId: event.session,
          state: 'prepared-local',
          sourceState: 'unchanged',
          packageId: event.data.receipt.packageId,
          receipt: event.data.receipt,
        });
      else if (event.type === 'handoff.preparation-failed')
        states.set(event.data.requestId, {
          ...common(event.data),
          sessionId: event.session,
          state: 'failed',
          packageId: states.get(event.data.requestId)?.packageId ?? '',
          reason: event.data.reason,
        });
    }
    return states;
  }
}

function common(value: Common): Common {
  return {
    requestId: value.requestId,
    receiptId: value.receiptId,
    selectionSha256: value.selectionSha256,
    attempt: value.attempt,
  };
}
function sha256(text: string | Uint8Array) {
  return createHash('sha256').update(text).digest('hex');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
