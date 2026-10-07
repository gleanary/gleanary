import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { sources, articles } from '@/db/schema';
import { withRoute } from '@/lib/api-error-handler';
import { deriveNewsletterStatus } from '@/types';

/**
 * GET /api/newsletters — List all newsletter sources with article counts and pending count.
 * @param req - NextRequest with optional query param: status (pending|approved|blocked)
 * @returns Array of newsletter sources and pendingCount
 */
export const GET = withRoute('GET /api/newsletters', async (req: NextRequest) => {
  const statusFilter = req.nextUrl.searchParams.get('status');

  const conditions = [eq(sources.type, 'newsletter')];
  if (statusFilter === 'pending') {
    conditions.push(sql`${sources.isBlocked} IS NULL` as ReturnType<typeof eq>);
  } else if (statusFilter === 'approved') {
    conditions.push(eq(sources.isBlocked, false));
  } else if (statusFilter === 'blocked') {
    conditions.push(eq(sources.isBlocked, true));
  }

  const where = sql`${sql.join(conditions, sql` AND `)}`;

  const rows = db
    .select({
      id: sources.id,
      name: sources.name,
      senderAddress: sources.senderAddress,
      isBlocked: sources.isBlocked,
      lastReceivedAt: sources.lastReceivedAt,
      articleCount: sql<number>`COUNT(${articles.id})`,
    })
    .from(sources)
    .leftJoin(articles, eq(sources.id, articles.sourceId))
    .where(where)
    .groupBy(sources.id)
    .all();

  const newsletters = rows.map((row) => ({
    ...row,
    status: deriveNewsletterStatus(row.isBlocked),
  }));

  const pendingCount = newsletters.filter((n) => n.status === 'pending').length;

  return NextResponse.json({
    newsletters,
    pendingCount,
  });
});
