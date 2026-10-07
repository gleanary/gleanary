import 'server-only';
import {
  RateLimitError,
  APIConnectionTimeoutError,
  APIConnectionError,
  APIError,
} from '@anthropic-ai/sdk/error';
import { db } from '@/db';
import { aiUsage } from '@/db/schema';
import { logger } from '@/lib/logger';
import type { AiUsageFeature, AiUsageResourceType } from '@/types';

export interface TrackingContext {
  feature: AiUsageFeature;
  model?: string;
  runId?: string;
  resourceType?: AiUsageResourceType;
  resourceId?: number;
}

export interface UsageData {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearchCount: number;
}

type ErrorKind = 'rate_limit' | 'timeout' | 'api_error' | 'network';

function classifyError(err: unknown): ErrorKind {
  if (err instanceof APIConnectionTimeoutError) return 'timeout';
  if (err instanceof APIConnectionError) return 'network';
  if (err instanceof RateLimitError) return 'rate_limit';
  if (err instanceof APIError) return 'api_error';
  return 'api_error';
}

function extractUsageFromError(err: unknown): Partial<UsageData> {
  if (!err || typeof err !== 'object') return {};
  const e = err as Record<string, unknown>;
  // Some Anthropic rate-limit responses include token counts in the error body
  const usage = (e.usage ?? (e.error as Record<string, unknown> | undefined)?.usage) as
    Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return {};
  return {
    inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
    outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
  };
}

/**
 * Wraps a Claude SDK call. Writes a row to ai_usage on both success and failure.
 * Does NOT transform the response — callers receive exactly what `run` returns.
 * The original error is always rethrown after the row is written.
 * @param ctx - Feature label, optional runId and resource reference
 * @param run - Callback that invokes the SDK and returns result + usage
 * @returns The result from `run`
 */
export async function trackAiCall<T>(
  ctx: TrackingContext,
  run: () => Promise<{ result: T; usage: UsageData }>,
): Promise<T> {
  const startMs = Date.now();
  let status: 'success' | 'error' = 'error';
  let errorKind: ErrorKind | null = null;
  let usage: UsageData = {
    model: ctx.model ?? '',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    webSearchCount: 0,
  };
  let thrownError: unknown;

  try {
    const out = await run();
    usage = out.usage;
    status = 'success';
    return out.result;
  } catch (err) {
    thrownError = err;
    status = 'error';
    errorKind = classifyError(err);
    const partialUsage = extractUsageFromError(err);
    usage = { ...usage, ...partialUsage };
    throw err;
  } finally {
    const durationMs = Date.now() - startMs;
    try {
      await db.insert(aiUsage).values({
        feature: ctx.feature,
        model: usage.model || 'unknown',
        status,
        errorKind: errorKind ?? null,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        webSearchCount: usage.webSearchCount,
        runId: ctx.runId ?? null,
        resourceType: ctx.resourceType ?? null,
        resourceId: ctx.resourceId ?? null,
        durationMs,
      });
    } catch (dbErr) {
      // DB insert failure must never mask the original SDK error
      logger.error({ err: dbErr, feature: ctx.feature }, 'Failed to write ai_usage row');
    }
    if (thrownError === undefined) {
      logger.info(
        { event: 'ai_usage_tracked', feature: ctx.feature, status, durationMs },
        'AI call tracked',
      );
    }
  }
}

/**
 * Use instead of trackAiCall when the provider charges per-page (not per-token).
 * Token fields are zeroed so cost computation reads pagesProcessed exclusively.
 */
export async function recordPageBasedUsage(params: {
  feature: AiUsageFeature;
  model: string;
  pagesProcessed: number;
  durationMs: number;
  resourceType?: AiUsageResourceType;
  resourceId?: number;
}): Promise<void> {
  try {
    await db.insert(aiUsage).values({
      feature: params.feature,
      model: params.model,
      status: 'success',
      errorKind: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearchCount: 0,
      pagesProcessed: params.pagesProcessed,
      runId: null,
      resourceType: params.resourceType ?? null,
      resourceId: params.resourceId ?? null,
      durationMs: params.durationMs,
    });
  } catch (dbErr) {
    logger.error(
      { err: dbErr, feature: params.feature },
      'Failed to write page-based ai_usage row',
    );
  }
}

/**
 * Generate a run ID for grouping a multi-call operation (e.g. a research run).
 * @returns UUID v4 string
 */
export function newRunId(): string {
  return crypto.randomUUID();
}
