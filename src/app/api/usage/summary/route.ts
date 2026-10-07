import { NextRequest, NextResponse } from 'next/server';
import { computeCost } from '@/lib/pricing';
import { getSetting } from '@/lib/settings';
import { withRoute } from '@/lib/api-error-handler';
import { queryUsageRows } from '@/lib/usage-query';
import { usageSummaryQuerySchema } from '@/lib/validators';

/**
 * GET /api/usage/summary — Aggregated AI spend for the requested time range.
 * @param req - NextRequest with optional ?range= (day|week|month|all, default month)
 * @returns { totalUsd, callCount, budgetUsd, range }
 */
export const GET = withRoute('GET /api/usage/summary', async (req: NextRequest) => {
  const params = Object.fromEntries(req.nextUrl.searchParams);
  const { range } = usageSummaryQuerySchema.parse(params);

  const rows = queryUsageRows(range);

  const totalUsd = rows.reduce((sum, r) => sum + computeCost(r), 0);
  const callCount = rows.length;

  const budgetStr = getSetting('monthly_budget_usd');
  const budgetUsd = budgetStr ? parseFloat(budgetStr) : null;

  return NextResponse.json({ totalUsd, callCount, budgetUsd, range });
});
