/**
 * Backfill highlight anchors from the legacy v1 child-index model to the v2 text-quote
 * model (position_data v2). See docs/modules/highlight-anchoring.md §9.
 *
 * For each highlight (grouped by article, parsed into jsdom):
 *   1. Already v2 → skip.
 *   2. v1 → reconstruct the Range via the legacy path, then describe it as a v2 anchor.
 *   3. v1 path broken (or no position data) → fuzzy-recover from the stored `text` alone.
 *   4. Unrecoverable → flag anchor_status = 'orphaned' (highlight kept, not rendered).
 *
 * IMPORTANT — operational ordering: once rows are upgraded to v2 the current reader can no
 * longer render them. Do NOT run this against production until the dual v1/v2 resolve reader
 * (Session 2) is deployed. Building the script (this file) is safe; running it is gated.
 *
 * Run with: npx tsx scripts/backfill-highlight-anchors.ts
 */

import Database from 'better-sqlite3';
import { JSDOM } from 'jsdom';
import {
  deserializeRange,
  describeRange,
  recoverAnchorFromText,
  isV2Anchor,
  type PositionData,
} from '@/lib/highlight-anchoring';
import type { TextQuoteAnchor } from '@/types';

/** Outcome counts for one backfill pass. */
export interface BackfillSummary {
  /** Total highlights examined. */
  scanned: number;
  /** Already v2 — left untouched. */
  skipped: number;
  /** v1 path reconstructed and described as v2. */
  upgraded: number;
  /** v1 path failed but the text was fuzzy-recovered into a v2 anchor. */
  recovered: number;
  /** Neither path nor text resolved — flagged orphaned. */
  orphaned: number;
}

interface HighlightRow {
  id: number;
  text: string;
  position_data: string | null;
  content_html: string | null;
}

/**
 * Builds the anchoring root replicating the reader DOM exactly: the highlight-layer wrapper
 * div whose single child is `<div class="article-content">` holding the content. v1 paths
 * were serialized against this structure (see src/components/reader/highlight-layer.tsx and
 * article-content.tsx), so it must be reproduced or every v1 path would be off by one level.
 */
function buildRoot(contentHtml: string): Element {
  const dom = new JSDOM('<!DOCTYPE html><body></body>');
  const doc = dom.window.document;
  const root = doc.createElement('div');
  const content = doc.createElement('div');
  content.className = 'article-content';
  content.innerHTML = contentHtml;
  root.appendChild(content);
  doc.body.appendChild(root);
  return root;
}

/** A parsed position_data payload is a legacy v1 anchor when it carries a child-index path. */
function isV1Anchor(parsed: unknown): parsed is PositionData {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    Array.isArray((parsed as { startContainerPath?: unknown }).startContainerPath)
  );
}

/**
 * Upgrades all v1 highlight anchors in the database to v2 in place. Idempotent — re-running
 * skips rows already on v2.
 * @param db - An open better-sqlite3 connection
 * @returns Outcome counts for the pass
 */
export function runBackfill(db: Database.Database): BackfillSummary {
  const summary: BackfillSummary = {
    scanned: 0,
    skipped: 0,
    upgraded: 0,
    recovered: 0,
    orphaned: 0,
  };

  const rows = db
    .prepare(
      `SELECT h.id AS id, h.text AS text, h.position_data AS position_data,
              a.content_html AS content_html
       FROM highlights h
       JOIN articles a ON h.article_id = a.id
       ORDER BY a.id`,
    )
    .all() as HighlightRow[];

  const setAnchored = db.prepare(
    `UPDATE highlights
       SET position_data = ?, anchor_status = 'anchored', updated_at = datetime('now')
     WHERE id = ?`,
  );
  const setOrphaned = db.prepare(
    `UPDATE highlights
       SET anchor_status = 'orphaned', updated_at = datetime('now')
     WHERE id = ?`,
  );

  // Reuse one jsdom root per article (rows are ordered by article id). The root is never
  // mutated by the anchoring functions, so reuse is safe.
  let cachedHtml: string | null = null;
  let cachedRoot: Element | null = null;

  const apply = db.transaction(() => {
    for (const row of rows) {
      summary.scanned++;

      let parsed: unknown = null;
      if (row.position_data) {
        try {
          parsed = JSON.parse(row.position_data);
        } catch {
          parsed = null;
        }
      }

      if (isV2Anchor(parsed)) {
        summary.skipped++;
        continue;
      }

      const contentHtml = row.content_html ?? '';
      if (cachedRoot === null || contentHtml !== cachedHtml) {
        cachedRoot = buildRoot(contentHtml);
        cachedHtml = contentHtml;
      }
      const root = cachedRoot;

      let anchor: TextQuoteAnchor | null = null;
      let viaPath = false;

      if (isV1Anchor(parsed)) {
        const range = deserializeRange(parsed, root);
        if (range) {
          anchor = describeRange(root, range);
          viaPath = true;
        }
      }

      if (!anchor) {
        anchor = recoverAnchorFromText(root, row.text);
      }

      if (anchor) {
        setAnchored.run(JSON.stringify(anchor), row.id);
        if (viaPath) summary.upgraded++;
        else summary.recovered++;
      } else {
        setOrphaned.run(row.id);
        summary.orphaned++;
      }
    }
  });

  apply();
  return summary;
}

/** Opens the configured database, runs the backfill, and reports the summary. */
function main(): void {
  const dbPath = (process.env.DATABASE_URL ?? 'file:./data/gleanary.db').replace('file:', '');
  const db = new Database(dbPath);
  try {
    const summary = runBackfill(db);
    console.log('Highlight anchor backfill complete:', summary);
  } finally {
    db.close();
  }
}

// Run only when invoked directly (e.g. `npx tsx scripts/backfill-highlight-anchors.ts`),
// not when imported by tests. Uses argv rather than `require`/`module` so it is safe under
// both the tsx (CommonJS) runtime and the vitest (ESM) import.
if (process.argv[1] && /backfill-highlight-anchors\.(?:ts|js)$/.test(process.argv[1])) {
  main();
}
