import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

import { createTestDb } from './setup';

/**
 * Guards the data-layer constraints/indexes added in migration 0021:
 * a UNIQUE index on highlight_tags(highlight_id, tag_id) and a set of
 * hot-path secondary indexes. createTestDb() runs the real drizzle/ migration
 * chain, so this suite exercises the generated 0021 SQL directly.
 */

let sqlite: Database.Database;

beforeEach(() => {
  ({ sqlite } = createTestDb());
});

/** Seed one article + highlight + tag and return their ids. */
function seedArticleAndTag(): { articleId: number; tagId: number; highlightId: number } {
  const articleId = Number(
    sqlite.prepare(`INSERT INTO articles (url, title) VALUES ('https://x.test/a', 'A')`).run()
      .lastInsertRowid,
  );
  const highlightId = Number(
    sqlite.prepare(`INSERT INTO highlights (article_id, text) VALUES (?, 'hl')`).run(articleId)
      .lastInsertRowid,
  );
  const tagId = Number(
    sqlite.prepare(`INSERT INTO tags (name) VALUES ('t')`).run().lastInsertRowid,
  );
  return { articleId, tagId, highlightId };
}

function indexNames(table: string): string[] {
  return (sqlite.prepare(`pragma index_list(${table})`).all() as { name: string }[]).map(
    (r) => r.name,
  );
}

describe('schema constraints & indexes (migration 0021)', () => {
  it('rejects a duplicate (highlight_id, tag_id) pair with a UNIQUE constraint', () => {
    const { tagId, highlightId } = seedArticleAndTag();
    const insert = sqlite.prepare(
      `INSERT INTO highlight_tags (highlight_id, tag_id) VALUES (?, ?)`,
    );
    insert.run(highlightId, tagId);
    expect(() => insert.run(highlightId, tagId)).toThrow(/UNIQUE/i);
  });

  it('creates the hot-path indexes on their tables', () => {
    const expected: Record<string, string> = {
      highlight_tags: 'highlight_tags_unique',
      articles: 'articles_status_idx',
      highlights: 'highlights_article_idx',
      chat_messages: 'chat_messages_session_idx',
      voice_samples: 'voice_samples_profile_idx',
      thesis_research: 'thesis_research_thesis_idx',
    };
    for (const [table, idx] of Object.entries(expected)) {
      expect(indexNames(table), `${idx} missing on ${table}`).toContain(idx);
    }
  });
});
