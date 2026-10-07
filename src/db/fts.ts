import type Database from 'better-sqlite3';

/** Expected articles_fts column shape (excludes the FTS5-internal `rowid`). */
export const ARTICLES_FTS_COLUMNS = ['title', 'content_text', 'ai_index', 'author', 'site_name'];

/**
 * Initializes FTS5 virtual tables and sync triggers for full-text search.
 * Must be called after the database schema is set up (migrations applied).
 * Safe to call multiple times (uses IF NOT EXISTS for tables that don't need migration).
 *
 * For articles_fts, compares the actual column set against the expected shape
 * and rebuilds the table and its sync triggers whenever they differ (handles the
 * v2 ai_index migration and any other column drift automatically).
 * @param sqlite - Raw better-sqlite3 database instance
 */
export function initFts(sqlite: Database.Database): void {
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

      CREATE TRIGGER articles_ai AFTER INSERT ON articles BEGIN
        INSERT INTO articles_fts(rowid, title, content_text, ai_index, author, site_name)
        VALUES (new.id, new.title, new.content_text, new.ai_index, new.author, new.site_name);
      END;

      CREATE TRIGGER articles_ad AFTER DELETE ON articles BEGIN
        INSERT INTO articles_fts(articles_fts, rowid, title, content_text, ai_index, author, site_name)
        VALUES ('delete', old.id, old.title, old.content_text, old.ai_index, old.author, old.site_name);
      END;

      CREATE TRIGGER articles_au AFTER UPDATE ON articles BEGIN
        INSERT INTO articles_fts(articles_fts, rowid, title, content_text, ai_index, author, site_name)
        VALUES ('delete', old.id, old.title, old.content_text, old.ai_index, old.author, old.site_name);
        INSERT INTO articles_fts(rowid, title, content_text, ai_index, author, site_name)
        VALUES (new.id, new.title, new.content_text, new.ai_index, new.author, new.site_name);
      END;
    `);
  }

  sqlite.exec(`
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
}
