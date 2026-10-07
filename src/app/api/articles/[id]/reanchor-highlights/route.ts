import { JSDOM, VirtualConsole } from 'jsdom';
import { eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/db';
import { highlights } from '@/db/schema';
import { parseIdParam } from '@/lib/validators';
import { withRoute } from '@/lib/api-error-handler';
import { getArticleOrThrow } from '@/lib/db-helpers';
import { logger } from '@/lib/logger';
import {
  isV2Anchor,
  anchorToRange,
  describeRange,
  deserializeRange,
  recoverAnchorFromText,
  type PositionData,
} from '@/lib/highlight-anchoring';
import type { RouteContext } from '@/types';

const virtualConsole = new VirtualConsole();

/**
 * Builds the anchoring root replicating the reader DOM: a wrapper div whose single
 * child is `<div class="article-content">` holding the content HTML. v2 anchors
 * are described against this structure (matching highlight-layer.tsx contentRef).
 */
export function buildRoot(contentHtml: string): Element {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { virtualConsole });
  const doc = dom.window.document;
  const outer = doc.createElement('div');
  const inner = doc.createElement('div');
  inner.className = 'article-content';
  inner.innerHTML = contentHtml;
  outer.appendChild(inner);
  doc.body.appendChild(outer);
  return outer;
}

function patchHighlight(id: number, patch: Partial<typeof highlights.$inferInsert>) {
  db.update(highlights)
    .set({ ...patch, updatedAt: sql`(datetime('now'))` })
    .where(eq(highlights.id, id))
    .run();
}

/**
 * POST /api/articles/[id]/reanchor-highlights — Re-anchor all highlights for an
 * article against its current content_html using jsdom. Idempotent; resets
 * `anchorStatus` to `'anchored'` on any successful resolve. Single-user.
 * @param _req - NextRequest (no body)
 * @param context - Route context with id param
 * @returns { reanchored: number, orphaned: number, unchanged: number }
 */
export const POST = withRoute(
  'POST /api/articles/[id]/reanchor-highlights',
  async (_req: Request, context: RouteContext) => {
    const id = await parseIdParam(context);
    const article = getArticleOrThrow(id);

    if (!article.contentHtml) {
      return NextResponse.json({ reanchored: 0, orphaned: 0, unchanged: 0 });
    }

    const rows = db.select().from(highlights).where(eq(highlights.articleId, id)).all();
    const root = buildRoot(article.contentHtml);

    let reanchored = 0;
    let orphaned = 0;
    let unchanged = 0;

    for (const h of rows) {
      if (!h.positionData) {
        unchanged++;
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(h.positionData);
      } catch {
        unchanged++;
        continue;
      }

      if (isV2Anchor(parsed)) {
        const range = anchorToRange(root, parsed);
        if (!range) {
          orphaned++;
          patchHighlight(h.id, { anchorStatus: 'orphaned' });
          continue;
        }
        const refreshed = describeRange(root, range);
        if (refreshed.start !== parsed.start || refreshed.end !== parsed.end) {
          reanchored++;
          patchHighlight(h.id, {
            positionData: JSON.stringify(refreshed),
            anchorStatus: 'anchored',
          });
        } else {
          if (h.anchorStatus === 'orphaned') {
            reanchored++;
            patchHighlight(h.id, { anchorStatus: 'anchored' });
          } else {
            unchanged++;
          }
        }
      } else {
        // v1 child-index anchor — attempt to reconstruct and upgrade to v2.
        const position = parsed as PositionData;
        const range = deserializeRange(position, root);
        if (range) {
          reanchored++;
          patchHighlight(h.id, {
            positionData: JSON.stringify(describeRange(root, range)),
            anchorStatus: 'anchored',
          });
        } else {
          // v1 path broken — fuzzy-recover from the stored text.
          const anchor = recoverAnchorFromText(root, h.text);
          if (anchor) {
            reanchored++;
            patchHighlight(h.id, {
              positionData: JSON.stringify(anchor),
              anchorStatus: 'anchored',
            });
          } else {
            orphaned++;
            patchHighlight(h.id, { anchorStatus: 'orphaned' });
          }
        }
      }
    }

    logger.info(
      { event: 'highlights_reanchored', articleId: id, reanchored, orphaned, unchanged },
      'Highlights reanchored',
    );

    return NextResponse.json({ reanchored, orphaned, unchanged });
  },
);
