import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import type Database from 'better-sqlite3';

import { createTestDb } from './setup';
import { initFts, FTS_TRIGGERS } from '@/db/fts';
import { logger } from '@/lib/logger';

/**
 * initFts() trigger self-heal: a table rebuild (or any other gap) drops the FTS
 * sync triggers, so search would silently go stale. initFts recreates missing
 * triggers on every start and rebuilds that table's index, since writes made
 * while a trigger was missing never reached it.
 */

let sqlite: Database.Database;
let warn: MockInstance;

/** Content tables initFts logged a `fts_triggers_restored` event for. */
function restoredTables(): string[] {
  return warn.mock.calls
    .map((args: unknown[]) => args[0] as { event?: string; table?: string } | undefined)
    .filter((arg) => typeof arg === 'object' && arg?.event === 'fts_triggers_restored')
    .map((arg) => arg?.table ?? '');
}

function triggerExists(name: string): boolean {
  return (
    sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(name) !==
    undefined
  );
}

function insertArticle(title: string): number {
  return Number(
    sqlite
      .prepare(
        `INSERT INTO articles (url, title, source_id)
         VALUES (?, ?, (SELECT id FROM sources WHERE type = 'web_save'))`,
      )
      .run(`https://x.test/${title}`, title).lastInsertRowid,
  );
}

function ftsMatch(table: string, query: string): number[] {
  return (
    sqlite.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ?`).all(query) as {
      rowid: number;
    }[]
  ).map((r) => r.rowid);
}

beforeEach(() => {
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  ({ sqlite } = createTestDb());
});

afterEach(() => {
  sqlite.close();
  warn.mockRestore();
});

describe('initFts trigger self-heal', () => {
  it('logs nothing on a fresh DB or a healthy restart', () => {
    initFts(sqlite);
    expect(restoredTables()).toEqual([]);
  });

  it('restores a dropped articles trigger and reindexes writes made without it', () => {
    const id = insertArticle('Quillfeather');
    sqlite.exec('DROP TRIGGER articles_au');
    sqlite.prepare('UPDATE articles SET title = ? WHERE id = ?').run('Zanzibarquux', id);
    expect(ftsMatch('articles_fts', 'Zanzibarquux')).toEqual([]);

    initFts(sqlite);

    expect(triggerExists('articles_au')).toBe(true);
    expect(ftsMatch('articles_fts', 'Zanzibarquux')).toEqual([id]);
    expect(ftsMatch('articles_fts', 'Quillfeather')).toEqual([]);
    expect(restoredTables()).toEqual(['articles']);
  });

  it('restores a dropped highlights trigger and reindexes writes made without it', () => {
    const articleId = insertArticle('Host');
    sqlite.exec('DROP TRIGGER highlights_ai');
    const highlightId = Number(
      sqlite
        .prepare('INSERT INTO highlights (article_id, text) VALUES (?, ?)')
        .run(articleId, 'Marmalade lighthouse').lastInsertRowid,
    );
    expect(ftsMatch('highlights_fts', 'lighthouse')).toEqual([]);

    initFts(sqlite);

    expect(triggerExists('highlights_ai')).toBe(true);
    expect(ftsMatch('highlights_fts', 'lighthouse')).toEqual([highlightId]);
    expect(restoredTables()).toEqual(['highlights']);
  });

  it('does not log a restore when the drift branch rebuilt articles_fts itself', () => {
    const id = insertArticle('Driftwood');
    sqlite.exec(`
      DROP TABLE articles_fts;
      DROP TRIGGER articles_ai;
      DROP TRIGGER articles_ad;
      DROP TRIGGER articles_au;
    `);

    initFts(sqlite);

    for (const name of FTS_TRIGGERS.articles) expect(triggerExists(name)).toBe(true);
    expect(ftsMatch('articles_fts', 'Driftwood')).toEqual([id]);
    expect(restoredTables()).toEqual([]);
  });
});

describe('FTS_TRIGGERS', () => {
  it('lists exactly the sync triggers initFts creates, per content table', () => {
    const rows = sqlite
      .prepare(`SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger'`)
      .all() as { name: string; tbl_name: string }[];
    const actual: Record<string, string[]> = {};
    for (const { name, tbl_name } of rows) (actual[tbl_name] ??= []).push(name);

    const expected = Object.fromEntries(
      Object.entries(FTS_TRIGGERS).map(([table, names]) => [table, [...names].sort()]),
    );
    const sorted = Object.fromEntries(
      Object.entries(actual).map(([table, names]) => [table, names.sort()]),
    );
    expect(sorted).toEqual(expected);
  });
});
