import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'fs';
import path from 'path';
import * as schema from '@/db/schema';
import { initFts } from '@/db/fts';
import { runMigrations } from '../../scripts/migrate-runner.mjs';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'drizzle');

/** Migration-runner log that discards progress output (failures still throw). */
export const silentLog = { info: () => {}, warn: () => {} };

/**
 * Creates a fresh in-memory SQLite database for integration tests.
 * Each test gets an isolated database with all migrations and FTS5 tables applied,
 * through the same runner production uses (scripts/migrate-runner.mjs).
 * @returns Object containing the Drizzle db instance and raw SQLite connection
 */
export function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  runMigrations(sqlite, MIGRATIONS_DIR, { log: silentLog });
  initFts(sqlite);
  return { db, sqlite };
}

/**
 * Copies the migrations folder into `dir`, keeping only the journal entries before
 * `tag`, so `runMigrations` on the result builds the schema as it was just before it.
 * @param dir - empty temp folder to write the truncated migrations folder into
 * @param tag - journal tag of the first migration to leave out (e.g. `0023_x`)
 * @returns `dir`, ready to pass to `runMigrations`
 */
export function migrationsBefore(dir: string, tag: string): string {
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf-8'),
  ) as { entries: { tag: string }[] };
  const cut = journal.entries.findIndex((e) => e.tag === tag);
  if (cut <= 0) throw new Error(`migrationsBefore: ${tag} is not a non-initial journal entry`);
  const entries = journal.entries.slice(0, cut);
  fs.mkdirSync(path.join(dir, 'meta'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries }),
  );
  for (const { tag: t } of entries) {
    fs.copyFileSync(path.join(MIGRATIONS_DIR, `${t}.sql`), path.join(dir, `${t}.sql`));
  }
  return dir;
}

/**
 * Vitest mock factory for `@/db`. Use with `vi.hoisted` + `vi.mock`.
 * Returns getters that resolve to the latest test DB set via `setTestDb`.
 */
export function createDbMock() {
  const state = {
    db: null as ReturnType<typeof createTestDb>['db'] | null,
    rawDb: null as Database.Database | null,
  };
  return {
    mock: {
      get db() {
        return state.db;
      },
      get rawDb() {
        return state.rawDb;
      },
    },
    /** Call in beforeEach to set up a fresh test DB */
    setup() {
      const testDb = createTestDb();
      state.db = testDb.db;
      state.rawDb = testDb.sqlite;
      return testDb;
    },
  };
}
