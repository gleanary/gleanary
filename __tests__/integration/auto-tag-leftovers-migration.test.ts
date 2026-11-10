import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as schema from '@/db/schema';
import { highlights, highlightTags, tags } from '@/db/schema';
import { runMigrations } from '../../scripts/migrate-runner.mjs';
import { insertRawRow, migrationsBefore, silentLog } from './setup';

const ROOT = path.resolve(__dirname, '..', '..');
const DRIZZLE = path.join(ROOT, 'drizzle');
const MIGRATION = '0023_drop_auto_tag_leftovers';

describe(`migration ${MIGRATION}`, () => {
  let dir: string;
  let sqlite: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gleanary-0023-'));
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deletes unlinked tags named like an article AI tag and keeps the rest', () => {
    const db = drizzle(sqlite, { schema });
    runMigrations(sqlite, migrationsBefore(dir, MIGRATION), { log: silentLog });

    // No web_save singleton exists at this point of the chain: seed a source explicitly
    const sourceId = Number(
      sqlite.prepare(`INSERT INTO sources (type, name) VALUES ('manual', 'Seed')`).run()
        .lastInsertRowid,
    );
    const article = (url: string, title: string, ai_tags: string | null) =>
      insertRawRow(sqlite, 'articles', { source_id: sourceId, url, title, ai_tags });
    const tagged = {
      id: article(
        'https://example.com/tagged',
        'Tagged',
        JSON.stringify(['AI', ' Rust ', 'Kept-Linked']),
      ),
    };
    article('https://example.com/malformed', 'Malformed', 'not json');
    article('https://example.com/untagged', 'Untagged', null);
    const tagIds = Object.fromEntries(
      db
        .insert(tags)
        .values(['ai', 'rust', 'Mine', 'Kept-Linked', 'not json'].map((name) => ({ name })))
        .returning({ id: tags.id, name: tags.name })
        .all()
        .map(({ id, name }) => [name, id]),
    );
    const [highlight] = db
      .insert(highlights)
      .values({ articleId: tagged!.id, text: 'A highlighted passage' })
      .returning({ id: highlights.id })
      .all();
    db.insert(highlightTags)
      .values({ highlightId: highlight!.id, tagId: tagIds['Kept-Linked']! })
      .run();

    sqlite.exec(fs.readFileSync(path.join(DRIZZLE, `${MIGRATION}.sql`), 'utf-8'));

    const remaining = db
      .select({ name: tags.name })
      .from(tags)
      .all()
      .map((t) => t.name)
      .sort();
    // `ai` and `rust` are leftovers (case and whitespace do not matter); `Mine` is no
    // article tag, `Kept-Linked` is used by a highlight, and the malformed value is ignored
    expect(remaining).toEqual(['Kept-Linked', 'Mine', 'not json']);
    expect(db.select().from(highlightTags).all()).toHaveLength(1);
  });
});
