import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ARTICLES_FTS_COLUMNS } from '@/db/fts';
import { runMigrations } from '../../scripts/migrate-runner.mjs';
import { silentLog } from './setup';

const ROOT = path.resolve(__dirname, '..', '..');
const MIGRATE = path.join(ROOT, 'scripts', 'migrate.mjs');
const DRIZZLE = path.join(ROOT, 'drizzle');
const JOURNAL = JSON.parse(
  fs.readFileSync(path.join(DRIZZLE, 'meta', '_journal.json'), 'utf-8'),
) as {
  entries: { tag: string; when: number }[];
};

/** Run scripts/migrate.mjs against the given DB file, returning stdout. Throws on non-zero exit. */
function runMigrate(dbPath: string): string {
  return execFileSync(process.execPath, [MIGRATE], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    encoding: 'utf-8',
  });
}

function readSql(tag: string): string {
  return fs.readFileSync(path.join(DRIZZLE, `${tag}.sql`), 'utf-8');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Seed a DB tracked in the hash format (sha256 of the file, journal `when` millis),
 * written by hand in the table shape drizzle-kit created, so the test proves the
 * runner recognizes tracking rows it did not write itself.
 */
function seedHashTrackedDb(dbPath: string): void {
  const sqlite = new Database(dbPath);
  runMigrations(sqlite, DRIZZLE, { log: silentLog });
  sqlite.exec(`
    DROP TABLE __drizzle_migrations;
    CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric);
  `);
  const insert = sqlite.prepare(
    'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
  );
  for (const entry of JOURNAL.entries) insert.run(sha256(readSql(entry.tag)), entry.when);
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

describe('scripts/migrate.mjs CLI and hash-format tracking', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gleanary-migrate-'));
    dbPath = path.join(dir, 'test.db');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('applies all migrations to a fresh DB and records hash-format rows', () => {
    const out = runMigrate(dbPath);
    expect(out).toContain(`Applied ${JOURNAL.entries.length} new migrations`);

    const rows = trackedRows(dbPath);
    expect(rows).toHaveLength(JOURNAL.entries.length);
    // The applied-check is `created_at >= when`; rows must be in journal millis
    const last = rows.at(-1)!;
    const lastEntry = JOURNAL.entries.at(-1)!;
    expect(Number(last.created_at)).toBe(lastEntry.when);
    expect(last.hash).toBe(sha256(readSql(lastEntry.tag)));
  });

  it('is a no-op on a hand-seeded hash-tracked DB (does not re-apply migration 0000)', () => {
    seedHashTrackedDb(dbPath);
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

  it('normalizes legacy filename-tracked rows to the hash format so nothing re-applies', () => {
    seedLegacyFilenameTrackedDb(dbPath);
    const out = runMigrate(dbPath);
    expect(out).toContain('Applied 0 new migrations');

    const rows = trackedRows(dbPath);
    expect(rows).toHaveLength(JOURNAL.entries.length);
    // After normalization every row must be in the hash format:
    // hash = sha256(file content), created_at = journal `when` millis.
    const lastWhen = JOURNAL.entries.at(-1)!.when;
    expect(Math.max(...rows.map((r) => Number(r.created_at)))).toBe(lastWhen);
    const rowHashes = new Set(rows.map((r) => r.hash));
    for (const entry of JOURNAL.entries) {
      expect(rowHashes.has(sha256(readSql(entry.tag)))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// runMigrations on fixture migration folders
// ---------------------------------------------------------------------------

interface FixtureMigration {
  tag: string;
  /** SQL chunks, joined with drizzle's statement breakpoint */
  chunks: string[];
  /** Journal `when`; defaults to a value increasing with the position */
  when?: number;
}

const BASE_WHEN = 1_700_000_000_000;
const BREAKPOINT = '\n--> statement-breakpoint\n';

/** Writes a drizzle-style migrations folder (journal + one SQL file per migration). */
function writeMigrations(dir: string, migrations: FixtureMigration[]): string {
  fs.mkdirSync(path.join(dir, 'meta'), { recursive: true });
  const entries = migrations.map((m, idx) => ({
    idx,
    version: '6',
    when: m.when ?? BASE_WHEN + idx * 1000,
    tag: m.tag,
    breakpoints: true,
  }));
  fs.writeFileSync(
    path.join(dir, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries }),
  );
  for (const m of migrations) {
    fs.writeFileSync(path.join(dir, `${m.tag}.sql`), m.chunks.join(BREAKPOINT));
  }
  return dir;
}

function spyLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

function tableNames(sqlite: Database.Database): string[] {
  return (
    sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

function trackingCount(sqlite: Database.Database): number {
  const exists = tableNames(sqlite).includes('__drizzle_migrations');
  if (!exists) return 0;
  return (sqlite.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number })
    .n;
}

function fkMode(sqlite: Database.Database): number {
  return sqlite.pragma('foreign_keys', { simple: true }) as number;
}

function fkEvents(log: ReturnType<typeof spyLog>, event: string): unknown[] {
  return log.warn.mock.calls
    .map((args) => args[0] as unknown)
    .filter(
      (arg) =>
        typeof arg === 'object' && arg !== null && (arg as { event?: string }).event === event,
    );
}

const PARENT_CHILD: FixtureMigration = {
  tag: '0000_parent_child',
  chunks: [
    'CREATE TABLE `parent` (`id` integer PRIMARY KEY NOT NULL, `name` text NOT NULL);',
    'CREATE TABLE `child` (`id` integer PRIMARY KEY NOT NULL, `parent_id` integer NOT NULL REFERENCES `parent`(`id`) ON DELETE cascade);',
  ],
};

describe('runMigrations', () => {
  let dir: string;
  let sqlite: Database.Database;
  let log: ReturnType<typeof spyLog>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gleanary-runner-'));
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    log = spyLog();
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('cascade safety', () => {
    it('rebuilds a parent table without cascade-deleting its children', () => {
      runMigrations(sqlite, writeMigrations(dir, [PARENT_CHILD]), { log });
      sqlite.exec(`
        INSERT INTO parent (id, name) VALUES (1, 'a'), (2, 'b');
        INSERT INTO child (id, parent_id) VALUES (10, 1), (11, 2);
      `);

      // The table rebuild drizzle-kit emits, including its own FK pragmas
      const rebuild: FixtureMigration = {
        tag: '0001_rebuild_parent',
        chunks: [
          'PRAGMA foreign_keys=OFF;',
          'CREATE TABLE `__new_parent` (`id` integer PRIMARY KEY NOT NULL, `name` text NOT NULL, `extra` text);',
          'INSERT INTO `__new_parent`("id", "name") SELECT "id", "name" FROM `parent`;',
          'DROP TABLE `parent`;',
          'ALTER TABLE `__new_parent` RENAME TO `parent`;',
          'PRAGMA foreign_keys=ON;',
        ],
      };
      const result = runMigrations(sqlite, writeMigrations(dir, [PARENT_CHILD, rebuild]), { log });

      expect(result).toEqual({ applied: 1, skipped: 1 });
      expect(sqlite.prepare('SELECT id FROM child ORDER BY id').all()).toEqual([
        { id: 10 },
        { id: 11 },
      ]);
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);
      expect(fkMode(sqlite)).toBe(1);
      expect(fkEvents(log, 'migration_fk_preexisting')).toEqual([]);
    });
  });

  describe('atomicity', () => {
    it('rolls back a migration failing mid-file and keeps earlier ones of the run', () => {
      const migrations: FixtureMigration[] = [
        { tag: '0000_t', chunks: ['CREATE TABLE `t` (`id` integer PRIMARY KEY NOT NULL);'] },
        { tag: '0001_ok', chunks: ['CREATE TABLE `ok` (`id` integer PRIMARY KEY NOT NULL);'] },
        {
          tag: '0002_broken',
          chunks: [
            'CREATE TABLE `__new_t` (`id` integer PRIMARY KEY NOT NULL, `x` text);',
            'INSERT INTO `__new_t`("id") SELECT "id" FROM `t`;',
            'INSERT INTO `missing_table` VALUES (1);',
            'DROP TABLE `t`;',
            'ALTER TABLE `__new_t` RENAME TO `t`;',
          ],
        },
      ];

      expect(() => runMigrations(sqlite, writeMigrations(dir, migrations), { log })).toThrow(
        /0002_broken\.sql/,
      );

      const tables = tableNames(sqlite);
      expect(tables).toEqual(expect.arrayContaining(['t', 'ok']));
      expect(tables.filter((t) => t.startsWith('__new_'))).toEqual([]);
      expect(trackingCount(sqlite)).toBe(2);
      expect(sqlite.inTransaction).toBe(false);
      expect(fkMode(sqlite)).toBe(1);
    });
  });

  describe('foreign key violations', () => {
    it('applies despite a pre-existing orphan, warns once, and leaves the orphan as is', () => {
      runMigrations(sqlite, writeMigrations(dir, [PARENT_CHILD]), { log });
      sqlite.pragma('foreign_keys = OFF');
      sqlite.exec('INSERT INTO child (id, parent_id) VALUES (20, 99);');
      sqlite.pragma('foreign_keys = ON');

      const migrations = [
        PARENT_CHILD,
        { tag: '0001_extra', chunks: ['CREATE TABLE `extra` (`id` integer PRIMARY KEY);'] },
        { tag: '0002_more', chunks: ['CREATE TABLE `more` (`id` integer PRIMARY KEY);'] },
      ];
      const result = runMigrations(sqlite, writeMigrations(dir, migrations), { log });

      expect(result.applied).toBe(2);
      const events = fkEvents(log, 'migration_fk_preexisting');
      expect(events).toEqual([
        expect.objectContaining({ event: 'migration_fk_preexisting', table: 'child', count: 1 }),
      ]);
      expect(sqlite.prepare('SELECT id FROM child WHERE id = 20').get()).toEqual({ id: 20 });
    });

    it('rolls back a migration that introduces a new orphan', () => {
      runMigrations(sqlite, writeMigrations(dir, [PARENT_CHILD]), { log });

      const orphaning: FixtureMigration = {
        tag: '0001_orphan',
        chunks: ['INSERT INTO `child` (`id`, `parent_id`) VALUES (5, 42);'],
      };
      expect(() =>
        runMigrations(sqlite, writeMigrations(dir, [PARENT_CHILD, orphaning]), { log }),
      ).toThrow(/0001_orphan\.sql[\s\S]*child/);

      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM child').get()).toEqual({ n: 0 });
      expect(trackingCount(sqlite)).toBe(1);
      expect(fkMode(sqlite)).toBe(1);
    });
  });

  describe('statement guard', () => {
    it.each([
      ['BEGIN;'],
      ['-- wrap it in a transaction\nBEGIN TRANSACTION;'],
      ['begin immediate;'],
      ['COMMIT;'],
      ['END TRANSACTION;'],
      ['ROLLBACK;'],
      ['SAVEPOINT sp;'],
      ['  -- release it\n  RELEASE sp;'],
    ])('rejects transaction control %j before applying anything', (statement) => {
      const migrations: FixtureMigration[] = [
        { tag: '0000_first', chunks: ['CREATE TABLE `a` (`id` integer);'] },
        { tag: '0001_tx', chunks: [statement, 'CREATE TABLE `b` (`id` integer);'] },
      ];

      expect(() => runMigrations(sqlite, writeMigrations(dir, migrations), { log })).toThrow(
        /0001_tx\.sql[\s\S]*transaction control/,
      );

      // The pre-flight runs over every pending file, so even 0000 was not applied
      expect(tableNames(sqlite)).not.toContain('a');
      expect(tableNames(sqlite)).not.toContain('b');
      expect(trackingCount(sqlite)).toBe(0);
      expect(fkMode(sqlite)).toBe(1);
    });

    it('accepts a CREATE TRIGGER whose body contains BEGIN … END', () => {
      const migrations: FixtureMigration[] = [
        {
          tag: '0000_trigger',
          chunks: [
            'CREATE TABLE `a` (`id` integer PRIMARY KEY NOT NULL);',
            'CREATE TABLE `a_log` (`id` integer);',
            '-- keep a log of inserts\nCREATE TRIGGER a_ai AFTER INSERT ON a BEGIN\n  INSERT INTO a_log VALUES (new.id);\nEND;',
          ],
        },
      ];

      expect(runMigrations(sqlite, writeMigrations(dir, migrations), { log }).applied).toBe(1);
      sqlite.exec('INSERT INTO a (id) VALUES (7);');
      expect(sqlite.prepare('SELECT id FROM a_log').all()).toEqual([{ id: 7 }]);
    });

    it('drops PRAGMA foreign_keys statements in both spellings, including after a comment', () => {
      const prepare = vi.spyOn(sqlite, 'prepare');
      const migrations: FixtureMigration[] = [
        {
          tag: '0000_pragmas',
          chunks: [
            'PRAGMA foreign_keys=OFF;',
            'CREATE TABLE `a` (`id` integer);',
            '-- turn them back on\npragma foreign_keys = on',
          ],
        },
      ];

      expect(runMigrations(sqlite, writeMigrations(dir, migrations), { log }).applied).toBe(1);

      const prepared = prepare.mock.calls.map(([source]) => String(source));
      expect(prepared.some((s) => s.includes('foreign_keys=OFF'))).toBe(false);
      expect(prepared.some((s) => s.includes('pragma foreign_keys = on'))).toBe(false);
      expect(tableNames(sqlite)).toContain('a');
      expect(fkMode(sqlite)).toBe(1);
    });

    it('rejects a chunk holding two statements, with nothing committed', () => {
      const migrations: FixtureMigration[] = [
        {
          tag: '0000_two',
          chunks: ['CREATE TABLE `a` (`id` integer); CREATE TABLE `b` (`id` integer);'],
        },
      ];

      expect(() => runMigrations(sqlite, writeMigrations(dir, migrations), { log })).toThrow(
        /0000_two\.sql/,
      );
      expect(tableNames(sqlite)).not.toContain('a');
      expect(tableNames(sqlite)).not.toContain('b');
      expect(trackingCount(sqlite)).toBe(0);
    });
  });

  describe('foreign key mode', () => {
    it('throws before running anything when the caller holds an open transaction', () => {
      const migrations: FixtureMigration[] = [
        { tag: '0000_a', chunks: ['CREATE TABLE `a` (`id` integer);'] },
      ];
      sqlite.exec('BEGIN');

      expect(() => runMigrations(sqlite, writeMigrations(dir, migrations), { log })).toThrow(
        /transaction/i,
      );
      sqlite.exec('ROLLBACK');

      expect(tableNames(sqlite)).not.toContain('a');
      expect(fkMode(sqlite)).toBe(1);
    });

    it('leaves a connection opened with foreign_keys OFF in that mode', () => {
      sqlite.pragma('foreign_keys = OFF');
      runMigrations(sqlite, writeMigrations(dir, [PARENT_CHILD]), { log });
      expect(fkMode(sqlite)).toBe(0);
    });
  });

  describe('journal ordering', () => {
    it('warns about an unapplied migration older than the newest applied one', () => {
      const later: FixtureMigration = {
        tag: '0001_later',
        when: BASE_WHEN + 2000,
        chunks: ['CREATE TABLE `later` (`id` integer);'],
      };
      runMigrations(sqlite, writeMigrations(dir, [later]), { log });

      const earlier: FixtureMigration = {
        tag: '0000_earlier',
        when: BASE_WHEN + 1000,
        chunks: ['CREATE TABLE `earlier` (`id` integer);'],
      };
      const result = runMigrations(sqlite, writeMigrations(dir, [earlier, later]), { log });

      expect(result).toEqual({ applied: 0, skipped: 2 });
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('0000_earlier.sql'));
      expect(tableNames(sqlite)).not.toContain('earlier');
    });
  });
});

describe('one migration runner everywhere (parity)', () => {
  // Built by concatenation so this file does not match its own pattern
  const MIGRATOR_IMPORT = 'drizzle-orm/better-sqlite3/' + 'migrator';
  const CODE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;

  function codeFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return codeFiles(full);
      return CODE_FILE.test(entry.name) ? [full] : [];
    });
  }

  it('no file under src/, scripts/ or __tests__/ imports the drizzle migrator', () => {
    const offenders = ['src', 'scripts', '__tests__']
      .flatMap((d) => codeFiles(path.join(ROOT, d)))
      .filter((file) => fs.readFileSync(file, 'utf-8').includes(MIGRATOR_IMPORT))
      .map((file) => path.relative(ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('db:migrate and the session-start hook run scripts/migrate.mjs', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['db:migrate']).toBe('node scripts/migrate.mjs');

    const hook = fs.readFileSync(path.join(ROOT, '.claude', 'hooks', 'session-start.sh'), 'utf-8');
    expect(hook).not.toContain('drizzle-kit ' + 'migrate');
    expect(hook).toContain('node scripts/migrate.mjs');
  });
});
