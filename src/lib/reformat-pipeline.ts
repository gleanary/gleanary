import { randomUUID } from 'crypto';
import {
  callClaudeWithMeta,
  truncateContent,
  AI_CLEAN_PROMPT,
  MAX_REFORMAT_LENGTH,
} from '@/lib/ai';
import type { ClaudeCallResult } from '@/lib/ai';
import { callMistralChat } from '@/lib/mistral-chat';
import { UTILITY_MODEL } from '@/lib/models';
import { sanitizeArticleHtml } from '@/lib/sanitize';
import { validateCleanOutput } from '@/lib/content-quality';
import { convertHtmlToMarkdown } from '@/lib/html-to-markdown';
import { stripCodeFences } from '@/lib/text-utils';
import { runWithConcurrency } from '@/lib/concurrency';
import { chunkHtml } from '@/lib/reformat-chunker';
import { logger } from '@/lib/logger';
import { ValidationError } from '@/lib/errors';
import type { TrackingContext } from '@/lib/ai-usage';
import type { ChunkOutcome, ChunkedReformatResult, SingleShotReformatResult } from '@/types';

/** Articles whose content_html exceeds this length use the parallel chunked path. */
export const CHUNK_THRESHOLD = 35_000;
/** Per-chunk Mistral timeout. Fires AbortError → caught → Haiku fallback kicks in. */
const MISTRAL_CHUNK_TIMEOUT_MS = 150_000;

/**
 * Result of a single Mistral reformat attempt. Mistral errors are CAUGHT and
 * surfaced as `reason: 'error'`; a bad/short/truncated output is `reason: 'validation'`.
 */
type MistralAttempt =
  | { ok: true; html: string }
  | { ok: false; reason: 'validation'; stopReason: 'stop' | 'length' }
  | { ok: false; reason: 'error'; err: unknown };

/**
 * Result of a single Haiku reformat attempt. Provider errors are NOT caught (they
 * propagate to the caller). `max_tokens` and `validation` failures are returned so
 * callers can log the distinct events they need.
 */
type HaikuAttempt =
  | { ok: true; html: string }
  | {
      ok: false;
      reason: 'max_tokens';
      stopReason: ClaudeCallResult['stopReason'];
      rawTextLen: number;
    }
  | {
      ok: false;
      reason: 'validation';
      stopReason: ClaudeCallResult['stopReason'];
      rawTextLen: number;
      sanitizedLen: number;
    };

/**
 * Runs one Mistral reformat attempt: call → stripCodeFences → sanitize → validate.
 * Catches provider errors so the caller can decide whether to fall back.
 * @param html - The HTML/text to reformat
 * @param ctx - Tracking context for ai_usage recording
 * @param opts - `minRatio` for validation; `timeoutMs` overrides the default timeout
 *   ONLY when provided (omitted entirely otherwise, preserving default-timeout behavior)
 * @returns A discriminated result: ok, validation failure (+stopReason), or error (+err)
 */
async function attemptMistralReformat(
  html: string,
  ctx: TrackingContext,
  opts: { minRatio: number; timeoutMs?: number },
): Promise<MistralAttempt> {
  try {
    const mistralResult =
      opts.timeoutMs !== undefined
        ? await callMistralChat(AI_CLEAN_PROMPT, html, ctx, { timeoutMs: opts.timeoutMs })
        : await callMistralChat(AI_CLEAN_PROMPT, html, ctx);
    const rawText = stripCodeFences(mistralResult.text);
    const sanitized = sanitizeArticleHtml(rawText);
    if (
      mistralResult.stopReason !== 'length' &&
      validateCleanOutput(rawText, sanitized, html, opts.minRatio)
    ) {
      return { ok: true, html: sanitized };
    }
    return { ok: false, reason: 'validation', stopReason: mistralResult.stopReason };
  } catch (err) {
    return { ok: false, reason: 'error', err };
  }
}

/**
 * Runs one Haiku reformat attempt: call → stripCodeFences → sanitize → validate.
 * Does NOT catch provider errors — they propagate to the caller.
 * @param html - The HTML/text to reformat
 * @param ctx - Tracking context for ai_usage recording
 * @param opts - `minRatio` for validation
 * @returns A discriminated result: ok, truncated (`max_tokens`), or validation failure
 */
async function attemptHaikuReformat(
  html: string,
  ctx: TrackingContext,
  opts: { minRatio: number },
): Promise<HaikuAttempt> {
  const { text: rawHtml, stopReason } = await callClaudeWithMeta(
    AI_CLEAN_PROMPT,
    html,
    ctx,
    UTILITY_MODEL,
    32768,
    240_000,
    0,
  );
  if (stopReason === 'max_tokens') {
    return { ok: false, reason: 'max_tokens', stopReason, rawTextLen: rawHtml.length };
  }
  const rawText = stripCodeFences(rawHtml);
  const sanitized = sanitizeArticleHtml(rawText);
  if (validateCleanOutput(rawText, sanitized, html, opts.minRatio)) {
    return { ok: true, html: sanitized };
  }
  return {
    ok: false,
    reason: 'validation',
    stopReason,
    rawTextLen: rawHtml.length,
    sanitizedLen: sanitized.length,
  };
}

/** Log a structured warning and reject the reformat without touching the article. */
function refuseOverwrite(event: string, reason: string, context: Record<string, number>): never {
  logger.warn({ event, ...context }, `AI reformat output ${reason}; refusing to overwrite content`);
  throw new ValidationError(
    `AI reformat output ${reason}; original content was not modified. Try again or skip this article.`,
  );
}

async function reformatChunk(
  chunkHtmlStr: string,
  chunkIndex: number,
  ctx: TrackingContext,
  skipMistral: boolean,
): Promise<ChunkOutcome> {
  if (!skipMistral) {
    const mistral = await attemptMistralReformat(chunkHtmlStr, ctx, {
      minRatio: 0.4,
      timeoutMs: MISTRAL_CHUNK_TIMEOUT_MS,
    });
    if (mistral.ok) {
      return { status: 'success', provider: 'mistral', html: mistral.html };
    }
    if (mistral.reason === 'validation') {
      logger.warn(
        { event: 'reformat_chunk_mistral_validation_failed', chunkIndex },
        'Chunk Mistral validation failed, trying Haiku',
      );
    } else {
      logger.warn(
        { event: 'reformat_chunk_mistral_error', chunkIndex, err: mistral.err },
        'Chunk Mistral error, trying Haiku',
      );
    }
  }

  try {
    const haiku = await attemptHaikuReformat(chunkHtmlStr, ctx, { minRatio: 0.4 });
    if (haiku.ok) {
      return { status: 'success', provider: 'anthropic', html: haiku.html };
    }
    logger.warn(
      {
        event: 'reformat_chunk_haiku_validation_failed',
        chunkIndex,
        stopReason: haiku.stopReason,
        inputLen: chunkHtmlStr.length,
        outputLen: haiku.rawTextLen,
      },
      'Chunk Haiku validation failed, keeping original',
    );
  } catch (err) {
    logger.warn(
      { event: 'reformat_chunk_haiku_error', chunkIndex, err },
      'Chunk Haiku error, keeping original',
    );
  }

  return { status: 'skipped', html: sanitizeArticleHtml(chunkHtmlStr) };
}

/**
 * Runs the chunked AI reformat pipeline for a large article: splits the content,
 * reformats each chunk in parallel (Mistral primary with per-chunk Haiku fallback),
 * logs per-chunk outcomes, and reassembles the sanitized HTML/markdown. Pure of
 * DB and HTTP concerns — the caller owns persistence and response shaping.
 * @param content - The article HTML/text to reformat
 * @param articleId - The article's ID, used for logging and usage tracking
 * @param skipMistral - When true, dispatch straight to Haiku (skip Mistral)
 * @returns The per-chunk outcomes, reassembled HTML/markdown, tallies, and runId
 * @throws ValidationError when every chunk fails to reformat
 */
export async function runChunkedReformat(
  content: string,
  articleId: number,
  skipMistral: boolean,
): Promise<ChunkedReformatResult> {
  const runId = randomUUID();
  const chunks = chunkHtml(content);
  const chunkCtx: TrackingContext = {
    feature: 'ai_clean',
    resourceType: 'article',
    resourceId: articleId,
    runId,
  };

  const outcomes = await runWithConcurrency(
    chunks.map((chunk) => {
      if (chunk.isOversized) {
        logger.warn(
          {
            event: 'reformat_chunk_oversized_truncated',
            chunkIndex: chunk.index,
            charCount: chunk.charCount,
          },
          'Chunk was oversized and truncated to hard ceiling before dispatch',
        );
      }
      return () => reformatChunk(chunk.html, chunk.index, chunkCtx, skipMistral);
    }),
    Math.min(chunks.length, 8),
  );

  for (const [i, outcome] of outcomes.entries()) {
    logger.info(
      {
        event: 'reformat_chunk',
        articleId,
        runId,
        chunkIndex: i,
        chunksTotal: chunks.length,
        status: outcome.status,
        provider: outcome.status === 'success' ? outcome.provider : null,
      },
      'Chunk reformat result',
    );
  }

  let successCount = 0,
    usedMistral = false,
    usedAnthropic = false;
  for (const o of outcomes) {
    if (o.status !== 'success') continue;
    successCount++;
    if (o.provider === 'mistral') usedMistral = true;
    else usedAnthropic = true;
  }
  const skippedCount = outcomes.length - successCount;

  if (successCount === 0) {
    throw new ValidationError('All chunks failed to reformat; original content was not modified.');
  }

  const assembledHtml = sanitizeArticleHtml(outcomes.map((o) => o.html).join(''));
  const contentMarkdown = convertHtmlToMarkdown(assembledHtml);

  return {
    outcomes,
    assembledHtml,
    contentMarkdown,
    successCount,
    skippedCount,
    chunksTotal: chunks.length,
    usedMistral,
    usedAnthropic,
    runId,
  };
}

/**
 * Runs the single-shot AI reformat pipeline for a smaller article: Mistral primary
 * (minRatio 0.6, default timeout) with Claude Haiku as fail-closed fallback. Unlike
 * the chunked path, the Haiku attempt is NOT wrapped in try/catch — a provider error
 * propagates to the caller (surfacing as 503), and validation/truncation failures throw
 * a ValidationError (surfacing as 422) without touching the article. Usage rows carry no
 * runId. Pure of DB and HTTP concerns — the caller owns persistence and response shaping.
 * @param content - The article HTML/text to reformat
 * @param articleId - The article's ID, used for logging and usage tracking
 * @param skipMistral - When true, dispatch straight to Haiku (skip Mistral)
 * @param mistralUnavailable - Seeds `usedFallback`: true when the key is absent but the
 *   user did not explicitly choose Anthropic (still a "fallback" from the user's view)
 * @returns Cleaned HTML/markdown, the winning provider, and the fallback flag
 * @throws ValidationError when the Haiku output is truncated or fails validation
 */
export async function runSingleShotReformat(
  content: string,
  articleId: number,
  skipMistral: boolean,
  mistralUnavailable: boolean,
): Promise<SingleShotReformatResult> {
  const truncated = truncateContent(content, MAX_REFORMAT_LENGTH);
  const trackingCtx: TrackingContext = {
    feature: 'ai_clean',
    resourceType: 'article',
    resourceId: articleId,
  };
  let usedFallback = mistralUnavailable;

  if (!skipMistral) {
    const mistral = await attemptMistralReformat(truncated, trackingCtx, { minRatio: 0.6 });
    if (mistral.ok) {
      const contentMarkdown = convertHtmlToMarkdown(mistral.html);
      return {
        contentHtml: mistral.html,
        contentMarkdown,
        provider: 'mistral',
        usedFallback: false,
      };
    }
    if (mistral.reason === 'validation') {
      logger.warn(
        { event: 'reformat_mistral_validation_failed', articleId, stopReason: mistral.stopReason },
        'Mistral output failed validation, falling back to Haiku',
      );
    } else {
      logger.warn(
        { event: 'reformat_mistral_error', articleId, err: mistral.err },
        'Mistral failed, falling back to Haiku',
      );
    }
    usedFallback = true;
  }

  const haiku = await attemptHaikuReformat(truncated, trackingCtx, { minRatio: 0.6 });
  if (!haiku.ok) {
    if (haiku.reason === 'max_tokens') {
      refuseOverwrite('ai_clean_truncated', 'was truncated', {
        articleId,
        inputLen: truncated.length,
      });
    }
    refuseOverwrite('reformat_haiku_validation_failed', 'failed validation', {
      articleId,
      inputLen: truncated.length,
      outputLen: haiku.sanitizedLen,
    });
  }

  const contentMarkdown = convertHtmlToMarkdown(haiku.html);
  return { contentHtml: haiku.html, contentMarkdown, provider: 'anthropic', usedFallback };
}
