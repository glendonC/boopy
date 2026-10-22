import { DatabaseSync } from 'node:sqlite';

/** An event as stored: its position in the journal and when it was written. */
export type Recorded = {
  readonly seq: number;
  readonly id: string;
  readonly type: string;
  readonly session: string;
  readonly actor: string;
  readonly at: string;
  readonly data: unknown;
};

export type JournalEvent = {
  readonly type: string;
  readonly session: string;
  readonly actor: string;
  readonly data: unknown;
};

/**
 * The append-only record every state change goes through. Nothing is updated or deleted; current
 * state is a projection of these rows.
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

  append(event: JournalEvent, id: string, at: string): Recorded {
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
    return rows.map((row) => ({
      seq: row.seq,
      id: row.id,
      type: row.type,
      session: row.session,
      actor: row.actor,
      at: row.at,
      data: JSON.parse(row.data) as unknown,
    }));
  }

  close(): void {
    this.#db.close();
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
