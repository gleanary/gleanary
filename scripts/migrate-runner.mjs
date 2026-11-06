// scripts/migrate-runner.mjs
// The only migration runner: scripts/migrate.mjs (CLI, `npm run db:migrate`,
// `prestart`) and the test setup (__tests__/integration/setup.ts) both call
// runMigrations(). Plain ESM using only better-sqlite3 and node builtins, so the
// standalone Docker image can run it. Never run `drizzle-kit migrate` or `push`.
//
// Each pending migration is applied with SQLite's procedure for schema changes:
// foreign keys OFF (outside any transaction, so it takes effect), one
// transaction per file, `PRAGMA foreign_key_check` before and after, ROLLBACK
// on any error. A table rebuild therefore cannot cascade-delete child rows, and
// a failing file never leaves a half-applied schema.
//
// Tracking rows keep the format existing databases already hold:
// hash = sha256(file content), created_at = the journal's `when` millis.
// Legacy rows (hash = filename, created_at = unix seconds) are normalized on sight.

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

const BREAKPOINT = '--> statement-breakpoint';
// Start-anchored, so a `CREATE TRIGGER … BEGIN … END` body passes. A bare `END`
// is SQLite's alias for COMMIT, hence END and not only END TRANSACTION.
const TRANSACTION_CONTROL = /^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
// drizzle-kit wraps table rebuilds in these; the runner owns the FK mode instead.
const FK_PRAGMA = /^PRAGMA\s+foreign_keys\s*=\s*(ON|OFF)\s*;?$/i;

/**
 * @typedef {object} MigrationLog
 * @property {(...args: unknown[]) => void} info - progress messages
 * @property {(...args: unknown[]) => void} warn - degraded-but-continuing events
 */

/**
 * @typedef {object} PendingMigration
 * @property {string} file - SQL file name, e.g. `0001_x.sql`
 * @property {number} when - journal `when` millis (tracking `created_at`)
 * @property {string} hash - sha256 of the file content
 * @property {string[]} statements - original chunk texts to run, in order
 */

/**
 * Strips leading whitespace and leading `--` comment lines, then trims. Used
 * only for the checks below; the original text is what runs.
 * @param {string} stmt - one chunk of a migration file
 * @returns {string} the normalized statement (empty for a comment-only chunk)
 */
function normalizeStatement(stmt) {
  let s = stmt.trimStart();
  while (s.startsWith('--')) {
    const eol = s.indexOf('\n');
    s = eol === -1 ? '' : s.slice(eol + 1).trimStart();
  }
  return s.trim();
}

/**
 * Splits a migration file into the statements to run, dropping empty chunks and
 * `PRAGMA foreign_keys` statements, and rejecting transaction control.
 * @param {string} file - file name, for the error message
 * @param {string} sql - file content
 * @returns {string[]} original statement texts
 */
function planStatements(file, sql) {
  const statements = [];
  for (const chunk of sql.split(BREAKPOINT)) {
    const normalized = normalizeStatement(chunk);
    if (normalized === '' || FK_PRAGMA.test(normalized)) continue;
    const control = normalized.match(TRANSACTION_CONTROL);
    if (control) {
      throw new Error(
        `[migrate] ${file} contains transaction control (${control[1].toUpperCase()}): the runner wraps each migration in its own transaction. Nothing was applied.`,
      );
    }
    statements.push(chunk);
  }
  return statements;
}

/**
 * Current foreign key violations, keyed by `table|rowid|parent|fkid`.
 * @param {import('better-sqlite3').Database} sqlite - open connection
 * @returns {Map<string, string>} violation key → child table name
 */
function fkViolations(sqlite) {
  const rows =
    /** @type {{ table: string, rowid: number | null, parent: string, fkid: number }[]} */ (
      sqlite.pragma('foreign_key_check')
    );
  return new Map(rows.map((v) => [`${v.table}|${v.rowid}|${v.parent}|${v.fkid}`, v.table]));
}

/**
 * Counts table names.
 * @param {Iterable<string>} tables - one entry per violation
 * @returns {Map<string, number>} table → violation count
 */
function countByTable(tables) {
  const counts = new Map();
  for (const table of tables) counts.set(table, (counts.get(table) ?? 0) + 1);
  return counts;
}

/**
 * Reads the journal and returns the pending migrations, after normalizing legacy
 * tracking rows and warning about out-of-order skips.
 * @param {import('better-sqlite3').Database} sqlite - open connection
 * @param {string} migrationsDir - folder holding `meta/_journal.json` and the SQL files
 * @param {MigrationLog} log - logger
 * @returns {{ total: number, pending: { file: string, when: number, hash: string, sql: string }[] }} journal size and pending migrations
 */
function findPending(sqlite, migrationsDir, log) {
  // Same shape drizzle-kit created (SERIAL is a no-op affinity in SQLite)
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
  log.info(`[migrate] Found ${entries.length} migrations in journal`);

  const migrations = entries.map((entry) => {
    const file = `${entry.tag}.sql`;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    return { file, when: entry.when, sql, hash: createHash('sha256').update(sql).digest('hex') };
  });

  // Normalize legacy rows (hash = filename, created_at = unix seconds) to the
  // hash format, so the applied-check below recognizes them.
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
      if (!(e instanceof Error) || !e.message.includes('UNIQUE')) throw e;
      sqlite.prepare('DELETE FROM __drizzle_migrations WHERE hash = ?').run(m.file);
      normalized++;
    }
  }
  if (normalized > 0) {
    log.info(`[migrate] Normalized ${normalized} legacy tracking rows to the hash format`);
  }

  // Applied-check: anything at or before the newest recorded created_at has been
  // applied (the rule drizzle-kit used, so existing tracking rows keep meaning
  // the same thing).
  const { maxCreatedAt } = /** @type {{ maxCreatedAt: number | null }} */ (
    sqlite
      .prepare('SELECT MAX(CAST(created_at AS INTEGER)) AS maxCreatedAt FROM __drizzle_migrations')
      .get()
  );
  const appliedHashes = new Set(
    /** @type {{ hash: string }[]} */ (
      sqlite.prepare('SELECT hash FROM __drizzle_migrations').all()
    ).map((r) => r.hash),
  );

  const pending = migrations.filter((m) => {
    if (maxCreatedAt === null || m.when > maxCreatedAt) return true;
    // Silent skip by timestamp, except for the one case where it hides a real
    // problem (an unapplied migration older than the newest applied one, e.g.
    // after a branch merge reordered journal timestamps).
    if (!appliedHashes.has(m.hash)) {
      log.warn(
        `[migrate] WARNING: ${m.file} skipped by timestamp but its hash is not recorded — it may never have been applied. Verify the schema manually.`,
      );
    }
    return false;
  });
  return { total: migrations.length, pending };
}

/**
 * Applies one migration in its own transaction, rejecting any foreign key
 * violation it introduces. Rolls back and rethrows (naming the file) on error.
 * @param {import('better-sqlite3').Database} sqlite - open connection, foreign keys OFF
 * @param {PendingMigration} m - the migration
 * @returns {void}
 */
function applyOne(sqlite, m) {
  sqlite.exec('BEGIN');
  try {
    const before = fkViolations(sqlite);
    for (const stmt of m.statements) {
      // prepare() rejects a string holding more than one statement, so a chunk
      // cannot hide a second one from the checks in planStatements().
      sqlite.prepare(stmt).run();
      if (!sqlite.inTransaction) throw new Error('a statement ended the migration transaction');
    }
    const introduced = [...fkViolations(sqlite)]
      .filter(([key]) => !before.has(key))
      .map(([, table]) => table);
    if (introduced.length > 0) {
      const summary = [...countByTable(introduced)].map(([t, n]) => `${t} (${n})`).join(', ');
      throw new Error(`introduced foreign key violations: ${summary}`);
    }
    sqlite
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run(m.hash, m.when);
    sqlite.exec('COMMIT');
  } catch (e) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`[migrate] ${m.file} failed and was rolled back: ${reason}`, { cause: e });
  }
}

/**
 * Applies every pending migration in `migrationsDir` to `sqlite`, each one
 * atomically and with foreign keys off (restored to the caller's mode after).
 * All pending files are checked before any of them runs. Pre-existing foreign
 * key violations are logged (`migration_fk_preexisting`), never fixed.
 * @param {import('better-sqlite3').Database} sqlite - open connection, not inside a transaction
 * @param {string} migrationsDir - folder holding `meta/_journal.json` and the SQL files
 * @param {{ log?: MigrationLog }} [options] - `log` defaults to `console`
 * @returns {{ applied: number, skipped: number }} migrations applied by this call, and journal entries skipped as already applied
 */
export function runMigrations(sqlite, migrationsDir, { log = console } = {}) {
  if (sqlite.inTransaction) {
    throw new Error(
      '[migrate] The connection holds an open transaction: foreign keys cannot be turned off. Commit or roll it back first.',
    );
  }
  const originalFk = sqlite.pragma('foreign_keys', { simple: true });
  sqlite.pragma('foreign_keys = OFF');
  try {
    // The PRAGMA is a silent no-op inside a transaction: never run a rebuild
    // with cascades active.
    if (sqlite.pragma('foreign_keys', { simple: true }) !== 0) {
      throw new Error('[migrate] Could not turn foreign keys off; nothing was applied.');
    }

    const { total, pending } = findPending(sqlite, migrationsDir, log);
    // Pre-flight every pending file before running any of them.
    const planned = pending.map((m) => ({ ...m, statements: planStatements(m.file, m.sql) }));

    if (planned.length > 0) {
      // Old orphans warn once per run and never block: a single one would
      // otherwise roll back every future migration (and `prestart` with it).
      for (const [table, count] of countByTable(fkViolations(sqlite).values())) {
        log.warn(
          { event: 'migration_fk_preexisting', table, count },
          `[migrate] ${count} pre-existing foreign key violation(s) in ${table}, left as is`,
        );
      }
    }
    for (const m of planned) {
      log.info(`[migrate] Applying: ${m.file}`);
      applyOne(sqlite, m);
    }
    return { applied: planned.length, skipped: total - planned.length };
  } finally {
    sqlite.pragma(`foreign_keys = ${originalFk ? 'ON' : 'OFF'}`);
  }
}
