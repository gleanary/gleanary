import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { articles } from '@/db/schema';
import { cleanArticleSchema } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { getArticleOrThrow } from '@/lib/db-helpers';
import { ExternalServiceError, ValidationError } from '@/lib/errors';
import { getPdfHashFromPath } from '@/lib/pdf-storage';
import { processPdfWithMistral, MAX_PDF_PAGES } from '@/lib/pdf-processor';
import { recordPageBasedUsage } from '@/lib/ai-usage';
import { getConfig } from '@/lib/settings';
import {
  CHUNK_THRESHOLD,
  runChunkedReformat,
  runSingleShotReformat,
} from '@/lib/reformat-pipeline';

// Re-exported so tests can import the threshold from the route path unchanged.
export { CHUNK_THRESHOLD };

/** Persists reformatted content, shared by the chunked and single-shot paths. */
function saveReformattedContent(articleId: number, contentHtml: string, contentMarkdown: string) {
  db.update(articles)
    .set({ contentHtml, contentMarkdown, aiCleanedAt: sql`(datetime('now'))` })
    .where(eq(articles.id, articleId))
    .run();
}

/**
 * POST /api/ai/clean — Reformat an article's content using AI for cleaner reading.
 * For PDF articles (originalFilePath set): retry Mistral OCR (typically used to
 * recover articles where the initial import-time OCR failed).
 * For HTML articles: reformats using Ministral 3 8B (primary) with Claude Haiku
 * as automatic fallback on provider error or output validation failure.
 * @param req - NextRequest with JSON body { articleId: number }
 * @returns Cleaned contentHtml, contentMarkdown, provider, and optional fallback flag
 */
export const POST = withRoute('POST /api/ai/clean', async (req: NextRequest) => {
  const body = await req.json();
  const { articleId } = cleanArticleSchema.parse(body);

  const article = getArticleOrThrow(articleId);

  if (article.originalFilePath) {
    if (article.pageCount !== null && article.pageCount > MAX_PDF_PAGES) {
      throw new ValidationError(
        `PDF has ${article.pageCount} pages — limit is ${MAX_PDF_PAGES}. Split externally and import as multiple articles.`,
      );
    }

    const hash = getPdfHashFromPath(article.originalFilePath);
    const result = await processPdfWithMistral(article.originalFilePath, hash, articleId);

    if (!result.ok) {
      if (result.reason === 'no_key') {
        throw new ExternalServiceError(
          'Mistral OCR',
          'API key not configured. Add MISTRAL_API_KEY in Settings → Integrations.',
          503,
        );
      }
      if (result.reason === 'empty_markdown') {
        throw new ValidationError(
          'Mistral OCR returned no text — the PDF may contain only images or scanned content without embedded text.',
        );
      }
      // 4xx from Mistral (e.g. unsupported/corrupted PDF) → 422 to discourage retries.
      // 5xx and network errors → 503 to signal a transient failure.
      if (result.statusCode && result.statusCode >= 400 && result.statusCode < 500) {
        throw new ValidationError(result.errorMessage ?? 'Mistral OCR rejected the PDF');
      }
      throw new ExternalServiceError(
        'Mistral OCR',
        result.errorMessage ?? 'Mistral OCR failed',
        503,
      );
    }

    db.update(articles)
      .set({
        contentHtml: result.html,
        contentMarkdown: result.markdown,
        contentText: result.text,
        wordCount: result.wordCount,
        contentHash: hash,
        aiCleanedAt: sql`(datetime('now'))`,
        extractionTier: 'mistral',
      })
      .where(eq(articles.id, articleId))
      .run();

    recordPageBasedUsage({
      feature: 'ai_clean_pdf',
      model: result.model,
      pagesProcessed: result.pagesProcessed,
      durationMs: result.durationMs,
      resourceType: 'article',
      resourceId: articleId,
    });

    logger.info({ event: 'ai_pdf_cleaned', articleId }, 'PDF article cleaned with Mistral OCR');

    return NextResponse.json({ contentHtml: result.html, contentMarkdown: result.markdown });
  }

  const content = article.contentHtml ?? article.contentText;
  if (!content) {
    throw new ValidationError('Article has no content to clean');
  }

  const provider = getConfig('reformat_provider');
  // mistralUnavailable: key absent but user didn't explicitly choose Anthropic.
  // Still a "fallback" from the user's perspective (unlike provider=anthropic).
  const mistralUnavailable = provider !== 'anthropic' && !getConfig('mistral_api_key');
  const skipMistral = provider === 'anthropic' || mistralUnavailable;

  if (content.length > CHUNK_THRESHOLD) {
    const {
      assembledHtml,
      contentMarkdown,
      successCount,
      skippedCount,
      chunksTotal,
      usedMistral,
      usedAnthropic,
      runId,
    } = await runChunkedReformat(content, articleId, skipMistral);

    saveReformattedContent(articleId, assembledHtml, contentMarkdown);

    logger.info(
      {
        event: 'ai_article_cleaned',
        articleId,
        runId,
        chunked: true,
        successCount,
        skippedCount,
      },
      'Article cleaned with chunked reformat',
    );

    const chunkProvider =
      usedMistral && usedAnthropic ? 'mixed' : usedMistral ? 'mistral' : 'anthropic';
    return NextResponse.json({
      contentHtml: assembledHtml,
      contentMarkdown,
      provider: chunkProvider,
      ...(provider !== 'anthropic' && usedAnthropic && { fallback: true }),
      chunked: true,
      chunksTotal,
      chunksSkipped: skippedCount,
    });
  }

  const {
    contentHtml,
    contentMarkdown,
    provider: resultProvider,
    usedFallback,
  } = await runSingleShotReformat(content, articleId, skipMistral, mistralUnavailable);

  saveReformattedContent(articleId, contentHtml, contentMarkdown);

  logger.info(
    { event: 'ai_article_cleaned', articleId, provider: resultProvider },
    resultProvider === 'mistral' ? 'Article cleaned with Mistral' : 'Article cleaned with Haiku',
  );

  return NextResponse.json({
    contentHtml,
    contentMarkdown,
    provider: resultProvider,
    ...(usedFallback && { fallback: true }),
  });
});
