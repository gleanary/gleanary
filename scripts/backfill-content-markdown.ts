/**
 * Backfill content_markdown for existing articles.
 * Converts content_html → markdown via turndown for all articles
 * where content_markdown IS NULL AND content_html IS NOT NULL.
 *
 * Run with: npx tsx scripts/backfill-content-markdown.ts
 */

import Database from 'better-sqlite3';
import { convertHtmlToMarkdown } from '@/lib/html-to-markdown';

const DB_PATH = (process.env.DATABASE_URL ?? 'file:./reader.db').replace('file:', '');
const BATCH_SIZE = 50;

const db = new Database(DB_PATH);

interface ArticleRow {
  id: number;
  content_html: string;
}

const countRow = db
  .prepare(
    `SELECT COUNT(*) as count FROM articles WHERE content_markdown IS NULL AND content_html IS NOT NULL`,
  )
  .get() as { count: number };

const total = countRow.count;
console.log(`Found ${total} articles to backfill.`);

if (total === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}

const updateStmt = db.prepare(`UPDATE articles SET content_markdown = ? WHERE id = ?`);

let processed = 0;
let errors = 0;

while (processed < total) {
  const batch = db
    .prepare(
      `SELECT id, content_html FROM articles
       WHERE content_markdown IS NULL AND content_html IS NOT NULL
       LIMIT ${BATCH_SIZE}`,
    )
    .all() as ArticleRow[];

  if (batch.length === 0) break;

  const runBatch = db.transaction(() => {
    for (const row of batch) {
      try {
        const markdown = convertHtmlToMarkdown(row.content_html);
        updateStmt.run(markdown, row.id);
        processed++;
      } catch (err) {
        console.error(`Error converting article ${row.id}:`, err);
        // Leave content_markdown NULL so this row can be retried on next run
        errors++;
      }
    }
  });

  runBatch();
  console.log(`Progress: ${processed}/${total}`);
}

console.log(`Done. Processed: ${processed}, Errors: ${errors}.`);
db.close();
