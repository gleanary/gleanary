import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { runMigrations } from '../../scripts/migrate-runner.mjs';
import { insertRawRow, migrationsBefore, silentLog } from './setup';

const ROOT = path.resolve(__dirname, '..', '..');
const DRIZZLE = path.join(ROOT, 'drizzle');
const MIGRATION = '0025_enrichment_state';

interface ColumnInfo {
  name: string;
  notnull: number;
  dflt_value: string | null;
}

describe(`migration ${MIGRATION}`, () => {
  let dir: string;
  let sqlite: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gleanary-0025-'));
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is additive: no articles rebuild and no touch of the singleton index', () => {
    const sql = fs.readFileSync(path.join(DRIZZLE, `${MIGRATION}.sql`), 'utf-8');
    expect(sql).not.toContain('__new_articles');
    expect(sql).not.toContain('sources_singleton_type_idx');
    expect(sql).toContain('CREATE TABLE `ai_batches`');
  });

  it('adds the enrichment columns with their defaults, the index and the ai_batches table', () => {
    runMigrations(sqlite, DRIZZLE, { log: silentLog });
    const cols = Object.fromEntries(
      (sqlite.prepare('PRAGMA table_info(articles)').all() as ColumnInfo[]).map((c) => [c.name, c]),
    );
    expect(cols.enrich_status).toMatchObject({ notnull: 1, dflt_value: "'none'" });
    expect(cols.enrich_attempts).toMatchObject({ notnull: 1, dflt_value: '0' });
    expect(cols.enriched_at).toMatchObject({ notnull: 0 });
    expect(cols.enrich_truncated).toMatchObject({ notnull: 1, dflt_value: 'false' });
    expect(cols.enrich_batch_id).toMatchObject({ notnull: 0 });

    const indexes = (sqlite.prepare('PRAGMA index_list(articles)').all() as { name: string }[]).map(
      (i) => i.name,
    );
    expect(indexes).toContain('articles_enrich_status_idx');

    const batchCols = (sqlite.prepare('PRAGMA table_info(ai_batches)').all() as ColumnInfo[]).map(
      (c) => c.name,
    );
    expect(batchCols).toEqual([
      'id',
      'anthropic_batch_id',
      'purpose',
      'status',
      'request_count',
      'succeeded_count',
      'errored_count',
      'submitted_at',
      'ended_at',
      'processed_at',
      'error',
    ]);
    const batchIndexes = (
      sqlite.prepare('PRAGMA index_list(ai_batches)').all() as { name: string; unique: number }[]
    ).map((i) => i.name);
    expect(batchIndexes).toContain('ai_batches_status_idx');
    expect(batchIndexes.some((n) => n.includes('anthropic_batch_id'))).toBe(true);
  });

  it('marks legacy rows with a non-blank ai_summary as done and leaves the rest none', () => {
    runMigrations(sqlite, migrationsBefore(dir, MIGRATION), { log: silentLog });
    const sourceId = sqlite
      .prepare("SELECT id FROM sources WHERE type = 'web_save'")
      .pluck()
      .get() as number;
    const article = (
      url: string,
      title: string,
      ai_summary: string | null,
      ai_tags: string | null,
    ) => insertRawRow(sqlite, 'articles', { source_id: sourceId, url, title, ai_summary, ai_tags });
    article('https://example.com/summarized', 'Summarized', 'A summary', null);
    article('https://example.com/blank', 'Blank summary', '   ', '["t"]');
    article('https://example.com/none', 'No summary', null, '["t"]');

    runMigrations(sqlite, DRIZZLE, { log: silentLog });

    const statuses = Object.fromEntries(
      (
        sqlite
          .prepare('SELECT url, enrich_status, enriched_at, enrich_attempts FROM articles')
          .all() as {
          url: string;
          enrich_status: string;
          enriched_at: null;
          enrich_attempts: number;
        }[]
      ).map((r) => [r.url, r]),
    );
    expect(statuses['https://example.com/summarized']).toMatchObject({
      enrich_status: 'done',
      enriched_at: null,
      enrich_attempts: 0,
    });
    expect(statuses['https://example.com/blank']!.enrich_status).toBe('none');
    expect(statuses['https://example.com/none']!.enrich_status).toBe('none');
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
