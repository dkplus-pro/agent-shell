/**
 * Storage wiring for `state.sqlite` (docs/01-architecture.md §5.7):
 * one file, one connection, WAL, 0700/0600 permissions, LangGraph checkpoints
 * from `SqliteSaver` coexisting with the `sessions` metadata table.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  MemorySaver,
  emptyCheckpoint,
  type BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointMetadata,
} from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { ConfigError } from '../../src/errors/index.js';
import { newSessionId } from '../../src/ids.js';
import {
  openCheckpointer,
  stateFilePath,
  type DatabaseType,
} from '../../src/storage/checkpointer.js';
import { SessionStore } from '../../src/storage/sessions.js';

const INJECTABLE_TITLE = "'; drop table sessions; --";

const tempDirs: string[] = [];

async function makeTempRoot(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-shell-storage-'));
  tempDirs.push(dir);
  return dir;
}

/** Directory itself must be 0700, database file 0600 (docs/03 §7 discipline). */
function modeOf(target: string): string {
  return (fs.statSync(target).mode & 0o777).toString(8).padStart(3, '0');
}

function journalMode(database: DatabaseType): string {
  const rows = database.pragma('journal_mode') as { journal_mode: string }[];
  const first = rows[0];
  return first ? first.journal_mode : '';
}

function tableNames(database: DatabaseType): string[] {
  return (
    database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

function runCount(database: DatabaseType, id: string): number {
  const row = database.prepare(`SELECT run_count AS n FROM sessions WHERE id = ?`).get(id) as {
    n: number;
  };
  return row.n;
}

const metadata: CheckpointMetadata = { source: 'input', step: 0, parents: {} };

/**
 * `put` is called through the public `BaseCheckpointSaver` signature — the
 * abstract type needs the `newVersions` argument even though `SqliteSaver`
 * ignores it, so the test exercises the same surface the runtime uses.
 */
async function putCheckpoint(saver: BaseCheckpointSaver, threadId: string, checkpoint: Checkpoint) {
  return saver.put(
    { configurable: { thread_id: threadId } },
    checkpoint,
    metadata,
    checkpoint.channel_versions,
  );
}

describe('openCheckpointer sqlite', () => {
  it('creates the state file with 0700 dir / 0600 file and WAL enabled', async () => {
    const root = await makeTempRoot();
    const dataDir = path.join(root, 'nested', '.agent-shell');
    const handle = await openCheckpointer({ kind: 'sqlite', dataDir });
    try {
      expect(fs.existsSync(stateFilePath(dataDir))).toBe(true);
      expect(modeOf(dataDir)).toBe('700');
      expect(modeOf(stateFilePath(dataDir))).toBe('600');
      expect(handle.database).toBeDefined();
      expect(journalMode(handle.database as DatabaseType)).toBe('wal');
      expect(stateFilePath(dataDir)).toBe(path.join(dataDir, 'state.sqlite'));
    } finally {
      await handle.close();
    }
  });

  it('honours a custom filename', async () => {
    const dataDir = await makeTempRoot();
    const handle = await openCheckpointer({ kind: 'sqlite', dataDir, filename: 'other.sqlite' });
    try {
      expect(stateFilePath(dataDir, 'other.sqlite')).toBe(path.join(dataDir, 'other.sqlite'));
      expect(fs.existsSync(path.join(dataDir, 'other.sqlite'))).toBe(true);
      expect(modeOf(path.join(dataDir, 'other.sqlite'))).toBe('600');
    } finally {
      await handle.close();
    }
  });

  it('round-trips a real checkpoint through SqliteSaver', async () => {
    const dataDir = await makeTempRoot();
    const handle = await openCheckpointer({ kind: 'sqlite', dataDir });
    // Proves the sqlite saver, not an in-memory fallback, is what we hand back.
    expect(handle.saver).toBeInstanceOf(SqliteSaver);
    const threadId = newSessionId();
    try {
      const checkpoint = emptyCheckpoint();
      const saved = await putCheckpoint(handle.saver, threadId, checkpoint);
      expect(saved.configurable?.checkpoint_id).toBe(checkpoint.id);

      const tuple = await handle.saver.getTuple({ configurable: { thread_id: threadId } });
      expect(tuple?.checkpoint.id).toBe(checkpoint.id);
      expect(tuple?.checkpoint.channel_values).toEqual({});
      expect(tuple?.metadata?.source).toBe('input');

      // A different thread sees nothing of this thread's state.
      expect(
        await handle.saver.getTuple({ configurable: { thread_id: newSessionId() } }),
      ).toBeUndefined();

      const rows = (handle.database as DatabaseType)
        .prepare(`SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id = ?`)
        .all(threadId) as { n: number }[];
      expect(rows[0]?.n).toBe(1);
    } finally {
      await handle.close();
    }
  });

  it('persists checkpoints across a reopen of the same file', async () => {
    const dataDir = await makeTempRoot();
    const threadId = newSessionId();
    const first = await openCheckpointer({ kind: 'sqlite', dataDir });
    const checkpoint = emptyCheckpoint();
    await putCheckpoint(first.saver, threadId, checkpoint);
    await first.close();

    const second = await openCheckpointer({ kind: 'sqlite', dataDir });
    try {
      const tuple = await second.saver.getTuple({ configurable: { thread_id: threadId } });
      expect(tuple?.checkpoint.id).toBe(checkpoint.id);
    } finally {
      await second.close();
    }
  });

  it('close() is idempotent and shuts the connection down', async () => {
    const dataDir = await makeTempRoot();
    const handle = await openCheckpointer({ kind: 'sqlite', dataDir });
    const database = handle.database as DatabaseType;
    expect(database.open).toBe(true);
    await handle.close();
    await handle.close();
    await handle.close();
    expect(database.open).toBe(false);
  });

  it('rejects an unusable state file instead of silently continuing', async () => {
    const dataDir = await makeTempRoot();
    await fsp.writeFile(stateFilePath(dataDir), 'this is definitely not a sqlite file\n', {
      mode: 0o600,
    });
    await expect(openCheckpointer({ kind: 'sqlite', dataDir })).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('openCheckpointer memory', () => {
  it('returns a MemorySaver without touching disk', async () => {
    const root = await makeTempRoot();
    const dataDir = path.join(root, 'must-not-exist');
    const handle = await openCheckpointer({ kind: 'memory', dataDir });
    try {
      expect(handle.saver).toBeInstanceOf(MemorySaver);
      expect(handle.database).toBeUndefined();
      expect(fs.existsSync(dataDir)).toBe(false);

      const threadId = newSessionId();
      const checkpoint = emptyCheckpoint();
      await putCheckpoint(handle.saver, threadId, checkpoint);
      const tuple = await handle.saver.getTuple({ configurable: { thread_id: threadId } });
      expect(tuple?.checkpoint.id).toBe(checkpoint.id);
      expect(fs.existsSync(dataDir)).toBe(false);
    } finally {
      await handle.close();
      await handle.close();
    }
  });
});

describe('SessionStore', () => {
  it('lists newest updated_at first', async () => {
    const dataDir = await makeTempRoot();
    const handle = await openCheckpointer({ kind: 'sqlite', dataDir });
    const database = handle.database as DatabaseType;
    let clock = Date.parse('2026-11-03T10:00:00.000Z');
    const store = new SessionStore(database, { now: () => new Date((clock += 60_000)) });
    try {
      const a = store.create('ses_a', { title: 'A' });
      store.create('ses_b', { title: 'B' });
      store.create('ses_c', { title: 'C' });
      expect(a.title).toBe('A');
      expect(store.list().map((record) => record.id)).toEqual(['ses_c', 'ses_b', 'ses_a']);
      expect(store.list(2).map((record) => record.id)).toEqual(['ses_c', 'ses_b']);

      store.touch('ses_a');
      expect(store.list().map((record) => record.id)).toEqual(['ses_a', 'ses_c', 'ses_b']);
      expect(store.count()).toBe(3);
    } finally {
      await handle.close();
    }
  });

  it('stores ISO-8601 UTC timestamps and provider/model', async () => {
    const dataDir = await makeTempRoot();
    const handle = await openCheckpointer({ kind: 'sqlite', dataDir });
    const store = new SessionStore(handle.database as DatabaseType, {
      now: () => new Date(Date.parse('2026-11-03T12:00:00.000Z')),
    });
    try {
      const record = store.create('ses_iso', {
        title: 'Iso',
        provider: 'openai',
        model: 'gpt-4o-mini',
      });
      expect(record.createdAt).toBe('2026-11-03T12:00:00.000Z');
      expect(record.updatedAt).toBe('2026-11-03T12:00:00.000Z');
      expect(record.lastProvider).toBe('openai');
      expect(record.lastModel).toBe('gpt-4o-mini');
      expect(store.get('ses_missing')).toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('create() is idempotent and preserves the original row', async () => {
    const dataDir = await makeTempRoot();
    const handle = await openCheckpointer({ kind: 'sqlite', dataDir });
    const database = handle.database as DatabaseType;
    let clock = Date.parse('2026-11-03T08:00:00.000Z');
    const store = new SessionStore(database, { now: () => new Date((clock += 60_000)) });
    try {
      const created = store.create('ses_twice', {
        title: 'first',
        provider: 'openai',
        model: 'm-1',
      });
      const again = store.create('ses_twice', {
        title: 'second',
        provider: 'anthropic',
        model: 'm-2',
      });
      expect(again.id).toBe(created.id);
      expect(again.title).toBe('first');
      expect(again.lastProvider).toBe('openai');
      expect(again.createdAt).toBe(created.createdAt);
      expect(again.updatedAt).not.toBe(created.updatedAt);
      expect(store.count()).toBe(1);
    } finally {
      await handle.close();
    }
  });

  it('touch() creates when missing and increments run_count', async () => {
    const dataDir = await makeTempRoot();
    const handle = await openCheckpointer({ kind: 'sqlite', dataDir });
    const database = handle.database as DatabaseType;
    const store = new SessionStore(database);
    try {
      const made = store.touch('ses_new', {
        title: 'from touch',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        incrementRuns: true,
      });
      expect(made.title).toBe('from touch');
      expect(made.lastProvider).toBe('anthropic');
      expect(made.lastModel).toBe('claude-sonnet-4-5');
      expect(made.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(runCount(database, 'ses_new')).toBe(1);

      store.touch('ses_new', { incrementRuns: true });
      store.touch('ses_new', { incrementRuns: true });
      expect(runCount(database, 'ses_new')).toBe(3);

      // A patch without incrementRuns leaves the counter alone.
      store.touch('ses_new', { title: 'renamed' });
      expect(runCount(database, 'ses_new')).toBe(3);
      expect(store.get('ses_new')?.title).toBe('renamed');
      expect(store.count()).toBe(1);
    } finally {
      await handle.close();
    }
  });

  it('remove() reports whether a row existed', async () => {
    const dataDir = await makeTempRoot();
    const handle = await openCheckpointer({ kind: 'sqlite', dataDir });
    const store = new SessionStore(handle.database as DatabaseType);
    try {
      store.create('ses_gone');
      expect(store.remove('ses_gone')).toBe(true);
      expect(store.remove('ses_gone')).toBe(false);
      expect(store.remove('ses_unknown')).toBe(false);
      expect(store.get('ses_gone')).toBeUndefined();
      expect(store.count()).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it('treats SQL-injection-looking titles as literal data', async () => {
    const dataDir = await makeTempRoot();
    const handle = await openCheckpointer({ kind: 'sqlite', dataDir });
    const database = handle.database as DatabaseType;
    const store = new SessionStore(database);
    try {
      const record = store.create('ses_inject', { title: INJECTABLE_TITLE });
      expect(record.title).toBe(INJECTABLE_TITLE);
      expect(store.touch('ses_inject', { title: INJECTABLE_TITLE }).title).toBe(INJECTABLE_TITLE);

      // The table survived: it is still queryable and the value is data.
      expect(tableNames(database)).toContain('sessions');
      expect(store.count()).toBe(1);
      expect(store.list()[0]?.title).toBe(INJECTABLE_TITLE);
      const rows = database
        .prepare(`SELECT title FROM sessions WHERE id = ?`)
        .all('ses_inject') as {
        title: string;
      }[];
      expect(rows[0]?.title).toBe(INJECTABLE_TITLE);

      store.create('ses_after', { title: 'still works' });
      expect(store.count()).toBe(2);
    } finally {
      await handle.close();
    }
  });

  it('preserves rows when the same file is reopened', async () => {
    const dataDir = await makeTempRoot();
    const first = await openCheckpointer({ kind: 'sqlite', dataDir });
    const store = new SessionStore(first.database as DatabaseType);
    store.create('ses_persist', { title: 'kept', provider: 'openai', model: 'm' });
    store.touch('ses_persist', { incrementRuns: true });
    const before = store.get('ses_persist');
    await first.close();

    const second = await openCheckpointer({ kind: 'sqlite', dataDir });
    const reopened = new SessionStore(second.database as DatabaseType);
    try {
      expect(reopened.count()).toBe(1);
      const after = reopened.get('ses_persist');
      expect(after).toEqual(before);
      expect(runCount(second.database as DatabaseType, 'ses_persist')).toBe(1);
    } finally {
      await second.close();
    }
  });

  it('rejects a nonsense list limit', async () => {
    const dataDir = await makeTempRoot();
    const handle = await openCheckpointer({ kind: 'sqlite', dataDir });
    const store = new SessionStore(handle.database as DatabaseType);
    try {
      expect(() => store.list(-2)).toThrow(ConfigError);
    } finally {
      await handle.close();
    }
  });
});

describe('sessions and checkpoints share one file', () => {
  it('keeps both sets of tables in the same state.sqlite', async () => {
    const dataDir = await makeTempRoot();
    const handle = await openCheckpointer({ kind: 'sqlite', dataDir });
    const database = handle.database as DatabaseType;
    const store = new SessionStore(database);
    const threadId = newSessionId();
    try {
      store.create(threadId, { title: 'shared', provider: 'openai', model: 'm' });
      const checkpoint = emptyCheckpoint();
      await putCheckpoint(handle.saver, threadId, checkpoint);

      const names = tableNames(database);
      expect(names).toContain('sessions');
      expect(names).toContain('checkpoints');
      expect(names).toContain('writes');

      // Sessions metadata and checkpoint state were written through one
      // connection: index-only difference, same file.
      const files = fs
        .readdirSync(dataDir)
        .filter((name) => !name.endsWith('-wal') && !name.endsWith('-shm'));
      expect(files).toEqual(['state.sqlite']);
      expect(modeOf(path.join(dataDir, 'state.sqlite'))).toBe('600');

      const tuple = await handle.saver.getTuple({ configurable: { thread_id: threadId } });
      expect(tuple?.checkpoint.id).toBe(checkpoint.id);
      expect(store.get(threadId)?.title).toBe('shared');
    } finally {
      await handle.close();
    }
  });

  it('close() on both the handle and the store leaves one clean shutdown', async () => {
    const dataDir = await makeTempRoot();
    const handle = await openCheckpointer({ kind: 'sqlite', dataDir });
    const database = handle.database as DatabaseType;
    const store = new SessionStore(database);
    store.create('ses_close');
    store.close();
    expect(database.open).toBe(false);
    await handle.close();
    expect(database.open).toBe(false);
  });
});

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

afterAll(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});
