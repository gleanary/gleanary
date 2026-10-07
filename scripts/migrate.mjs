// scripts/migrate.mjs
// Runs SQL migrations using only better-sqlite3 (available in standalone build).
// Reads the drizzle journal (drizzle/meta/_journal.json) and applies pending
// migrations in order, recording them in the exact format `drizzle-kit migrate`
// uses — hash = sha256(file content), created_at = the journal's `when` millis —
// so the two runners are interchangeable on the same database.
// Legacy rows written by older versions of this script (hash = filename,
// created_at = unix seconds) are normalized to that format on sight.

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

// Same shape drizzle-kit creates (SERIAL is a no-op affinity in SQLite)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS __drizzle_migrations (
    id SERIAL PRIMARY KEY,
    hash text NOT NULL,
    created_at numeric
  )
`);

const journal = JSON.parse(
  fs.readFileSync(path.join(migrationsDir, 'meta', '_journal.json'), 'utf-8'),
);
const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
console.log(`[migrate] Found ${entries.length} migrations in journal`);

const migrations = entries.map((entry) => {
  const file = `${entry.tag}.sql`;
  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
  return { file, when: entry.when, sql, hash: createHash('sha256').update(sql).digest('hex') };
});

// Normalize legacy rows (hash = filename, created_at = unix seconds) to the
// drizzle-kit format so `npm run db:migrate` works on this DB afterwards.
const normalize = sqlite.prepare(
  'UPDATE __drizzle_migrations SET hash = ?, created_at = ? WHERE hash = ?',
);
let normalized = 0;
for (const m of migrations) {
  try {
    normalized += normalize.run(m.hash, m.when, m.file).changes;
  } catch (e) {
    // Legacy tables carry UNIQUE(hash): if two migrations have identical
    // content the second UPDATE would collide — the row is redundant, drop it.
    if (!e.message.includes('UNIQUE')) throw e;
    sqlite.prepare('DELETE FROM __drizzle_migrations WHERE hash = ?').run(m.file);
    normalized++;
  }
}
if (normalized > 0) {
  console.log(`[migrate] Normalized ${normalized} legacy tracking rows to drizzle-kit format`);
}

// drizzle-kit's own applied-check, verbatim: anything at or before the newest
// recorded created_at has been applied. Using the same rule (rather than hash
// membership) keeps the two runners' decisions identical by construction.
const { maxCreatedAt } = sqlite
  .prepare('SELECT MAX(CAST(created_at AS INTEGER)) AS maxCreatedAt FROM __drizzle_migrations')
  .get();
const appliedHashes = new Set(
  sqlite
    .prepare('SELECT hash FROM __drizzle_migrations')
    .all()
    .map((r) => r.hash),
);

const insert = sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)');
let newMigrations = 0;
for (const m of migrations) {
  if (maxCreatedAt !== null && m.when <= maxCreatedAt) {
    // Same silent skip drizzle-kit would do — but surface the one case where
    // it hides a real problem (an unapplied migration older than the newest
    // applied one, e.g. after a branch merge reordered journal timestamps).
    if (!appliedHashes.has(m.hash)) {
      console.warn(
        `[migrate] WARNING: ${m.file} skipped by timestamp but its hash is not recorded — it may never have been applied. Verify the schema manually.`,
      );
    }
    continue;
  }

  console.log(`[migrate] Applying: ${m.file}`);
  sqlite.exec(m.sql);
  insert.run(m.hash, m.when);
  newMigrations++;
}

console.log(
  `[migrate] Applied ${newMigrations} new migrations (${migrations.length - newMigrations} already applied)`,
);

// FTS5 virtual tables + sync triggers are owned solely by initFts() in
// src/db/fts.ts, which runs at first app DB access and self-heals. This script
// deliberately does not touch FTS so the two definitions cannot drift.
sqlite.close();
console.log('[migrate] Done.');
