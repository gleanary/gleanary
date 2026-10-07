import { NextRequest, NextResponse } from 'next/server';
import { desc } from 'drizzle-orm';
import { db } from '@/db';
import { aiUsage } from '@/db/schema';
import { computeCost } from '@/lib/pricing';
import { withRoute } from '@/lib/api-error-handler';
import { rangeToSqlFilter } from '@/lib/usage-query';
import { usageTopCallsQuerySchema } from '@/lib/validators';

/**
 * GET /api/usage/top-calls — Most expensive individual AI calls.
 * @param req - NextRequest with optional ?range= and ?limit= (1-50, default 20)
 * @returns { calls: Array<AiUsage & { costUsd }> }
 */
export const GET = withRoute('GET /api/usage/top-calls', async (req: NextRequest) => {
  const params = Object.fromEntries(req.nextUrl.searchParams);
  const { range, limit } = usageTopCallsQuerySchema.parse(params);

  const filter = rangeToSqlFilter(range);
  const query = filter
    ? db.select().from(aiUsage).where(filter).orderBy(desc(aiUsage.inputTokens))
    : db.select().from(aiUsage).orderBy(desc(aiUsage.inputTokens));

  const rows = query.limit(limit).all();
  const calls = rows.map((r) => ({ ...r, costUsd: computeCost(r) }));

  return NextResponse.json({ calls });
});
