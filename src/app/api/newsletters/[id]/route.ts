import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { sources, articles } from '@/db/schema';
import { updateNewsletterSchema, parseIdParam } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { getSourceOrThrow } from '@/lib/db-helpers';
import { ValidationError } from '@/lib/errors';
import type { RouteContext } from '@/types';

/**
 * PATCH /api/newsletters/[id] — Approve, block, or unblock a newsletter sender.
 *
 * Side effects:
 * - Approving (isBlocked: false) a pending sender moves their articles from 'pending_review' to 'inbox'.
 * - Blocking (isBlocked: true) a pending sender deletes their pending articles.
 * @param req - NextRequest with JSON body { isBlocked: boolean }
 * @param context - Route context with source ID
 * @returns Updated source record
 */
export const PATCH = withRoute(
  'PATCH /api/newsletters/[id]',
  async (req: NextRequest, context: RouteContext) => {
    const id = await parseIdParam(context);
    const body = updateNewsletterSchema.parse(await req.json());

    const source = getSourceOrThrow(id);

    if (source.type !== 'newsletter') {
      throw new ValidationError(`Source ${id} is not a newsletter source`);
    }

    const wasPending = source.isBlocked === null;

    db.update(sources).set({ isBlocked: body.isBlocked }).where(eq(sources.id, id)).run();

    // Side effects when transitioning from pending
    if (wasPending && body.isBlocked === false) {
      // Approving: move pending_review articles to inbox
      db.update(articles).set({ status: 'inbox' }).where(eq(articles.sourceId, id)).run();

      logger.info(
        { event: 'newsletter_approved', sourceId: id },
        'Newsletter sender approved, pending articles moved to inbox',
      );
    } else if (wasPending && body.isBlocked === true) {
      // Blocking: delete pending articles
      db.delete(articles).where(eq(articles.sourceId, id)).run();

      logger.info(
        { event: 'newsletter_blocked_pending', sourceId: id },
        'Newsletter sender blocked, pending articles deleted',
      );
    } else {
      logger.info(
        { event: 'newsletter_block_updated', sourceId: id, isBlocked: body.isBlocked },
        `Newsletter source ${body.isBlocked ? 'blocked' : 'unblocked'}`,
      );
    }

    const updated = db.select().from(sources).where(eq(sources.id, id)).get()!;

    return NextResponse.json({ source: updated });
  },
);
