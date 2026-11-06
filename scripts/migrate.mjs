// scripts/migrate.mjs
// CLI for the only migration runner (scripts/migrate-runner.mjs): `npm run
// db:migrate` and the `prestart` hook both run it. It opens the database,
// applies pending migrations from drizzle/ and closes. Never run
// `drizzle-kit migrate` or `drizzle-kit push`: only this runner applies
// migrations (atomically, with foreign keys off; see migrate-runner.mjs).
// Tracking rows keep the hash format (sha256 of the file, journal `when` millis)
// for compatibility with the rows existing databases already hold.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { runMigrations } from './migrate-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'drizzle');

const dbPath = (process.env.DATABASE_URL || 'file:./data/gleanary.db').replace('file:', '');

// Ensure parent directory exists (volume mounts may not preserve dirs created at build time)
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

console.log(`[migrate] Opening database at ${dbPath}`);

const sqlite = new Database(dbPath);
try {
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  // FTS5 virtual tables + sync triggers are owned solely by initFts() in
  // src/db/fts.ts, which runs at first app DB access and self-heals. This script
  // deliberately does not touch FTS so the two definitions cannot drift.
  const { applied, skipped } = runMigrations(sqlite, migrationsDir);
  console.log(`[migrate] Applied ${applied} new migrations (${skipped} already applied)`);
} finally {
  sqlite.close();
}
console.log('[migrate] Done.');
