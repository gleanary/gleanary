import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as schema from '@/db/schema';
import { articles, highlights, highlightTags, tags } from '@/db/schema';

const ROOT = path.resolve(__dirname, '..', '..');
const DRIZZLE = path.join(ROOT, 'drizzle');
const MIGRATION = '0023_drop_auto_tag_leftovers';

interface Journal {
  entries: { idx: number; tag: string }[];
}

/**
 * Copies the migrations folder into `dir`, keeping only the journal entries before
 * `tag`, so the real drizzle migrator builds the schema as it was just before it.
 */
function migrationsBefore(dir: string, tag: string): string {
  const journal = JSON.parse(
    fs.readFileSync(path.join(DRIZZLE, 'meta', '_journal.json'), 'utf-8'),
  ) as Journal;
  const cut = journal.entries.findIndex((e) => e.tag === tag);
  expect(cut).toBeGreaterThan(0);
  const entries = journal.entries.slice(0, cut);
  fs.mkdirSync(path.join(dir, 'meta'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries }),
  );
  for (const { tag: t } of entries) {
    fs.copyFileSync(path.join(DRIZZLE, `${t}.sql`), path.join(dir, `${t}.sql`));
  }
  return dir;
}

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
    migrate(db, { migrationsFolder: migrationsBefore(dir, MIGRATION) });

    const [tagged] = db
      .insert(articles)
      .values([
        {
          url: 'https://example.com/tagged',
          title: 'Tagged',
          aiTags: JSON.stringify(['AI', ' Rust ', 'Kept-Linked']),
        },
        { url: 'https://example.com/malformed', title: 'Malformed', aiTags: 'not json' },
        { url: 'https://example.com/untagged', title: 'Untagged', aiTags: null },
      ])
      .returning({ id: articles.id })
      .all();
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
