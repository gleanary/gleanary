import { logger } from '@/lib/logger';
import { CLAUDE_PRICING, type ClaudeModelId } from '@/lib/models';

// Claude model pricing is maintained in src/lib/models.ts (ALL_CLAUDE_MODELS).
// Add new Claude models there — this file derives the Claude rate card automatically.
// Non-Claude providers (Mistral, etc.) are listed here directly.
const NON_CLAUDE_PRICING = {
  // Ministral 3 8B (v25.12) — no prompt caching on Mistral platform
  'ministral-8b-2512': { input: 0.15, output: 0.15, cacheRead: 0, cacheWrite: 0 },
} as const;

type NonClaudeModelId = keyof typeof NON_CLAUDE_PRICING;

export type ModelId = ClaudeModelId | NonClaudeModelId;

export const MODEL_PRICING: Record<
  ModelId,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  ...CLAUDE_PRICING,
  ...NON_CLAUDE_PRICING,
};

/** $10 per 1,000 web searches = $0.01 per search */
export const WEB_SEARCH_COST_USD = 0.01;

/** Per-page pricing for OCR/document-processing providers. Rate in USD per page. */
export const PAGE_BASED_PRICING: Record<string, { perPageUsd: number }> = {
  // Source: https://mistral.ai/technology/#pricing — Standard OCR
  'mistral-ocr-latest': { perPageUsd: 0.002 }, // historical rows pre-OCR-4 (alias, rate drifted)
  'mistral-ocr-4-0': { perPageUsd: 0.004 }, // pinned Jun 2026; price doubled from OCR 3
};

export interface UsageRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearchCount: number;
  /** Pages processed — set for page-based models (e.g. Mistral OCR); null for token-based models. */
  pagesProcessed?: number | null;
}

export interface CostEstimate {
  minUsd: number;
  maxUsd: number;
  estimatedDurationSec: { min: number; max: number };
}

/** Strip 8-digit date snapshot suffix: claude-haiku-4-5-20251001 → claude-haiku-4-5 */
function normalizeModelId(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

/**
 * Compute cost in USD for a single usage row.
 * Handles both token-based (Claude) and page-based (Mistral OCR) models.
 * Returns 0 and logs a warning if model is unknown.
 * @param row - Usage row with token counts, page count, and model ID
 * @returns Cost in USD
 */
export function computeCost(row: UsageRow): number {
  const pagePricing = PAGE_BASED_PRICING[row.model];
  if (pagePricing) {
    return (row.pagesProcessed ?? 0) * pagePricing.perPageUsd;
  }

  const tokenPricing =
    MODEL_PRICING[row.model as ModelId] ?? MODEL_PRICING[normalizeModelId(row.model) as ModelId];
  if (!tokenPricing) {
    logger.warn(
      { model: row.model },
      'Unknown model in computeCost — cost will be 0. Add entry to ALL_CLAUDE_MODELS in models.ts.',
    );
    return 0;
  }
  const tokenCost =
    (row.inputTokens * tokenPricing.input +
      row.outputTokens * tokenPricing.output +
      row.cacheReadTokens * tokenPricing.cacheRead +
      row.cacheWriteTokens * tokenPricing.cacheWrite) /
    1_000_000;
  return tokenCost + row.webSearchCount * WEB_SEARCH_COST_USD;
}

/**
 * Sum cost in USD across many usage rows.
 * @param rows - Array of usage rows
 * @returns Total cost in USD
 */
export function aggregateCost(rows: UsageRow[]): number {
  return rows.reduce((sum, row) => sum + computeCost(row), 0);
}

/**
 * Estimate cost for a planned call given ceilings. Used by the research pre-flight modal.
 * @param params - Model, token ceilings, and optional subagent parameters
 * @returns Cost estimate with min/max bounds and duration estimate
 */
export function estimateCost(params: {
  model: ModelId;
  maxInputTokens: number;
  minOutputTokens: number;
  maxOutputTokens: number;
  maxWebSearches: number;
  subagents?: {
    model: ModelId;
    count: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxWebSearches: number;
  };
}): CostEstimate {
  const pricing = MODEL_PRICING[params.model];

  const minTokenCost =
    (params.maxInputTokens * pricing.input + params.minOutputTokens * pricing.output) / 1_000_000;
  const maxTokenCost =
    (params.maxInputTokens * pricing.input + params.maxOutputTokens * pricing.output) / 1_000_000;
  const searchCost = params.maxWebSearches * WEB_SEARCH_COST_USD;

  const minUsd = minTokenCost;
  let maxUsd = maxTokenCost + searchCost;

  if (params.subagents) {
    const sub = params.subagents;
    const subPricing = MODEL_PRICING[sub.model];
    const subMaxCost =
      sub.count *
      ((sub.maxInputTokens * subPricing.input + sub.maxOutputTokens * subPricing.output) /
        1_000_000 +
        sub.maxWebSearches * WEB_SEARCH_COST_USD);
    maxUsd += subMaxCost;
  }

  // Rough duration: ~60 tok/s output for Sonnet/Haiku, ~30 tok/s for Opus
  const isOpus = params.model.includes('opus');
  const toksPerSec = isOpus ? 30 : 60;
  return {
    minUsd,
    maxUsd,
    estimatedDurationSec: {
      min: Math.ceil(params.minOutputTokens / toksPerSec),
      max: Math.ceil(params.maxOutputTokens / toksPerSec),
    },
  };
}
