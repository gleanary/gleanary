import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '@/db/schema';
import { initFts } from '@/db/fts';

/**
 * Creates a fresh in-memory SQLite database for integration tests.
 * Each test gets an isolated database with all migrations and FTS5 tables applied.
 * @returns Object containing the Drizzle db instance and raw SQLite connection
 */
export function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  initFts(sqlite);
  return { db, sqlite };
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
