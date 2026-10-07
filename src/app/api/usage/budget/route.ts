import { NextRequest, NextResponse } from 'next/server';
import { getSetting, setSetting } from '@/lib/settings';
import { withRoute } from '@/lib/api-error-handler';
import { updateBudgetSchema } from '@/lib/validators';

/**
 * GET /api/usage/budget — Get the current monthly budget.
 * @returns { budgetUsd: number | null }
 */
export const GET = withRoute('GET /api/usage/budget', async () => {
  const raw = getSetting('monthly_budget_usd');
  const budgetUsd = raw !== null ? parseFloat(raw) : null;
  return NextResponse.json({ budgetUsd });
});

/**
 * PATCH /api/usage/budget — Set or clear the monthly budget.
 * @param req - NextRequest with { budgetUsd: number | null }
 * @returns { budgetUsd: number | null }
 */
export const PATCH = withRoute('PATCH /api/usage/budget', async (req: NextRequest) => {
  const raw = await req.json();
  const { budgetUsd } = updateBudgetSchema.parse(raw);

  if (budgetUsd === null) {
    const { deleteSetting } = await import('@/lib/settings');
    deleteSetting('monthly_budget_usd');
  } else {
    setSetting('monthly_budget_usd', String(budgetUsd));
  }

  return NextResponse.json({ budgetUsd });
});
