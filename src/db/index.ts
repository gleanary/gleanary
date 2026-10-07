import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import { initFts } from '@/db/fts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'file:./data/gleanary.db';

/**
 * Resolves the database path from a URL-style connection string.
 * @param url - Database URL in the format `file:./path/to/db.db`
 * @returns The resolved file path
 */
function resolveDatabasePath(url: string): string {
  return url.replace(/^file:/, '');
}

let _sqlite: Database.Database | null = null;
let _db: BetterSQLite3Database<typeof schema> | null = null;

/**
 * Lazily initializes the SQLite connection and Drizzle ORM instance.
 * Called on first access to `db` or `rawDb`, not at module import time.
 * This prevents build failures when the data directory doesn't exist.
 */
function initDb(): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> } {
  if (_sqlite && _db) return { sqlite: _sqlite, db: _db };

  _sqlite = new Database(resolveDatabasePath(DATABASE_URL));

  // Enable WAL mode for better concurrent read performance
  _sqlite.pragma('journal_mode = WAL');
  _sqlite.pragma('foreign_keys = ON');

  _db = drizzle(_sqlite, { schema });

  // Initialize FTS5 virtual tables and sync triggers
  initFts(_sqlite);

  return { sqlite: _sqlite, db: _db };
}

/** Drizzle ORM database instance (lazy — connects on first use) */
export const db = new Proxy({} as BetterSQLite3Database<typeof schema>, {
  get(_target, prop, receiver) {
    const { db: realDb } = initDb();
    return Reflect.get(realDb, prop, receiver);
  },
});

/** Raw better-sqlite3 instance for health checks, FTS5, etc. (lazy — connects on first use) */
export const rawDb = new Proxy({} as Database.Database, {
  get(_target, prop, receiver) {
    const { sqlite } = initDb();
    return Reflect.get(sqlite, prop, receiver);
  },
});
