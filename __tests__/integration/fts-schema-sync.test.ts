import { describe, it, expect, beforeAll } from 'vitest';
import type Database from 'better-sqlite3';

import { createTestDb } from './setup';
import { initFts, ARTICLES_FTS_COLUMNS } from '@/db/fts';

/**
 * Drift guard for the hand-written FTS5 DDL in src/db/fts.ts.
 *
 * FTS tables and their sync triggers live outside the migration chain (tracked
 * in TECH_DEBT.md — the real fix is a committed migration), so nothing else
 * fails fast if a column referenced there is renamed or dropped in
 * src/db/schema.ts, or if an FTS column is added without updating the sync
 * triggers. This suite pins those invariants against the initFts code path,
 * which is now the single owner of FTS shape (scripts/migrate.mjs no longer
 * carries a duplicate copy — see the migrate-runner drift guard).
 *
 * Adding an FTS table to initFts requires adding its content table to
 * CONTENT_TABLES below — the discovery test fails loudly until it is listed.
 * The suite is read-only, so one shared DB serves every test.
 */

const CONTENT_TABLES = ['articles', 'chat_messages', 'drafts', 'highlights', 'theses'];

let sqlite: Database.Database;

beforeAll(() => {
  ({ sqlite } = createTestDb());
});

function columnNames(table: string): string[] {
  const rows = sqlite.prepare(`pragma table_info(${table})`).all() as { name: string }[];
  return rows.map((row) => row.name);
}

describe('FTS5 schema sync (drift guard)', () => {
  it('covers every FTS table initFts creates, each mapped to its content table by rowid', () => {
    const discovered = sqlite
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE '%fts5%'`)
      .all() as { name: string; sql: string }[];

    expect(discovered.map((t) => t.name).sort()).toEqual(CONTENT_TABLES.map((c) => `${c}_fts`));
    for (const { name, sql } of discovered) {
      expect(sql).toContain(`content='${name.replace(/_fts$/, '')}'`);
      expect(sql).toContain(`content_rowid='id'`);
    }
  });

  it('rebuilds articles_fts when it has ai_index but an otherwise-wrong column set', () => {
    // Fresh full-schema DB (own instance so the shared read-only `sqlite` is untouched).
    const { sqlite: raw } = createTestDb();

    // Replace the healthy articles_fts with a wrong shape that still HAS ai_index
    // (so the old presence-only probe would skip a rebuild) but is missing site_name.
    raw.exec(`
      DROP TABLE IF EXISTS articles_fts;
      DROP TRIGGER IF EXISTS articles_ai;
      DROP TRIGGER IF EXISTS articles_ad;
      DROP TRIGGER IF EXISTS articles_au;
      CREATE VIRTUAL TABLE articles_fts USING fts5(
        title, content_text, ai_index, author,
        content='articles', content_rowid='id'
      );
    `);

    initFts(raw);

    const cols = (raw.prepare(`pragma table_info(articles_fts)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    raw.close();

    expect([...cols].sort()).toEqual([...ARTICLES_FTS_COLUMNS].sort());
  });

  describe.each(CONTENT_TABLES)('%s_fts', (content) => {
    const fts = `${content}_fts`;

    it('indexes only columns that exist on its content table', () => {
      const ftsColumns = columnNames(fts);
      const contentColumns = columnNames(content);

      expect(ftsColumns.length).toBeGreaterThan(0);
      expect(contentColumns).toEqual(expect.arrayContaining(ftsColumns));
    });

    it('has insert, delete, and update sync triggers covering every FTS column', () => {
      const triggers = sqlite
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`)
        .all(content) as { name: string; sql: string }[];
      const byName = new Map(triggers.map((t) => [t.name, t.sql]));

      for (const suffix of ['ai', 'ad', 'au']) {
        const sql = byName.get(`${content}_${suffix}`);
        expect(sql, `${content}_${suffix} trigger missing`).toBeDefined();
        // A column added to the FTS table but forgotten in a trigger body would
        // silently stop syncing into search — assert every column is referenced.
        for (const col of columnNames(fts)) {
          expect(sql, `${content}_${suffix} does not sync column "${col}"`).toMatch(
            new RegExp(`\\b${col}\\b`),
          );
        }
      }
    });
  });
});
