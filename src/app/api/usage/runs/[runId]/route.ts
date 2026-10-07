import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { aiUsage } from '@/db/schema';
import { computeCost } from '@/lib/pricing';
import { withRoute } from '@/lib/api-error-handler';
import { NotFoundError } from '@/lib/errors';

/**
 * GET /api/usage/runs/[runId] — All calls for a specific run (multi-call operations).
 * @param _req - NextRequest (unused)
 * @param context - Route context with runId param
 * @returns { calls: Array<AiUsage & { costUsd }>, totalUsd }
 */
export const GET = withRoute(
  'GET /api/usage/runs/[runId]',
  async (_req: NextRequest, context: { params: Promise<{ runId: string }> }) => {
    const { runId } = await context.params;
    if (!runId) throw new NotFoundError('Run', runId);

    const rows = db.select().from(aiUsage).where(eq(aiUsage.runId, runId)).all();
    if (rows.length === 0) throw new NotFoundError('Run', runId);

    const calls = rows.map((r) => ({ ...r, costUsd: computeCost(r) }));
    const totalUsd = calls.reduce((sum, c) => sum + c.costUsd, 0);

    return NextResponse.json({ calls, totalUsd });
  },
);
