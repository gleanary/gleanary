import { NextRequest, NextResponse } from 'next/server';
import { estimateCost } from '@/lib/pricing';
import { withRoute } from '@/lib/api-error-handler';
import { MODEL_PRICING } from '@/lib/pricing';
import { usageEstimateQuerySchema } from '@/lib/validators';

/**
 * GET /api/usage/estimate — Pre-flight cost estimate for a planned call.
 * @param req - NextRequest with query params matching usageEstimateQuerySchema
 * @returns CostEstimate { minUsd, maxUsd, estimatedDurationSec }
 */
export const GET = withRoute('GET /api/usage/estimate', async (req: NextRequest) => {
  const params = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = usageEstimateQuerySchema.parse(params);

  const estimate = estimateCost({
    model: parsed.model as keyof typeof MODEL_PRICING,
    maxInputTokens: parsed.maxInputTokens,
    minOutputTokens: parsed.minOutputTokens,
    maxOutputTokens: parsed.maxOutputTokens,
    maxWebSearches: parsed.maxWebSearches,
  });

  return NextResponse.json(estimate);
});
