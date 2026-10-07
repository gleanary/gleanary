import 'server-only';
import { readFile } from 'node:fs/promises';
import { ExternalServiceError } from '@/lib/errors';
import { getConfig } from '@/lib/settings';

const MISTRAL_FILES_URL = 'https://api.mistral.ai/v1/files';
const MISTRAL_OCR_URL = 'https://api.mistral.ai/v1/ocr';
const MISTRAL_MODEL = 'mistral-ocr-4-0';
const DEFAULT_TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MS = 60_000;

/** Minimum image dimension (px) — filters tracking pixels, decorative bullets, watermarks. */
const MISTRAL_IMAGE_MIN_SIZE = 100;

export interface MistralOcrPage {
  index: number;
  markdown: string;
  images?: Array<{ id: string; image_base64: string }>;
  /** HTML tables extracted by table_format: 'html'. Splice into page body at positional markers. */
  tables?: Array<{ id: string; html: string; format?: string }>;
  /** Hyperlinks detected in the PDF. Typically already inline in markdown as [text](url). */
  hyperlinks?: Array<{ url: string; text?: string }>;
  /** Running header extracted by extract_header: true. Discard from article body. */
  header?: string | null;
  /** Running footer extracted by extract_footer: true. Discard from article body. */
  footer?: string | null;
  dimensions?: { dpi: number; height: number; width: number };
}

interface MistralOcrResponse {
  pages: MistralOcrPage[];
  model: string;
  usage_info: { pages_processed: number };
}

function deleteMistralFile(fileId: string, apiKey: string): void {
  fetch(`${MISTRAL_FILES_URL}/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiKey}` },
  }).catch(() => {});
}

/**
 * Send a PDF file to Mistral OCR and return the extracted markdown.
 *
 * Uploads the file as raw bytes via the Mistral Files API (no base64 encoding),
 * then calls the OCR endpoint with the resulting file_id. This avoids the
 * 1.33× memory overhead of base64-encoding large PDFs into V8 strings.
 *
 * @param filePath - Absolute path to the PDF file on disk
 * @param options - Optional timeout override
 * @returns Extracted markdown, pages processed count, raw pages array, and images
 */
export async function callMistralOcr(
  filePath: string,
  options?: { timeoutMs?: number },
): Promise<{
  markdown: string;
  pagesProcessed: number;
  model: string;
  images: Array<{ id: string; image_base64: string }>;
  pages: MistralOcrPage[];
}> {
  const apiKey = getConfig('mistral_api_key');
  if (!apiKey) {
    throw new ExternalServiceError(
      'Mistral OCR',
      'API key not configured. Add MISTRAL_API_KEY in Settings → Integrations.',
      503,
    );
  }

  // Upload the PDF as raw multipart bytes — no base64 encoding needed, saving ~1.33× memory.
  let fileId: string;
  try {
    const pdfBytes = await readFile(filePath);
    const formData = new FormData();
    formData.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'document.pdf');
    formData.append('purpose', 'ocr');
    const uploadRes = await fetch(MISTRAL_FILES_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!uploadRes.ok) {
      throw new ExternalServiceError(
        'Mistral OCR',
        `File upload failed (HTTP ${uploadRes.status}).`,
        503,
      );
    }
    const uploadData = (await uploadRes.json()) as { id: string };
    fileId = uploadData.id;
  } catch (err) {
    if (err instanceof ExternalServiceError) throw err;
    throw new ExternalServiceError('Mistral OCR', `File upload failed: ${String(err)}`, 503);
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(MISTRAL_OCR_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        document: { file_id: fileId },
        include_image_base64: true,
        extract_header: true,
        extract_footer: true,
        table_format: 'html',
        image_min_size: MISTRAL_IMAGE_MIN_SIZE,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ExternalServiceError('Mistral OCR', `Request failed: ${String(err)}`, 503);
  } finally {
    deleteMistralFile(fileId, apiKey);
  }

  if (!response.ok) {
    const status = response.status;
    if (status === 401) {
      throw new ExternalServiceError(
        'Mistral OCR',
        'Invalid Mistral API key. Check Settings → Integrations.',
        503,
      );
    }
    if (status === 400 || status === 422) {
      throw new ExternalServiceError(
        'Mistral OCR',
        'PDF could not be processed by Mistral OCR.',
        422,
      );
    }
    throw new ExternalServiceError(
      'Mistral OCR',
      `Mistral request rejected (HTTP ${status}).`,
      503,
    );
  }

  let data: MistralOcrResponse;
  try {
    data = (await response.json()) as MistralOcrResponse;
  } catch {
    throw new ExternalServiceError('Mistral OCR', 'Invalid JSON in OCR response.', 503);
  }

  if (!Array.isArray(data.pages)) {
    throw new ExternalServiceError(
      'Mistral OCR',
      'Unexpected response shape — missing pages array.',
      503,
    );
  }

  const markdown = data.pages.map((p) => p.markdown ?? '').join('\n\n');
  const pagesProcessed = data.usage_info?.pages_processed ?? data.pages.length;
  const images = data.pages.flatMap((p) => p.images ?? []);

  return {
    markdown,
    pagesProcessed,
    model: MISTRAL_MODEL, // store what we sent; pricing key must match by construction
    images,
    pages: data.pages,
  };
}
