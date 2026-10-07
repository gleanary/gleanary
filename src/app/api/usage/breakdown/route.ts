import { NextRequest, NextResponse } from 'next/server';
import { computeCost } from '@/lib/pricing';
import { withRoute } from '@/lib/api-error-handler';
import { queryUsageRows } from '@/lib/usage-query';
import { usageBreakdownQuerySchema } from '@/lib/validators';

/**
 * GET /api/usage/breakdown — AI spend grouped by feature or model.
 * @param req - NextRequest with optional ?range= and ?groupBy=
 * @returns { breakdown: Array<{ key, totalUsd, callCount }> }
 */
export const GET = withRoute('GET /api/usage/breakdown', async (req: NextRequest) => {
  const params = Object.fromEntries(req.nextUrl.searchParams);
  const { range, groupBy } = usageBreakdownQuerySchema.parse(params);

  const rows = queryUsageRows(range);

  const grouped = new Map<string, { totalUsd: number; callCount: number }>();
  for (const row of rows) {
    const key = groupBy === 'feature' ? row.feature : row.model;
    const existing = grouped.get(key) ?? { totalUsd: 0, callCount: 0 };
    existing.totalUsd += computeCost(row);
    existing.callCount += 1;
    grouped.set(key, existing);
  }

  const breakdown = Array.from(grouped.entries())
    .map(([key, stats]) => ({ key, ...stats }))
    .sort((a, b) => b.totalUsd - a.totalUsd);

  return NextResponse.json({ breakdown });
});
