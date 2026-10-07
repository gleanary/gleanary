import { pathToFileURL } from 'node:url';

import { EncryptedPdfError, ParsingError } from '@/lib/errors';
import { logger } from '@/lib/logger';

export interface PdfPreflightResult {
  pageCount: number;
  title: string | null;
  author: string | null;
  /** ISO 8601 date string (YYYY-MM-DD) parsed from PDF /Info CreationDate, or null. */
  creationDate: string | null;
}

// pdfjs-dist references several browser Canvas/geometry APIs at module
// evaluation time (not just in rendering functions). Node.js lacks these, so
// we stub them before the dynamic import. Metadata-only extraction never calls
// the rendering code paths that need real implementations.
//
// Without these stubs pdfjs-dist logs "Cannot polyfill DOMMatrix / Path2D"
// warnings when @napi-rs/canvas (an optional native peer) is absent from the
// Docker image. v6 no longer touches ImageData at module eval, so only
// DOMMatrix, Path2D, and navigator need pre-population.
let _browserGlobalsInstalled = false;
function ensureBrowserGlobals() {
  if (_browserGlobalsInstalled) return;
  _browserGlobalsInstalled = true;

  if (typeof globalThis.DOMMatrix === 'undefined') {
    // @ts-expect-error — DOMMatrix is not in the Node.js type definitions
    globalThis.DOMMatrix = class DOMMatrix {
      a = 1;
      b = 0;
      c = 0;
      d = 1;
      e = 0;
      f = 0;
      invertSelf() {
        return this;
      }
      multiplySelf() {
        return this;
      }
      preMultiplySelf() {
        return this;
      }
      translateSelf() {
        return this;
      }
    };
  }

  if (typeof globalThis.Path2D === 'undefined') {
    // @ts-expect-error — Path2D is not in the Node.js type definitions
    globalThis.Path2D = class Path2D {
      addPath() {}
      closePath() {}
      moveTo() {}
      lineTo() {}
      bezierCurveTo() {}
      quadraticCurveTo() {}
      arc() {}
      arcTo() {}
      ellipse() {}
      rect() {}
    };
  }

  // Node.js 21+ defines globalThis.navigator as a getter-only property.
  // Alpine Linux has no locale set, so navigator.language is ''. pdfjs-dist
  // unconditionally tries `globalThis.navigator = {...}` when language is
  // falsy, which throws TypeError in strict ESM. Pre-populate via
  // Object.defineProperty to satisfy the check without triggering the throw.
  if (!globalThis.navigator?.language) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'en-US', platform: '', userAgent: 'Node.js' },
      configurable: true,
      writable: true,
      enumerable: false,
    });
  }
}

/**
 * Inspects PDF metadata only — page count, title, author, creation date.
 * Does not extract text content. Detects encryption via pdfjs's onPassword
 * callback so encrypted PDFs are rejected before any downstream processing.
 *
 * Prefer passing an absolute file path (string) over a Buffer — pdfjs will
 * read via `PDFNodeStream` which uses the OS page cache rather than copying
 * the entire file into V8 heap, avoiding OOM on large PDFs.
 *
 * @param source - Absolute file path, or raw PDF bytes
 * @throws EncryptedPdfError when the PDF is password-protected
 * @throws ParsingError when the PDF is malformed
 */
export async function preflightPdf(
  source: string | Buffer | Uint8Array,
): Promise<PdfPreflightResult> {
  ensureBrowserGlobals();

  const [pdfjs, { WorkerMessageHandler }] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
  ]);

  // Inject the worker via pdfjs's public main-thread hook so its internal
  // dynamic import() never runs. That import uses /*webpackIgnore*/ hints
  // which can fail in Next.js/Turbopack server contexts. Must be set before
  // the first getDocument() call — pdfjs caches the resolution on first use.
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = { WorkerMessageHandler };

  const loadingTask =
    typeof source === 'string'
      ? pdfjs.getDocument({ url: pathToFileURL(source).href })
      : pdfjs.getDocument({ data: source instanceof Buffer ? new Uint8Array(source) : source });

  try {
    const pdf = await loadDocument(pdfjs, loadingTask);
    const pageCount = pdf.numPages;

    let title: string | null = null;
    let author: string | null = null;
    let creationDate: string | null = null;
    try {
      const meta = await pdf.getMetadata();
      const info = meta.info as Record<string, unknown>;
      title = typeof info?.Title === 'string' && info.Title ? info.Title : null;
      author = typeof info?.Author === 'string' && info.Author ? info.Author : null;
      const rawDate = typeof info?.CreationDate === 'string' ? info.CreationDate : null;
      creationDate = rawDate ? parsePdfDate(rawDate) : null;
    } catch {
      // Non-fatal: proceed without metadata
    }

    return { pageCount, title, author, creationDate };
  } finally {
    // v6 removed PDFDocumentProxy.destroy(); the loading task tears down both
    // the document and its worker. Log but never rethrow — a teardown failure
    // must not mask an in-flight preflight error.
    await loadingTask.destroy().catch((err: unknown) => {
      logger.warn({ err, event: 'pdf_preflight_destroy_failed' }, 'pdfjs teardown failed');
    });
  }
}

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

/**
 * Awaits the document load, rejecting on encryption via the onPassword
 * callback and mapping pdfjs failures onto the app's error classes.
 *
 * @param pdfjs - The dynamically imported pdfjs module (for error classes)
 * @param loadingTask - The task returned by getDocument()
 * @returns The loaded document proxy
 * @throws EncryptedPdfError when the PDF is password-protected
 * @throws ParsingError when the PDF is malformed or loading fails
 */
async function loadDocument(
  pdfjs: PdfjsModule,
  loadingTask: ReturnType<PdfjsModule['getDocument']>,
): typeof loadingTask.promise {
  try {
    return await new Promise((resolve, reject) => {
      loadingTask.onPassword = (_updateCallback: (password: string) => void, _reason: number) => {
        reject(new EncryptedPdfError());
      };
      loadingTask.promise.then(resolve, reject);
    });
  } catch (err) {
    if (err instanceof EncryptedPdfError) throw err;
    if (err instanceof pdfjs.InvalidPDFException) {
      throw new ParsingError('Invalid PDF structure', err);
    }
    throw new ParsingError(`PDF loading failed: ${String(err)}`, err);
  }
}

/**
 * Parses a PDF CreationDate string (format: D:YYYYMMDDHHmmSSOHH'mm')
 * into an ISO 8601 date string, or returns null on parse failure.
 */
function parsePdfDate(raw: string): string | null {
  const s = raw.startsWith('D:') ? raw.slice(2) : raw;
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(s);
  if (!m) return null;
  try {
    const date = new Date(`${m[1]}-${m[2]}-${m[3]}`);
    return isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}
