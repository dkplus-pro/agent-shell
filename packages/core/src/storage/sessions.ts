/**
 * The `sessions` table — listing metadata only.
 *
 * Storage split (docs/01-architecture.md §5.7): the checkpointer in
 * `./checkpointer.ts` owns conversation state — messages, channel values and
 * pending writes live in its `checkpoints` / `writes` tables and must never be
 * duplicated here.  This table owns only what `agent-shell sessions list`
 * renders: identity, title, timestamps, the last provider/model and a run
 * counter.  Both sets of tables live in the same `state.sqlite`, on the same
 * better-sqlite3 connection, because a session's metadata and its resumable
 * state must not drift into separate files.
 *
 * Every statement is prepared and every value bound as a parameter; only
 * column names written in this file ever reach the SQL text.
 */
import type Database from 'better-sqlite3';
import type { SessionRecord } from '../runtime/types.js';
import { ConfigError, UnexpectedError } from '../errors/index.js';
import type { DatabaseType } from './checkpointer.js';

const SESSIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_provider TEXT,
  last_model TEXT,
  run_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions(updated_at DESC);
`;

interface SessionRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  last_provider: string | null;
  last_model: string | null;
  run_count: number;
}

export interface SessionCreateInit {
  title?: string;
  provider?: string;
  model?: string;
}

export interface SessionPatch {
  provider?: string;
  model?: string;
  title?: string;
  incrementRuns?: boolean;
}

export interface SessionStoreOptions {
  /** Injectable clock so tests can pin `updated_at` ordering. */
  now?: () => Date;
}

type Prepared = Database.Statement<unknown[], unknown>;

export class SessionStore {
  readonly #database: DatabaseType;
  readonly #now: () => Date;
  readonly #statements = new Map<string, Prepared>();

  constructor(database: DatabaseType, opts: SessionStoreOptions = {}) {
    this.#database = database;
    this.#now = opts.now ?? (() => new Date());
    this.#database.exec(SESSIONS_SCHEMA);
  }

  /**
   * Idempotent: an existing `id` returns the existing record (its `created_at`,
   * title and provider are preserved) with `updated_at` moved to now.
   */
  create(id: string, init: SessionCreateInit = {}): SessionRecord {
    if (this.get(id)) return this.touch(id);
    const stamp = this.#stamp();
    this.#statement(
      `INSERT INTO sessions (id, title, created_at, updated_at, last_provider, last_model, run_count)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    ).run(id, init.title ?? '', stamp, stamp, init.provider ?? null, init.model ?? null);
    return this.#require(id);
  }

  get(id: string): SessionRecord | undefined {
    const row = this.#statement(
      `SELECT id, title, created_at, updated_at, last_provider, last_model, run_count
       FROM sessions WHERE id = ?`,
    ).get(id) as SessionRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** Newest `updated_at` first; `limit` omitted means "all rows". */
  list(limit?: number): SessionRecord[] {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
      throw new ConfigError(`Session list limit must be a non-negative integer, got ${limit}.`);
    }
    const rows = this.#statement(
      `SELECT id, title, created_at, updated_at, last_provider, last_model, run_count
       FROM sessions ORDER BY updated_at DESC, id ASC LIMIT ?`,
    ).all(limit ?? -1) as SessionRow[];
    return rows.map(toRecord);
  }

  /** Creates the row when it is missing, then applies the patch. */
  touch(id: string, patch: SessionPatch = {}): SessionRecord {
    const stamp = this.#stamp();
    this.#statement(
      `INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at, run_count)
       VALUES (?, '', ?, ?, 0)`,
    ).run(id, stamp, stamp);

    const assignments: string[] = ['updated_at = ?'];
    const values: (string | number | null)[] = [stamp];
    if (patch.provider !== undefined) {
      assignments.push('last_provider = ?');
      values.push(patch.provider);
    }
    if (patch.model !== undefined) {
      assignments.push('last_model = ?');
      values.push(patch.model);
    }
    if (patch.title !== undefined) {
      assignments.push('title = ?');
      values.push(patch.title);
    }
    if (patch.incrementRuns) assignments.push('run_count = run_count + 1');

    this.#statement(`UPDATE sessions SET ${assignments.join(', ')} WHERE id = ?`).run(
      ...values,
      id,
    );
    return this.#require(id);
  }

  /** `false` when no session had that id. */
  remove(id: string): boolean {
    return this.#statement(`DELETE FROM sessions WHERE id = ?`).run(id).changes > 0;
  }

  count(): number {
    const row = this.#statement(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number };
    return row.n;
  }

  close(): void {
    this.#statements.clear();
    if (this.#database.open) this.#database.close();
  }

  #statement(sql: string): Prepared {
    const cached = this.#statements.get(sql);
    if (cached) return cached;
    const prepared = this.#database.prepare(sql);
    this.#statements.set(sql, prepared);
    return prepared;
  }

  #stamp(): string {
    return this.#now().toISOString();
  }

  #require(id: string): SessionRecord {
    const record = this.get(id);
    if (!record) {
      throw new UnexpectedError(`Session row ${id} vanished between write and read.`);
    }
    return record;
  }
}

/**
 * `run_count` is persisted but not part of `SessionRecord` (`runtime/types.ts`);
 * readers that need it query the column directly rather than widening the
 * shared contract.
 */
function toRecord(row: SessionRow): SessionRecord {
  const record: SessionRecord = {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.last_provider !== null) record.lastProvider = row.last_provider;
  if (row.last_model !== null) record.lastModel = row.last_model;
  return record;
}
