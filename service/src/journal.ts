import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BoopyEvent } from './events.ts';

/** An event as stored: its position in the journal and when it was written. */
export type Recorded = BoopyEvent & {
  readonly seq: number;
  readonly id: string;
  readonly at: string;
};

/**
 * The append-only record every state change goes through. Nothing is updated or deleted; current
 * state is a projection of these rows (see `session.ts`).
 */
export class Journal {
  readonly #db: DatabaseSync;
  readonly #insert;

  private constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        session TEXT NOT NULL,
        actor TEXT NOT NULL,
        at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_session ON events (session, seq);
    `);
    this.#insert = db.prepare(
      'INSERT INTO events (id, type, session, actor, at, data) VALUES (?, ?, ?, ?, ?, ?)',
    );
  }

  /** A journal in a file, created if missing, or in memory for tests. */
  static open(path: string | ':memory:'): Journal {
    return new Journal(new DatabaseSync(path));
  }

  append(event: BoopyEvent, id: string, at: string): Recorded {
    const result = this.#insert.run(
      id,
      event.type,
      event.session,
      event.actor,
      at,
      JSON.stringify(event.data),
    );
    return { ...event, seq: Number(result.lastInsertRowid), id, at };
  }

  all(): Recorded[] {
    const rows = this.#db
      .prepare('SELECT seq, id, type, session, actor, at, data FROM events ORDER BY seq')
      .all() as unknown as Row[];
    return rows.map(
      (row) =>
        ({
          seq: row.seq,
          id: row.id,
          type: row.type,
          session: row.session,
          actor: row.actor,
          at: row.at,
          data: JSON.parse(row.data),
        }) as Recorded,
    );
  }

  close(): void {
    this.#db.close();
  }

  /** Whether any event already has this id. Ids are unique across every event type. */
  has(id: string): boolean {
    return this.#db.prepare('SELECT 1 FROM events WHERE id = ? LIMIT 1').get(id) !== undefined;
  }

  /** The events whose type starts with this prefix, exactly and case-sensitively, in order. */
  withTypePrefix(prefix: string): Recorded[] {
    const rows = this.#db
      .prepare(
        'SELECT seq, id, type, session, actor, at, data FROM events WHERE substr(type, 1, ?) = ? ORDER BY seq',
      )
      .all(prefix.length, prefix) as unknown as Row[];
    return rows.map(
      (row) =>
        ({
          seq: row.seq,
          id: row.id,
          type: row.type,
          session: row.session,
          actor: row.actor,
          at: row.at,
          data: JSON.parse(row.data),
        }) as Recorded,
    );
  }

  /**
   * Runs `work` in one SQLite transaction: every append it makes is kept, or none is. The work
   * must be synchronous, because a transaction cannot wait across an await.
   */
  transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      if (result instanceof Promise) {
        result.catch(() => {});
        throw new Error('A journal transaction must be synchronous.');
      }
      this.#db.exec('COMMIT');
      return result;
    } catch (failure) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw failure;
    }
  }
}

interface Row {
  seq: number;
  id: string;
  type: string;
  session: string;
  actor: string;
  at: string;
  data: string;
}

/** Frames and audio, stored once each under their SHA-256. */
export class MediaStore {
  readonly #directory: string | null;
  readonly #memory = new Map<string, Buffer>();

  /** A directory on disk, or null to keep media in memory (tests). */
  constructor(directory: string | null) {
    this.#directory = directory;
    if (directory !== null) mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  put(bytes: Buffer, extension: 'jpg' | 'wav' | 'mask'): string {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const name = `${hash}.${extension}`;
    if (this.#directory === null) this.#memory.set(name, bytes);
    else writeFileSync(join(this.#directory, name), bytes, { mode: 0o600 });
    return hash;
  }

  get(hash: string, extension: 'jpg' | 'wav' | 'mask'): Buffer {
    const name = `${hash}.${extension}`;
    if (this.#directory === null) {
      const bytes = this.#memory.get(name);
      if (bytes === undefined) throw new Error(`No media ${name}.`);
      return bytes;
    }
    return readFileSync(join(this.#directory, name));
  }
}
