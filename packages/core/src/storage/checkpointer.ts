/**
 * State storage wiring (docs/01-architecture.md §5.7, docs/03-cli-and-trace.md §7).
 *
 * One SQLite file — `<dataDir>/state.sqlite` by default — holds both the
 * LangGraph checkpoints owned by `SqliteSaver` and the `sessions` listing
 * metadata owned by `SessionStore` (see `./sessions.ts`).  They share a single
 * better-sqlite3 connection on purpose: one file, one writer, WAL journal,
 * single process / single user.
 *
 * Filesystem permissions follow the trace-directory discipline: directory 0700,
 * database file 0600.  SQLite also creates `-wal` / `-shm` sidecars next to the
 * database; they inherit the parent directory's restrictive mode.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';
import { MemorySaver, type BaseCheckpointSaver } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

import { ConfigError } from '../errors/index.js';

/** The better-sqlite3 connection type, named once so callers never spell it out. */
export type DatabaseType = Database.Database;

export const DEFAULT_STATE_FILENAME = 'state.sqlite';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const BUSY_TIMEOUT_MS = 5000;

export interface OpenCheckpointerOptions {
  /** `config.checkpointer` in `agent-shell.config.ts`; sqlite is the default. */
  kind: 'sqlite' | 'memory';
  /** `config.trace.dataDir`, e.g. `.agent-shell` — checkpoints live beside traces. */
  dataDir: string;
  filename?: string;
}

export interface CheckpointerHandle {
  saver: BaseCheckpointSaver;
  /** Present for the sqlite kind; hand it to `SessionStore` to share the file. */
  database?: DatabaseType;
  /** Idempotent. Closes the saver (when it exposes a close) then the connection. */
  close(): Promise<void>;
}

/**
 * `BaseCheckpointSaver` declares neither `setup()` nor `close()`, and
 * `SqliteSaver.setup()` is `protected`, so it is not callable through the
 * public type. Both are probed structurally via `unknown` (never `any`).
 */
interface SaverHooks {
  setup?: () => void;
  close?: () => unknown;
}

export function stateFilePath(dataDir: string, filename = DEFAULT_STATE_FILENAME): string {
  return path.join(dataDir, filename);
}

export async function openCheckpointer(opts: OpenCheckpointerOptions): Promise<CheckpointerHandle> {
  if (opts.kind === 'memory') {
    const saver = new MemorySaver();
    return {
      saver,
      async close(): Promise<void> {
        await closeSaver(saver);
      },
    };
  }

  const file = stateFilePath(opts.dataDir, opts.filename);
  const database = await openDatabase(file, opts.dataDir);
  try {
    // The existing connection is passed in, not a conn string: `fromConnString`
    // would open a second connection to the same file and split the writers.
    const saver = new SqliteSaver(database);
    saverSetup(saver);
    let closed = false;
    return {
      saver,
      database,
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await closeSaver(saver);
        closeDatabase(database);
      },
    };
  } catch (error) {
    closeDatabase(database);
    throw new ConfigError(`Failed to initialise the SQLite checkpointer at ${file}.`, error);
  }
}

async function openDatabase(file: string, dataDir: string): Promise<DatabaseType> {
  await makeDirectory(dataDir, file);
  let database: DatabaseType | undefined;
  try {
    database = new Database(file, { timeout: BUSY_TIMEOUT_MS });
    database.pragma('journal_mode = WAL');
    // Interpolated value is this module's own numeric constant, never caller data.
    database.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return database;
  } catch (error) {
    if (database) closeDatabase(database);
    throw new ConfigError(`Failed to open the state database at ${file}.`, error);
  }
}

async function makeDirectory(dataDir: string, file: string): Promise<void> {
  try {
    await fs.mkdir(dataDir, { recursive: true, mode: DIRECTORY_MODE });
    // mkdir applies the umask to inherited parents; chmod makes the intent real.
    await fs.chmod(dataDir, DIRECTORY_MODE);
    // "a" creates a missing file and never truncates an existing database.
    const handle = await fs.open(file, 'a');
    await handle.close();
    await fs.chmod(file, FILE_MODE);
  } catch (error) {
    throw new ConfigError(`Failed to prepare the state directory ${dataDir}.`, error);
  }
}

function saverSetup(saver: SqliteSaver): void {
  (saver as unknown as SaverHooks).setup?.();
}

async function closeSaver(saver: BaseCheckpointSaver): Promise<void> {
  const close = (saver as unknown as SaverHooks).close;
  if (typeof close === 'function') await close.call(saver);
}

function closeDatabase(database: DatabaseType): void {
  if (database.open) database.close();
}
