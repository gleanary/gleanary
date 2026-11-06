import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import * as schema from '@/db/schema';
import { initFts } from '@/db/fts';
import { runMigrations } from '../../scripts/migrate-runner.mjs';
import type { SQLiteInsertValue } from 'drizzle-orm/sqlite-core';
import type { Article } from '@/types';

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

type TestDb = BetterSQLite3Database<typeof schema>;

/**
 * Looks up the `web_save` singleton source that migration 0024 creates in every DB.
 * Looked up by type: never assume its id.
 * @param db - Drizzle instance on a fully migrated test DB
 * @returns The id of the `web_save` source
 */
export function webSaveSourceId(db: TestDb): number {
  const row = db
    .select({ id: schema.sources.id })
    .from(schema.sources)
    .where(eq(schema.sources.type, 'web_save'))
    .get();
  if (!row) throw new Error('webSaveSourceId: no web_save source (is migration 0024 applied?)');
  return row.id;
}

/**
 * Inserts one article for a test. `sourceId` defaults to the `web_save` singleton,
 * since `articles.source_id` is NOT NULL.
 * @param db - Drizzle instance on a fully migrated test DB
 * @param values - Article columns; `sourceId` is optional
 * @returns The inserted article row
 */
export function insertTestArticle(
  db: TestDb,
  values: Omit<SQLiteInsertValue<typeof schema.articles>, 'sourceId'> & { sourceId?: number },
): Article {
  return db
    .insert(schema.articles)
    .values({ ...values, sourceId: values.sourceId ?? webSaveSourceId(db) })
    .returning()
    .get()!;
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
