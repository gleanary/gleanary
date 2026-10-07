import { marked } from 'marked';
import { getConfig } from '@/lib/settings';
import { callMistralOcr } from '@/lib/mistral-ocr';
import { rewriteImageRefs } from '@/lib/pdf-image-rewriter';
import { appendPageTables } from '@/lib/pdf-table-splicer';
import { postProcessHtml } from '@/lib/html-post-processor';
import { sanitizeArticleHtml } from '@/lib/sanitize';
import { convertHtmlToMarkdown } from '@/lib/html-to-markdown';
import { stripHtml, computeWordCount } from '@/lib/text-utils';
import { storePdfImage, deletePdfImages, isValidPdfImageName } from '@/lib/pdf-storage';
import { ExternalServiceError } from '@/lib/errors';
import { logger } from '@/lib/logger';

/** Mistral OCR's documented page-count cap. Enforced before sending the request. */
export const MAX_PDF_PAGES = 1000;

export type PdfProcessingResult =
  | {
      ok: true;
      html: string;
      text: string;
      markdown: string;
      wordCount: number;
      pagesProcessed: number;
      model: string;
      durationMs: number;
    }
  | {
      ok: false;
      reason: 'no_key' | 'mistral_error' | 'empty_markdown';
      errorMessage?: string;
      /** Upstream HTTP status from Mistral when reason === 'mistral_error'. */
      statusCode?: number;
    };

/**
 * Runs a PDF file through Mistral OCR and produces sanitized HTML, markdown,
 * and plain text suitable for storage on the article row.
 *
 * Image side-effects: deletes any existing images at data/originals/images/<hash>/
 * and stores fresh images from the OCR response. Image URL refs are rewritten to
 * the /api/articles/<articleId>/images/<name> serving endpoint.
 *
 * Returns a discriminated union so callers can decide whether to persist content
 * or mark the article as failed without exception handling at every call site.
 *
 * @param filePath - Absolute path to the PDF file on disk
 * @param hash - SHA-256 of the PDF (used for image dir naming)
 * @param articleId - Article row id used to build per-article image URLs
 */
export async function processPdfWithMistral(
  filePath: string,
  hash: string,
  articleId: number,
): Promise<PdfProcessingResult> {
  if (!getConfig('mistral_api_key')) {
    return { ok: false, reason: 'no_key' };
  }

  const startMs = Date.now();
  let ocrResult: Awaited<ReturnType<typeof callMistralOcr>>;
  try {
    ocrResult = await callMistralOcr(filePath);
  } catch (err) {
    const message = err instanceof ExternalServiceError ? err.message : String(err);
    const statusCode = err instanceof ExternalServiceError ? err.statusCode : undefined;
    logger.warn({ event: 'pdf_processor_mistral_error', articleId, err }, 'Mistral OCR failed');
    return { ok: false, reason: 'mistral_error', errorMessage: message, statusCode };
  }

  if (!ocrResult.markdown.trim()) {
    return { ok: false, reason: 'empty_markdown' };
  }

  await deletePdfImages(hash);

  const validImages = ocrResult.images.filter((img) => {
    if (!isValidPdfImageName(img.id)) {
      logger.warn({ id: img.id, articleId }, 'Skipping image with invalid name from Mistral');
      return false;
    }
    return true;
  });

  // Process images sequentially to bound peak memory: each base64 string is freed
  // after its decoded bytes are written to disk, rather than all decodes being live
  // simultaneously under Promise.all.
  const storedNames = new Set<string>();
  for (const img of validImages) {
    const commaIdx = img.image_base64.indexOf(',');
    const raw = commaIdx >= 0 ? img.image_base64.slice(commaIdx + 1) : img.image_base64;
    await storePdfImage(hash, img.id, Buffer.from(raw, 'base64'));
    storedNames.add(img.id);
    img.image_base64 = ''; // release base64 string after storing to allow GC
  }

  const rewrittenMarkdown = ocrResult.pages
    .map((page) => {
      const rewritten = rewriteImageRefs(page.markdown, storedNames, articleId);
      return appendPageTables(rewritten, page.tables);
    })
    .join('\n\n');

  const rawHtml = marked.parse(rewrittenMarkdown) as string;
  const processedHtml = postProcessHtml(rawHtml, { isPdfContext: true });
  const html = sanitizeArticleHtml(processedHtml);
  const markdown = convertHtmlToMarkdown(html);
  const text = stripHtml(html);
  const wordCount = computeWordCount(text);

  return {
    ok: true,
    html,
    text,
    markdown,
    wordCount,
    pagesProcessed: ocrResult.pagesProcessed,
    model: ocrResult.model,
    durationMs: Date.now() - startMs,
  };
}
