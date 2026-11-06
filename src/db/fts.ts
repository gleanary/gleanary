import type Database from 'better-sqlite3';
import { logger } from '@/lib/logger';

/** Expected articles_fts column shape (excludes the FTS5-internal `rowid`). */
export const ARTICLES_FTS_COLUMNS = ['title', 'content_text', 'ai_index', 'author', 'site_name'];

/** Content tables with an FTS5 index (`<table>_fts`) kept in sync by triggers. */
type FtsContentTable = 'articles' | 'highlights' | 'theses' | 'chat_messages' | 'drafts';

/** Sync trigger names initFts() creates, per content table (insert, delete, update). */
export const FTS_TRIGGERS: Record<FtsContentTable, string[]> = {
  articles: ['articles_ai', 'articles_ad', 'articles_au'],
  highlights: ['highlights_ai', 'highlights_ad', 'highlights_au'],
  theses: ['theses_ai', 'theses_ad', 'theses_au'],
  chat_messages: ['chat_messages_ai', 'chat_messages_ad', 'chat_messages_au'],
  drafts: ['drafts_ai', 'drafts_ad', 'drafts_au'],
};

/**
 * Content tables whose `_fts` table exists but which miss at least one sync
 * trigger: their index may have missed writes and needs a rebuild once the
 * triggers are back. A table whose `_fts` does not exist yet is left out
 * (first-time creation, nothing to catch up on).
 * @param sqlite - Raw better-sqlite3 database instance
 * @returns Content tables to reindex
 */
function tablesMissingTriggers(sqlite: Database.Database): FtsContentTable[] {
  const rows = sqlite
    .prepare(`SELECT type, name FROM sqlite_master WHERE type IN ('table', 'trigger')`)
    .all() as { type: string; name: string }[];
  const names = new Set(rows.map((r) => `${r.type}:${r.name}`));
  return (Object.keys(FTS_TRIGGERS) as FtsContentTable[]).filter(
    (table) =>
      names.has(`table:${table}_fts`) &&
      FTS_TRIGGERS[table].some((trigger) => !names.has(`trigger:${trigger}`)),
  );
}

/**
 * Initializes FTS5 virtual tables and sync triggers for full-text search.
 * Must be called after the database schema is set up (migrations applied).
 * Safe to call multiple times (uses IF NOT EXISTS for tables that don't need migration).
 *
 * For articles_fts, compares the actual column set against the expected shape
 * and rebuilds the table and its sync triggers whenever they differ (handles the
 * v2 ai_index migration and any other column drift automatically).
 *
 * Self-heal: every sync trigger is created with IF NOT EXISTS on every call. A
 * table rebuild drops its triggers, so when one was missing the table's index
 * is rebuilt from the content table and `fts_triggers_restored` is logged.
 * @param sqlite - Raw better-sqlite3 database instance
 */
export function initFts(sqlite: Database.Database): void {
  const missingTriggers = tablesMissingTriggers(sqlite);

  // Detect whether articles_fts needs to be rebuilt to the expected column shape.
  // FTS5 doesn't support ALTER TABLE, so we drop and recreate on any drift.
  const ftsColumns = sqlite.prepare('pragma table_info(articles_fts)').all() as { name: string }[];
  const actual = new Set(ftsColumns.map((col) => col.name));
  const needsRebuild =
    ftsColumns.length === 0 ||
    actual.size !== ARTICLES_FTS_COLUMNS.length ||
    !ARTICLES_FTS_COLUMNS.every((col) => actual.has(col));

  if (needsRebuild) {
    sqlite.exec(`
      DROP TABLE IF EXISTS articles_fts;
      DROP TRIGGER IF EXISTS articles_ai;
      DROP TRIGGER IF EXISTS articles_ad;
      DROP TRIGGER IF EXISTS articles_au;

      CREATE VIRTUAL TABLE articles_fts USING fts5(
        title, content_text, ai_index, author, site_name,
        content='articles', content_rowid='id'
      );

      INSERT INTO articles_fts(rowid, title, content_text, ai_index, author, site_name)
        SELECT id, title, content_text, ai_index, author, site_name FROM articles;
    `);
  }

  // The drift branch above drops the articles triggers with their table; they are
  // (re)created here so a rebuild that dropped them alone heals too.
  sqlite.exec(`
    -- Articles FTS sync triggers
    CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
      INSERT INTO articles_fts(rowid, title, content_text, ai_index, author, site_name)
      VALUES (new.id, new.title, new.content_text, new.ai_index, new.author, new.site_name);
    END;

    CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
      INSERT INTO articles_fts(articles_fts, rowid, title, content_text, ai_index, author, site_name)
      VALUES ('delete', old.id, old.title, old.content_text, old.ai_index, old.author, old.site_name);
    END;

    CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE ON articles BEGIN
      INSERT INTO articles_fts(articles_fts, rowid, title, content_text, ai_index, author, site_name)
      VALUES ('delete', old.id, old.title, old.content_text, old.ai_index, old.author, old.site_name);
      INSERT INTO articles_fts(rowid, title, content_text, ai_index, author, site_name)
      VALUES (new.id, new.title, new.content_text, new.ai_index, new.author, new.site_name);
    END;

    -- Highlights full-text search
    CREATE VIRTUAL TABLE IF NOT EXISTS highlights_fts USING fts5(
      text, note,
      content='highlights', content_rowid='id'
    );

    -- Highlights FTS sync triggers
    CREATE TRIGGER IF NOT EXISTS highlights_ai AFTER INSERT ON highlights BEGIN
      INSERT INTO highlights_fts(rowid, text, note)
      VALUES (new.id, new.text, new.note);
    END;

    CREATE TRIGGER IF NOT EXISTS highlights_ad AFTER DELETE ON highlights BEGIN
      INSERT INTO highlights_fts(highlights_fts, rowid, text, note)
      VALUES ('delete', old.id, old.text, old.note);
    END;

    CREATE TRIGGER IF NOT EXISTS highlights_au AFTER UPDATE ON highlights BEGIN
      INSERT INTO highlights_fts(highlights_fts, rowid, text, note)
      VALUES ('delete', old.id, old.text, old.note);
      INSERT INTO highlights_fts(rowid, text, note)
      VALUES (new.id, new.text, new.note);
    END;

    -- Theses full-text search
    CREATE VIRTUAL TABLE IF NOT EXISTS theses_fts USING fts5(
      title, claim, counterarguments, implications, notes,
      content='theses', content_rowid='id'
    );

    -- Theses FTS sync triggers
    CREATE TRIGGER IF NOT EXISTS theses_ai AFTER INSERT ON theses BEGIN
      INSERT INTO theses_fts(rowid, title, claim, counterarguments, implications, notes)
      VALUES (new.id, new.title, new.claim, new.counterarguments, new.implications, new.notes);
    END;

    CREATE TRIGGER IF NOT EXISTS theses_ad AFTER DELETE ON theses BEGIN
      INSERT INTO theses_fts(theses_fts, rowid, title, claim, counterarguments, implications, notes)
      VALUES ('delete', old.id, old.title, old.claim, old.counterarguments, old.implications, old.notes);
    END;

    CREATE TRIGGER IF NOT EXISTS theses_au AFTER UPDATE ON theses BEGIN
      INSERT INTO theses_fts(theses_fts, rowid, title, claim, counterarguments, implications, notes)
      VALUES ('delete', old.id, old.title, old.claim, old.counterarguments, old.implications, old.notes);
      INSERT INTO theses_fts(rowid, title, claim, counterarguments, implications, notes)
      VALUES (new.id, new.title, new.claim, new.counterarguments, new.implications, new.notes);
    END;

    -- Chat messages full-text search
    CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
      content,
      content='chat_messages', content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS chat_messages_ai AFTER INSERT ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(rowid, content)
      VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS chat_messages_ad AFTER DELETE ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content)
      VALUES ('delete', old.id, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS chat_messages_au AFTER UPDATE ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content)
      VALUES ('delete', old.id, old.content);
      INSERT INTO chat_messages_fts(rowid, content)
      VALUES (new.id, new.content);
    END;
  `);

  // Drafts full-text search (title + content — drafts are the largest documents in the system)
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS drafts_fts USING fts5(
      title, content,
      content='drafts', content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS drafts_ai AFTER INSERT ON drafts BEGIN
      INSERT INTO drafts_fts(rowid, title, content)
      VALUES (new.id, new.title, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS drafts_ad AFTER DELETE ON drafts BEGIN
      INSERT INTO drafts_fts(drafts_fts, rowid, title, content)
      VALUES ('delete', old.id, old.title, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS drafts_au AFTER UPDATE ON drafts BEGIN
      INSERT INTO drafts_fts(drafts_fts, rowid, title, content)
      VALUES ('delete', old.id, old.title, old.content);
      INSERT INTO drafts_fts(rowid, title, content)
      VALUES (new.id, new.title, new.content);
    END;
  `);

  // Unconditional rebuild on every startup to guarantee FTS is in sync with the drafts table.
  // Deliberate: gating on table-creation adds complexity; at single-user N this takes
  // milliseconds and is safer than a one-time-only path that could be skipped on restore/import.
  sqlite.exec(`INSERT INTO drafts_fts(drafts_fts) VALUES('rebuild');`);

  // Writes made while a trigger was missing never reached the index. The drift
  // branch already repopulated articles_fts from scratch.
  for (const table of missingTriggers) {
    if (table === 'articles' && needsRebuild) continue;
    // `table` comes from FTS_TRIGGERS, never from input
    sqlite.exec(`INSERT INTO ${table}_fts(${table}_fts) VALUES('rebuild');`);
    logger.warn(
      { event: 'fts_triggers_restored', table },
      'FTS sync triggers were missing; restored them and rebuilt the index',
    );
  }
}
