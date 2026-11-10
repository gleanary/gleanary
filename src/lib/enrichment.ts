import 'server-only';
import { eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { articles, sources } from '@/db/schema';
import { logger } from '@/lib/logger';
import { callClaudeTool, requireAnthropicApiKey } from '@/lib/ai';
import { getConfig, SETTINGS_SCHEMA } from '@/lib/settings';
import { getArticleTagVocabulary } from '@/lib/db-helpers';
import { ConflictError, ExternalServiceError, NotFoundError, ValidationError } from '@/lib/errors';
import { parseAiTags } from '@/lib/text-utils';
import {
  ENRICH_MAX_ATTEMPTS,
  enrichmentResultSchema,
  filterEnrichTags,
  formatIndexText,
  formatSummaryMarkdown,
  prepareEnrichRequest,
  resolveEnrichMode,
  resolveEnrichModel,
  selectEnrichContent,
} from '@/lib/enrichment-core';
import type {
  Article,
  EnrichMode,
  EnrichResult,
  EnrichStatus,
  EnrichedArticleView,
  SourceType,
} from '@/types';

/**
 * Runs in flight, keyed by article id. Kept on `globalThis` rather than a module `const`:
 * from Session 4 the queue runs from `instrumentation.ts`, which Next.js may load as a
 * separate module instance from the route handlers, and dev HMR reloads modules.
 */
const IN_FLIGHT_KEY = Symbol.for('gleanary.enrich.inFlight');

function inFlightRuns(): Map<number, Promise<EnrichResult>> {
  const scope = globalThis as typeof globalThis & {
    [IN_FLIGHT_KEY]?: Map<number, Promise<EnrichResult>>;
  };
  return (scope[IN_FLIGHT_KEY] ??= new Map());
}

/**
 * Resolves the enrichment policy of a source type from Settings (§2.2) and logs one
 * `enrich_model_fallback` warning per rejected model level.
 * @param sourceType - The article's source type
 * @returns The mode and the model API id to use
 */
export function resolveEnrichPolicy(sourceType: SourceType): { mode: EnrichMode; model: string } {
  const mode = resolveEnrichMode(getConfig, sourceType);
  const { model, fallbacks } = resolveEnrichModel(getConfig, sourceType);
  for (const { key, rejected } of fallbacks) {
    logger.warn(
      { event: 'enrich_model_fallback', key, rejected, sourceType },
      'Configured enrichment model is not eligible; falling back',
    );
  }
  return { mode, model };
}

/**
 * `enrich_max_input_tokens` as a number. The validator keeps stored values in range, but a
 * hand-edited row would turn the budget into NaN and `truncateToBudget` into an empty cut,
 * so anything non-positive falls back to the schema default.
 */
function maxInputTokensSetting(): number {
  const value = Number(getConfig('enrich_max_input_tokens'));
  return Number.isFinite(value) && value > 0
    ? value
    : Number(SETTINGS_SCHEMA.enrich_max_input_tokens.defaultValue);
}

/** The columns `toView` reads; also what the success `UPDATE` returns. */
const VIEW_COLUMNS = {
  id: articles.id,
  aiSummary: articles.aiSummary,
  aiTags: articles.aiTags,
  enrichStatus: articles.enrichStatus,
  enrichedAt: articles.enrichedAt,
  enrichTruncated: articles.enrichTruncated,
};

type ViewRow = Pick<Article, keyof typeof VIEW_COLUMNS>;

function toView(article: ViewRow): EnrichedArticleView {
  return {
    id: article.id,
    aiSummary: article.aiSummary,
    aiTags: parseAiTags(article.aiTags, () =>
      logger.warn({ event: 'ai_tags_malformed', articleId: article.id }, 'Malformed ai_tags'),
    ),
    enrichStatus: article.enrichStatus,
    enrichedAt: article.enrichedAt,
    enrichTruncated: article.enrichTruncated,
  };
}

/**
 * Writes an enrichment status (never `updated_at`, §2.3) and returns the resulting attempt
 * count, or null when the article no longer exists.
 */
function writeEnrichStatus(
  id: number,
  set: { enrichStatus: EnrichStatus; enrichAttempts?: number | SQL },
): number | null {
  return (
    db
      .update(articles)
      .set(set)
      .where(eq(articles.id, id))
      .returning({ attempts: articles.enrichAttempts })
      .get()?.attempts ?? null
  );
}

/** What a run keeps of the loaded article: the selected text, not the content columns. */
interface RunInput {
  id: number;
  title: string;
  author: string | null;
  siteName: string | null;
  sourceType: SourceType;
  content: string;
  manual: boolean;
  /** The run started from `done` (a forced Regenerate): a failure restores `done`. */
  wasDone: boolean;
}

/** Steps 2–6 of §2.5 (synchronous): the cached result, or what the run needs. */
function prepareRun(
  id: number,
  options: { force: boolean; manual: boolean },
): { cached: EnrichResult } | { input: RunInput } {
  // Only the columns the steps read: never content_html, and the two content columns only
  // because better-sqlite3 has no lazy column load (the cached path pays for them too).
  const loaded = db
    .select({
      ...VIEW_COLUMNS,
      title: articles.title,
      author: articles.author,
      siteName: articles.siteName,
      status: articles.status,
      contentMarkdown: articles.contentMarkdown,
      contentText: articles.contentText,
      sourceType: sources.type,
    })
    .from(articles)
    .innerJoin(sources, eq(sources.id, articles.sourceId))
    .where(eq(articles.id, id))
    .get();
  if (!loaded) throw new NotFoundError('Article', id);
  const { sourceType, ...article } = loaded;

  if (article.status === 'pending_review') {
    throw new ConflictError('Article is waiting for sender approval');
  }
  const wasDone = article.enrichStatus === 'done';
  if (wasDone && !options.force) return { cached: { article: toView(article), cached: true } };

  requireAnthropicApiKey();

  const content = selectEnrichContent(article);
  if (!content) {
    // Never retried by the sweep; a `done` article keeps its result (step 9 rule).
    if (!wasDone)
      writeEnrichStatus(id, { enrichStatus: 'failed', enrichAttempts: ENRICH_MAX_ATTEMPTS });
    throw new ValidationError('Article has no content to analyze');
  }
  return {
    input: {
      id,
      title: article.title,
      author: article.author,
      siteName: article.siteName,
      sourceType,
      content,
      manual: options.manual,
      wasDone,
    },
  };
}

/**
 * Enriches one article: summary, tags and concept index from one Claude call (§2.5, single
 * run). Everything that enriches goes through here: the route (`manual: true`), and from
 * Session 4 the queue and the sweep. Nothing is awaited before the run is registered in the
 * in-flight map, so two concurrent calls for one article share one Claude call. No status
 * write touches `updated_at`.
 * @param id - Article id
 * @param options - `force` regenerates a `done` article; `manual` resets the attempt count
 * @returns The enriched view and whether it came from the stored result
 * @throws NotFoundError (404), ConflictError (409, pending review), ValidationError (422, no
 *   content), ExternalServiceError (503 no key or provider failure, 502 bad model output)
 */
export async function enrichArticle(
  id: number,
  options: { force?: boolean; manual?: boolean } = {},
): Promise<EnrichResult> {
  const inFlight = inFlightRuns();
  const running = inFlight.get(id);
  if (running) return running;

  const prepared = prepareRun(id, {
    force: options.force ?? false,
    manual: options.manual ?? false,
  });
  if ('cached' in prepared) return prepared.cached;

  const run: Promise<EnrichResult> = runEnrichment(prepared.input).finally(() => {
    if (inFlight.get(id) === run) inFlight.delete(id);
  });
  inFlight.set(id, run);
  return run;
}

/** Steps 8–9 of §2.5: mark running, call, write the result or record the failure. */
async function runEnrichment(input: RunInput): Promise<EnrichResult> {
  const { id } = input;
  let model = 'unknown';

  db.update(articles)
    .set({
      enrichStatus: 'running',
      enrichBatchId: null,
      ...(input.manual && { enrichAttempts: 0 }),
    })
    .where(eq(articles.id, id))
    .run();

  let updated: ViewRow | undefined;
  try {
    model = resolveEnrichPolicy(input.sourceType).model;
    const language = getConfig('enrich_language') || 'en';
    const vocabulary = getArticleTagVocabulary(id);
    const prepared = prepareEnrichRequest(input, {
      sourceType: input.sourceType,
      model,
      language,
      vocabulary,
      content: input.content,
      maxInputTokens: maxInputTokensSetting(),
    });

    const { input: payload, stopReason } = await callClaudeTool(
      prepared.params,
      { feature: 'article_enrich', resourceType: 'article', resourceId: id },
      { timeoutMs: prepared.timeoutMs },
    );
    if (stopReason !== 'tool_use') {
      throw new ExternalServiceError('Claude API', `Enrichment stopped with ${stopReason}`, 502);
    }
    if (payload === null) {
      throw new ExternalServiceError('Claude API', 'No record_enrichment tool call', 502);
    }
    const parsed = enrichmentResultSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError(
        'Claude API',
        `Invalid enrichment payload: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        502,
      );
    }

    const tags = filterEnrichTags(parsed.data.tags, vocabulary);
    if (tags.length === 0) {
      logger.info({ event: 'enrich_tags_all_dropped', articleId: id }, 'No tag survived filtering');
    }
    // Regenerate never wipes good tags: zero survivors keep the existing ai_tags.
    const keepTags = tags.length === 0 && input.wasDone;

    updated = db
      .update(articles)
      .set({
        aiSummary: formatSummaryMarkdown(parsed.data.summary, language),
        ...(keepTags ? {} : { aiTags: JSON.stringify(tags) }),
        aiIndex: formatIndexText(parsed.data.index),
        enrichStatus: 'done',
        enrichedAt: sql`(datetime('now'))`,
        enrichTruncated: prepared.truncated,
        enrichAttempts: 0,
      })
      .where(eq(articles.id, id))
      .returning(VIEW_COLUMNS)
      .get();
  } catch (error) {
    const attempts = input.wasDone
      ? writeEnrichStatus(id, { enrichStatus: 'done' })
      : writeEnrichStatus(id, {
          enrichStatus: 'failed',
          enrichAttempts: sql`${articles.enrichAttempts} + 1`,
        });
    logger.warn(
      {
        err: error,
        event: 'enrich_failed',
        articleId: id,
        model,
        statusCode: error instanceof ExternalServiceError ? error.statusCode : undefined,
        attempts,
      },
      'Article enrichment failed',
    );
    throw error;
  }

  if (!updated) {
    logger.warn(
      { event: 'enrich_article_vanished', articleId: id },
      'Article deleted during enrichment',
    );
    throw new NotFoundError('Article', id);
  }
  logger.info(
    {
      event: 'article_enriched',
      articleId: id,
      model,
      truncated: updated.enrichTruncated,
      tagCount: parseAiTags(updated.aiTags).length,
    },
    'Article enriched',
  );
  return { article: toView(updated), cached: false };
}
