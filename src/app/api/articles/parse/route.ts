import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { articles } from '@/db/schema';
import { parseArticleSchema } from '@/lib/validators';
import { parseArticleFromHtml, parseArticleFromUrl } from '@/lib/article-parser';
import { validatePdfMagicBytes, storePdf, getPdfPath, deletePdf } from '@/lib/pdf-storage';
import { preflightPdf, type PdfPreflightResult } from '@/lib/pdf-preflight';
import { processPdfWithMistral, MAX_PDF_PAGES } from '@/lib/pdf-processor';
import { sanitizeTitle } from '@/lib/text-utils';
import { safeFetch } from '@/lib/fetch-utils';
import { scheduleConceptIndex } from '@/lib/ai';
import { recordPageBasedUsage } from '@/lib/ai-usage';
import { EncryptedPdfError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { handleApiError } from '@/lib/api-error-handler';

/**
 * POST /api/articles/parse — Parse a URL (or provided HTML) and save as an article.
 * For URL imports, pre-fetches to detect PDFs before falling back to Defuddle/Jina.
 * Idempotent: returns 409 with `existingId` if the URL or content hash already exists.
 * @param req - NextRequest with JSON body matching parseArticleSchema
 * @returns Created article with 201 status, or 409 if duplicate
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const data = parseArticleSchema.parse(body);

    // URL dedup — return existingId so the client can navigate to the existing article
    const existing = db
      .select({ id: articles.id })
      .from(articles)
      .where(eq(articles.url, data.url))
      .get();
    if (existing) {
      return NextResponse.json({ existingId: existing.id }, { status: 409 });
    }

    if (data.html) {
      const parsed = await parseArticleFromHtml(data.html, data.url);
      const htmlArticle = db
        .insert(articles)
        .values({
          url: parsed.url,
          title: parsed.title,
          author: parsed.author,
          contentHtml: parsed.contentHtml,
          contentText: parsed.contentText,
          contentOriginalHtml: parsed.contentOriginalHtml,
          contentMarkdown: parsed.contentMarkdown,
          excerpt: parsed.excerpt,
          siteName: parsed.siteName,
          imageUrl: parsed.imageUrl,
          wordCount: parsed.wordCount,
          publishedAt: parsed.publishedAt,
          sourceId: data.sourceId,
          status: data.status,
        })
        .returning()
        .get()!;

      logger.info(
        { event: 'article_parsed_and_saved', articleId: htmlArticle.id, url: data.url },
        'Article parsed and saved',
      );
      scheduleConceptIndex(htmlArticle.id, htmlArticle);
      return NextResponse.json({ article: htmlArticle }, { status: 201 });
    }

    // URL path: single GET to detect PDFs before Defuddle/Jina.
    // Default cap 5MB for HTML; URLs hinting at PDF (extension or content-type) get 50MB.
    // On network failure, buffer stays null and parseArticleFromUrl handles Jina fallback.
    const looksLikePdfUrl = /\.pdf($|\?)/i.test(data.url);
    let buffer: Buffer | null = null;
    let fetchContentType = '';
    let prefetchOk = true;
    try {
      const initialMax = looksLikePdfUrl ? 50 * 1024 * 1024 : 5 * 1024 * 1024;
      let res = await safeFetch(data.url, { maxBytes: initialMax, validateSsrf: true });
      fetchContentType = res.headers.get('content-type') ?? '';
      prefetchOk = res.ok;
      // Body might be a PDF even without .pdf in the URL — refetch with PDF cap.
      if (!looksLikePdfUrl && fetchContentType.toLowerCase().startsWith('application/pdf')) {
        await res.body?.cancel().catch(() => undefined);
        res = await safeFetch(data.url, { maxBytes: 50 * 1024 * 1024, validateSsrf: false });
        fetchContentType = res.headers.get('content-type') ?? '';
        prefetchOk = res.ok;
      }
      buffer = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      // ExternalServiceError (network/timeout/oversize) → skip prefetch, Jina fallback below
    }

    if (buffer !== null && validatePdfMagicBytes(buffer)) {
      const hash = createHash('sha256').update(buffer).digest('hex');

      const byHash = db
        .select({ id: articles.id })
        .from(articles)
        .where(eq(articles.contentHash, hash))
        .get();
      if (byHash) {
        return NextResponse.json({ existingId: byHash.id }, { status: 409 });
      }

      await storePdf(buffer);
      buffer = Buffer.alloc(0); // release the fetched buffer; GC-eligible before OCR runs

      let metadata: PdfPreflightResult;
      try {
        metadata = await preflightPdf(getPdfPath(hash));
        if (metadata.pageCount > MAX_PDF_PAGES) {
          throw new ValidationError(
            `PDF has ${metadata.pageCount} pages — limit is ${MAX_PDF_PAGES}. Split externally and import as multiple PDFs.`,
          );
        }
      } catch (err) {
        await deletePdf(hash);
        throw err;
      }

      const titleFallback =
        sanitizeTitle(decodeURIComponent(data.url.split('/').pop() ?? '')) || 'Untitled Document';

      const pdfArticle = db
        .insert(articles)
        .values({
          url: data.url,
          title: metadata.title || titleFallback,
          author: metadata.author,
          contentHtml: '',
          contentText: '',
          contentMarkdown: '',
          wordCount: 0,
          pageCount: metadata.pageCount,
          publishedAt: metadata.creationDate,
          extractionTier: 'failed',
          originalFilePath: getPdfPath(hash),
          contentHash: hash,
          sourceId: data.sourceId,
          status: data.status,
        })
        .returning()
        .get()!;

      const result = await processPdfWithMistral(getPdfPath(hash), hash, pdfArticle.id);

      if (result.ok) {
        const updated = db
          .update(articles)
          .set({
            contentHtml: result.html,
            contentText: result.text,
            contentMarkdown: result.markdown,
            wordCount: result.wordCount,
            extractionTier: 'mistral',
            aiCleanedAt: sql`(datetime('now'))`,
          })
          .where(eq(articles.id, pdfArticle.id))
          .returning()
          .get()!;

        recordPageBasedUsage({
          feature: 'ai_clean_pdf',
          model: result.model,
          pagesProcessed: result.pagesProcessed,
          durationMs: result.durationMs,
          resourceType: 'article',
          resourceId: pdfArticle.id,
        });

        scheduleConceptIndex(pdfArticle.id, updated);

        logger.info(
          {
            event: 'pdf_parsed_from_url',
            articleId: pdfArticle.id,
            url: data.url,
            tier: 'mistral',
          },
          'PDF article created from URL',
        );

        return NextResponse.json({ article: updated }, { status: 201 });
      }

      logger.warn(
        {
          event: 'pdf_parsed_from_url_extraction_failed',
          articleId: pdfArticle.id,
          url: data.url,
          reason: result.reason,
        },
        'PDF saved but extraction failed; retry available in reader',
      );

      return NextResponse.json(
        { article: pdfArticle, warning: result.reason, errorMessage: result.errorMessage },
        { status: 201 },
      );
    }

    // Not a PDF — pass pre-fetched buffer so parseArticleFromUrl skips the initial fetch.
    // If prefetch failed (buffer null), parseArticleFromUrl does its own fetch + Jina fallback.
    const parsed = await parseArticleFromUrl(
      data.url,
      buffer !== null
        ? { prefetched: { buffer, contentType: fetchContentType, ok: prefetchOk } }
        : undefined,
    );

    const webArticle = db
      .insert(articles)
      .values({
        url: parsed.url,
        title: parsed.title,
        author: parsed.author,
        contentHtml: parsed.contentHtml,
        contentText: parsed.contentText,
        contentOriginalHtml: parsed.contentOriginalHtml,
        contentMarkdown: parsed.contentMarkdown,
        excerpt: parsed.excerpt,
        siteName: parsed.siteName,
        imageUrl: parsed.imageUrl,
        wordCount: parsed.wordCount,
        publishedAt: parsed.publishedAt,
        sourceId: data.sourceId,
        status: data.status,
      })
      .returning()
      .get()!;

    logger.info(
      { event: 'article_parsed_and_saved', articleId: webArticle.id, url: data.url },
      'Article parsed and saved',
    );
    scheduleConceptIndex(webArticle.id, webArticle);
    return NextResponse.json({ article: webArticle }, { status: 201 });
  } catch (error) {
    if (error instanceof EncryptedPdfError) {
      return NextResponse.json({ error: 'PDF is encrypted' }, { status: 422 });
    }
    return handleApiError(error, 'POST /api/articles/parse');
  }
}
