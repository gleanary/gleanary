import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ARTICLES_FTS_COLUMNS } from '@/db/fts';

const ROOT = path.resolve(__dirname, '..', '..');
const MIGRATE = path.join(ROOT, 'scripts', 'migrate.mjs');
const JOURNAL = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'drizzle', 'meta', '_journal.json'), 'utf-8'),
) as { entries: { tag: string; when: number }[] };

/** Run scripts/migrate.mjs against the given DB file, returning stdout. Throws on non-zero exit. */
function runMigrate(dbPath: string): string {
  return execFileSync(process.execPath, [MIGRATE], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    encoding: 'utf-8',
  });
}

function readSql(tag: string): string {
  return fs.readFileSync(path.join(ROOT, 'drizzle', `${tag}.sql`), 'utf-8');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Seed a DB exactly the way `drizzle-kit migrate` leaves it, by running the
 * real drizzle migrator (same call as createTestDb in setup.ts) — the interop
 * test then proves compatibility with drizzle itself, not a simulation of it.
 */
function seedDrizzleKitTrackedDb(dbPath: string): void {
  const sqlite = new Database(dbPath);
  migrate(drizzle(sqlite), { migrationsFolder: path.join(ROOT, 'drizzle') });
  sqlite.close();
}

/**
 * Seed a DB the way the legacy migrate.mjs left it: all migrations applied,
 * tracked as (filename, unixepoch-seconds).
 */
function seedLegacyFilenameTrackedDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(
    `CREATE TABLE __drizzle_migrations (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       hash TEXT NOT NULL UNIQUE,
       created_at INTEGER NOT NULL DEFAULT (unixepoch())
     )`,
  );
  for (const entry of JOURNAL.entries) {
    // drizzle-kit splits on breakpoints; sqlite exec handles multi-statement strings
    db.exec(readSql(entry.tag).replaceAll('--> statement-breakpoint', ';'));
    db.prepare(`INSERT INTO __drizzle_migrations (hash) VALUES (?)`).run(`${entry.tag}.sql`);
  }
  db.close();
}

function trackedRows(dbPath: string): { hash: string; created_at: number }[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at`)
    .all() as { hash: string; created_at: number }[];
  db.close();
  return rows;
}

describe('scripts/migrate.mjs interop with drizzle-kit tracking', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gleanary-migrate-'));
    dbPath = path.join(dir, 'test.db');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('applies all migrations to a fresh DB and records drizzle-kit-compatible rows', () => {
    const out = runMigrate(dbPath);
    expect(out).toContain(`Applied ${JOURNAL.entries.length} new migrations`);

    const rows = trackedRows(dbPath);
    expect(rows).toHaveLength(JOURNAL.entries.length);
    // drizzle-kit's applied-check is `created_at >= folderMillis`; rows must be in millis
    const last = rows.at(-1)!;
    const lastEntry = JOURNAL.entries.at(-1)!;
    expect(Number(last.created_at)).toBe(lastEntry.when);
    expect(last.hash).toBe(sha256(readSql(lastEntry.tag)));
  });

  it('is a no-op on a drizzle-kit-tracked DB (does not re-apply migration 0000)', () => {
    seedDrizzleKitTrackedDb(dbPath);
    const out = runMigrate(dbPath);
    expect(out).toContain('Applied 0 new migrations');
  });

  it('is idempotent: second run applies nothing', () => {
    runMigrate(dbPath);
    const out = runMigrate(dbPath);
    expect(out).toContain('Applied 0 new migrations');
    expect(trackedRows(dbPath)).toHaveLength(JOURNAL.entries.length);
  });

  it('leaves no stale articles_fts behind (migrate.mjs must not own FTS shape)', () => {
    runMigrate(dbPath);

    const db = new Database(dbPath, { readonly: true });
    const ftsColumns = (
      db.prepare(`pragma table_info(articles_fts)`).all() as { name: string }[]
    ).map((c) => c.name);
    db.close();

    // FTS shape is owned solely by initFts() in src/db/fts.ts, which self-heals
    // at first app access. migrate.mjs must not create a stale (ai_index-less)
    // copy: articles_fts is either absent, or already the full 5-column shape.
    if (ftsColumns.length > 0) {
      expect([...ftsColumns].sort()).toEqual([...ARTICLES_FTS_COLUMNS].sort());
    }
  });

  it('normalizes legacy filename-tracked rows so drizzle-kit will not re-apply', () => {
    seedLegacyFilenameTrackedDb(dbPath);
    const out = runMigrate(dbPath);
    expect(out).toContain('Applied 0 new migrations');

    const rows = trackedRows(dbPath);
    expect(rows).toHaveLength(JOURNAL.entries.length);
    // After normalization every row must satisfy drizzle-kit's semantics:
    // hash = sha256(file content), created_at = journal folderMillis.
    const lastWhen = JOURNAL.entries.at(-1)!.when;
    expect(Math.max(...rows.map((r) => Number(r.created_at)))).toBe(lastWhen);
    const rowHashes = new Set(rows.map((r) => r.hash));
    for (const entry of JOURNAL.entries) {
      expect(rowHashes.has(sha256(readSql(entry.tag)))).toBe(true);
    }
  });
});
