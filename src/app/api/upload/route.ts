import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { articles, sources } from '@/db/schema';
import { validatePdfMagicBytes, storePdf, getPdfPath, deletePdf } from '@/lib/pdf-storage';
import { preflightPdf, type PdfPreflightResult } from '@/lib/pdf-preflight';
import { processPdfWithMistral, MAX_PDF_PAGES } from '@/lib/pdf-processor';
import { sanitizeTitle } from '@/lib/text-utils';
import { scheduleConceptIndex } from '@/lib/ai';
import { recordPageBasedUsage } from '@/lib/ai-usage';
import { EncryptedPdfError, ValidationError } from '@/lib/errors';
import { handleApiError } from '@/lib/api-error-handler';
import { uploadFormSchema } from '@/lib/validators';
import { logger } from '@/lib/logger';

let _uploadSourceId: number | undefined;

async function getOrCreateUploadSource(): Promise<number> {
  if (_uploadSourceId !== undefined) return _uploadSourceId;
  const existing = db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.type, 'upload'))
    .get();
  if (existing) {
    _uploadSourceId = existing.id;
    return _uploadSourceId;
  }
  try {
    _uploadSourceId = db
      .insert(sources)
      .values({ type: 'upload', name: 'Uploaded files' })
      .returning({ id: sources.id })
      .get()!.id;
  } catch {
    _uploadSourceId = db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.type, 'upload'))
      .get()!.id;
  }
  return _uploadSourceId;
}

/**
 * POST /api/upload — Upload a PDF file and save it as an article.
 * Validates magic bytes, deduplicates by content hash, runs Mistral OCR at import time.
 * If OCR fails (network/API/missing key), the article is still saved with extractionTier='failed'
 * and the reader's retry banner offers re-extraction.
 * @param req - Multipart form request with `file` (required) and `title` (optional) fields
 * @returns 201 with created article, 400/413/422 for invalid input, 409 for duplicate
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const data = uploadFormSchema.parse({ title: formData.get('title') ?? undefined });

    const fileField = formData.get('file');
    if (!fileField || typeof fileField === 'string') {
      return NextResponse.json({ error: 'Missing or invalid file field' }, { status: 400 });
    }

    if (fileField.size > 50 * 1024 * 1024) {
      return NextResponse.json(
        { error: 'File exceeds 50MB limit. Compress, split, or re-export at lower DPI.' },
        { status: 413 },
      );
    }

    let buffer = Buffer.from(await fileField.arrayBuffer());

    if (!validatePdfMagicBytes(buffer)) {
      return NextResponse.json({ error: 'File is not a valid PDF' }, { status: 400 });
    }

    const hash = createHash('sha256').update(buffer).digest('hex');

    const duplicate = db
      .select({ id: articles.id })
      .from(articles)
      .where(eq(articles.contentHash, hash))
      .get();
    if (duplicate) {
      return NextResponse.json({ existingId: duplicate.id }, { status: 409 });
    }

    await storePdf(buffer);
    buffer = Buffer.alloc(0); // release the request buffer; GC-eligible before OCR runs

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

    const sourceId = await getOrCreateUploadSource();
    const title =
      data.title || metadata.title || sanitizeTitle(fileField.name) || 'Untitled Document';

    const article = db
      .insert(articles)
      .values({
        url: `upload://${hash}`,
        title,
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
        sourceId,
        status: 'inbox',
      })
      .returning()
      .get()!;

    const result = await processPdfWithMistral(getPdfPath(hash), hash, article.id);

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
        .where(eq(articles.id, article.id))
        .returning()
        .get()!;

      recordPageBasedUsage({
        feature: 'ai_clean_pdf',
        model: result.model,
        pagesProcessed: result.pagesProcessed,
        durationMs: result.durationMs,
        resourceType: 'article',
        resourceId: article.id,
      });

      scheduleConceptIndex(article.id, updated);

      logger.info(
        { event: 'pdf_uploaded', articleId: article.id, tier: 'mistral' },
        'PDF uploaded and extracted',
      );

      return NextResponse.json({ article: updated }, { status: 201 });
    }

    logger.warn(
      { event: 'pdf_uploaded_extraction_failed', articleId: article.id, reason: result.reason },
      'PDF saved but extraction failed; retry available in reader',
    );

    return NextResponse.json(
      { article, warning: result.reason, errorMessage: result.errorMessage },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof EncryptedPdfError) {
      return NextResponse.json({ error: 'PDF is encrypted' }, { status: 422 });
    }
    return handleApiError(error, 'POST /api/upload');
  }
}
