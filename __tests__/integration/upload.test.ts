import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { http, HttpResponse } from 'msw';
import { createHash } from 'node:crypto';
import { server, setupHandlers } from '../mocks/server';
import { articleHtml } from '../mocks/fixtures/rss-feeds';

// DNS mock to prevent real lookups in parse-route SSRF validation
vi.mock('dns/promises', () => ({
  default: { resolve4: vi.fn().mockResolvedValue([]), resolve6: vi.fn().mockResolvedValue([]) },
}));

// ── DB mock ───────────────────────────────────────────────────────────────────

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

// ── PDF processing mocks ──────────────────────────────────────────────────────

vi.mock('@/lib/pdf-preflight', () => ({ preflightPdf: vi.fn() }));
vi.mock('@/lib/pdf-processor', () => ({ processPdfWithMistral: vi.fn(), MAX_PDF_PAGES: 1000 }));
vi.mock('@/lib/pdf-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pdf-storage')>();
  return { ...actual, storePdf: vi.fn(), readPdf: vi.fn(), deletePdf: vi.fn() };
});
vi.mock('@/lib/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai')>();
  return {
    ...actual,
    generateConceptIndex: vi.fn().mockResolvedValue(null),
    scheduleConceptIndex: vi.fn(),
  };
});
vi.mock('@/lib/ai-usage', () => ({ recordPageBasedUsage: vi.fn() }));

import { createTestDb } from './setup';
import { articles, sources } from '@/db/schema';
import { preflightPdf } from '@/lib/pdf-preflight';
import { processPdfWithMistral } from '@/lib/pdf-processor';
import { storePdf, readPdf, deletePdf } from '@/lib/pdf-storage';

import { POST as uploadPdf } from '@/app/api/upload/route';
import { GET as getOriginal } from '@/app/api/articles/[id]/original/route';
import { POST as parseArticle } from '@/app/api/articles/parse/route';
import { GET as listArticles } from '@/app/api/articles/route';

const mockPreflightPdf = preflightPdf as ReturnType<typeof vi.fn>;
const mockProcessPdfWithMistral = processPdfWithMistral as ReturnType<typeof vi.fn>;
const mockStorePdf = storePdf as ReturnType<typeof vi.fn>;
const mockReadPdf = readPdf as ReturnType<typeof vi.fn>;
const mockDeletePdf = deletePdf as ReturnType<typeof vi.fn>;

// ── MSW ───────────────────────────────────────────────────────────────────────

const PDF_URL_BUFFER = Buffer.from('%PDF-1.4 test PDF content for URL fetch test cases here');

setupHandlers(
  http.get(
    'https://example.com/paper.pdf',
    () => new HttpResponse(PDF_URL_BUFFER, { headers: { 'Content-Type': 'application/pdf' } }),
  ),
  http.get(
    'https://example.com/mislabeled.pdf',
    () =>
      new HttpResponse(PDF_URL_BUFFER, { headers: { 'Content-Type': 'application/octet-stream' } }),
  ),
  http.get(
    'https://example.com/article',
    () =>
      new HttpResponse(
        '<html><body><article>This is an article with enough words for defuddle to extract it properly as valid content.</article></body></html>',
        { headers: { 'Content-Type': 'text/html' } },
      ),
  ),
);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const GOOD_PREFLIGHT = {
  pageCount: 5,
  title: 'Great Paper Title',
  author: 'Jane Author',
  creationDate: '2024-01-15',
};

const GOOD_MISTRAL = {
  ok: true as const,
  html: '<p>Article content.</p>',
  text: 'Article content.',
  markdown: 'Article content.',
  wordCount: 2,
  pagesProcessed: 5,
  model: 'mistral-ocr-4-0',
  durationMs: 1234,
};

function pdfBuf(): Buffer {
  return Buffer.from('%PDF-minimal test content for magic bytes');
}

function multipartReq(buffer: Buffer, filename: string, title?: string): NextRequest {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(buffer)], filename, { type: 'application/pdf' }));
  if (title !== undefined) form.append('title', title);
  return new NextRequest('http://localhost/api/upload', { method: 'POST', body: form });
}

function jsonReq(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── POST /api/upload ──────────────────────────────────────────────────────────

describe('POST /api/upload', () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    testDb = dbMock.setup();
    // Pre-insert the upload source so the route's module-level _uploadSourceId cache
    // (set during the first test) stays valid across fresh DBs (all get id=1).
    testDb.db.insert(sources).values({ type: 'upload', name: 'Uploaded files' }).run();
    mockStorePdf.mockResolvedValue('a'.repeat(64));
    mockPreflightPdf.mockResolvedValue(GOOD_PREFLIGHT);
    mockProcessPdfWithMistral.mockResolvedValue(GOOD_MISTRAL);
  });

  it('returns 201 and creates an article with extractionTier=mistral on OCR success', async () => {
    const res = await uploadPdf(multipartReq(pdfBuf(), 'paper.pdf'));
    expect(res.status).toBe(201);
    const { article } = await res.json();
    expect(article.url).toMatch(/^upload:\/\//);
    expect(article.extractionTier).toBe('mistral');
    expect(article.originalFilePath).toBeTruthy();
    expect(article.contentHash).toBeTruthy();
    expect(article.aiCleanedAt).toBeTruthy();
    expect(article.contentHtml).toContain('Article content');
    const rows = testDb.db.select().from(articles).all();
    expect(rows).toHaveLength(1);
  });

  it('returns 409 with existingId for duplicate content hash before any processing', async () => {
    const hash = createHash('sha256').update(pdfBuf()).digest('hex');
    testDb.db
      .insert(articles)
      .values({ url: `upload://${hash}`, title: 'Existing', contentHash: hash })
      .run();
    const res = await uploadPdf(multipartReq(pdfBuf(), 'paper.pdf'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.existingId).toBeTypeOf('number');
    expect(mockStorePdf).not.toHaveBeenCalled();
    expect(mockPreflightPdf).not.toHaveBeenCalled();
    expect(mockProcessPdfWithMistral).not.toHaveBeenCalled();
  });

  it('returns 400 for non-PDF magic bytes', async () => {
    const res = await uploadPdf(multipartReq(Buffer.from('not a pdf at all'), 'file.txt'));
    expect(res.status).toBe(400);
  });

  it('returns 413 for file over 50MB', async () => {
    const req = multipartReq(pdfBuf(), 'big.pdf');
    vi.spyOn(req, 'formData').mockResolvedValueOnce({
      get: (key: string) =>
        key === 'file'
          ? { name: 'big.pdf', size: 51 * 1024 * 1024, arrayBuffer: async () => pdfBuf().buffer }
          : null,
    } as unknown as FormData);
    const res = await uploadPdf(req);
    expect(res.status).toBe(413);
    expect(mockStorePdf).not.toHaveBeenCalled();
  });

  it('returns 422 for encrypted PDF, stores then cleans up the file, and creates no article', async () => {
    const { EncryptedPdfError } = await import('@/lib/errors');
    mockPreflightPdf.mockRejectedValueOnce(new EncryptedPdfError());
    const res = await uploadPdf(multipartReq(pdfBuf(), 'enc.pdf'));
    expect(res.status).toBe(422);
    expect(mockStorePdf).toHaveBeenCalled();
    expect(mockDeletePdf).toHaveBeenCalled();
    expect(mockProcessPdfWithMistral).not.toHaveBeenCalled();
    expect(testDb.db.select().from(articles).all()).toHaveLength(0);
  });

  it('returns 422 when PDF exceeds 1000 pages, stores then cleans up the file', async () => {
    mockPreflightPdf.mockResolvedValueOnce({ ...GOOD_PREFLIGHT, pageCount: 1001 });
    const res = await uploadPdf(multipartReq(pdfBuf(), 'huge.pdf'));
    expect(res.status).toBe(422);
    expect(mockStorePdf).toHaveBeenCalled();
    expect(mockDeletePdf).toHaveBeenCalled();
    expect(mockProcessPdfWithMistral).not.toHaveBeenCalled();
    expect(testDb.db.select().from(articles).all()).toHaveLength(0);
  });

  it('returns 201 with extractionTier=failed when Mistral key is not configured', async () => {
    mockProcessPdfWithMistral.mockResolvedValueOnce({ ok: false, reason: 'no_key' });
    const res = await uploadPdf(multipartReq(pdfBuf(), 'paper.pdf'));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.article.extractionTier).toBe('failed');
    expect(body.article.contentHtml).toBe('');
    expect(body.warning).toBe('no_key');
    // File still stored so retry path works
    expect(mockStorePdf).toHaveBeenCalled();
  });

  it('returns 201 with extractionTier=failed when Mistral OCR errors', async () => {
    mockProcessPdfWithMistral.mockResolvedValueOnce({
      ok: false,
      reason: 'mistral_error',
      errorMessage: 'Mistral OCR: timeout',
    });
    const res = await uploadPdf(multipartReq(pdfBuf(), 'paper.pdf'));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.article.extractionTier).toBe('failed');
    expect(body.warning).toBe('mistral_error');
  });

  it('uses preflight metadata title when user provides no title', async () => {
    const res = await uploadPdf(multipartReq(pdfBuf(), 'myfile.pdf'));
    const { article } = await res.json();
    expect(article.title).toBe('Great Paper Title');
  });

  it('falls back to filename (without .pdf) when preflight title is null', async () => {
    mockPreflightPdf.mockResolvedValueOnce({ ...GOOD_PREFLIGHT, title: null });
    const res = await uploadPdf(multipartReq(pdfBuf(), 'my-doc.pdf'));
    const { article } = await res.json();
    expect(article.title).toBe('my-doc');
  });

  it('falls back to Untitled Document when filename is whitespace', async () => {
    mockPreflightPdf.mockResolvedValueOnce({ ...GOOD_PREFLIGHT, title: null });
    const res = await uploadPdf(multipartReq(pdfBuf(), '   '));
    expect(res.status).toBe(201);
    const { article } = await res.json();
    expect(article.title).toBe('Untitled Document');
  });

  it('strips path separators from filename', async () => {
    mockPreflightPdf.mockResolvedValueOnce({ ...GOOD_PREFLIGHT, title: null });
    const res = await uploadPdf(multipartReq(pdfBuf(), '../../malicious.pdf'));
    const { article } = await res.json();
    expect(article.title).not.toContain('/');
    expect(article.title).not.toContain('\\');
    expect(article.title).not.toContain('..');
  });

  it('returns 400 when file field is absent from form data', async () => {
    const form = new FormData();
    const req = new NextRequest('http://localhost/api/upload', { method: 'POST', body: form });
    const res = await uploadPdf(req);
    expect(res.status).toBe(400);
  });

  it('returns 201 falling back to filename when title field is absent', async () => {
    mockPreflightPdf.mockResolvedValueOnce({ ...GOOD_PREFLIGHT, title: null });
    const form = new FormData();
    form.append(
      'file',
      new File([new Uint8Array(pdfBuf())], 'thesis.pdf', { type: 'application/pdf' }),
    );
    const req = new NextRequest('http://localhost/api/upload', { method: 'POST', body: form });
    const res = await uploadPdf(req);
    expect(res.status).toBe(201);
    const { article } = await res.json();
    expect(article.title).toBe('thesis');
  });

  it('returns 422 for title field exceeding 500 chars', async () => {
    const res = await uploadPdf(multipartReq(pdfBuf(), 'doc.pdf', 'a'.repeat(501)));
    expect(res.status).toBe(422);
  });
});

// ── GET /api/articles/[id]/original ──────────────────────────────────────────

describe('GET /api/articles/[id]/original', () => {
  let testDb: ReturnType<typeof createTestDb>;
  const FAKE_PDF = Buffer.from('FAKEPDFCONTENTFORTESTING');

  beforeEach(() => {
    vi.clearAllMocks();
    testDb = dbMock.setup();
    mockReadPdf.mockResolvedValue(FAKE_PDF);
  });

  const VALID_HASH = 'a'.repeat(64);

  function insertWithPdf(): number {
    return testDb.db
      .insert(articles)
      .values({
        url: `upload://${VALID_HASH}`,
        title: 'Test PDF',
        originalFilePath: `/data/originals/${VALID_HASH}.pdf`,
        contentHash: VALID_HASH,
      })
      .returning({ id: articles.id })
      .get()!.id;
  }

  function insertWithoutPdf(): number {
    return testDb.db
      .insert(articles)
      .values({ url: 'https://example.com/article', title: 'Web Article' })
      .returning({ id: articles.id })
      .get()!.id;
  }

  function ctx(id: number) {
    return { params: Promise.resolve({ id: String(id) }) };
  }

  function req(id: number, range?: string): NextRequest {
    return new NextRequest(`http://localhost/api/articles/${id}/original`, {
      headers: range ? { Range: range } : {},
    });
  }

  it('returns 200 with PDF content and correct headers', async () => {
    const id = insertWithPdf();
    const res = await getOriginal(req(id), ctx(id));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(FAKE_PDF);
  });

  it('returns 206 for start-end range', async () => {
    const id = insertWithPdf();
    const res = await getOriginal(req(id, 'bytes=0-9'), ctx(id));
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-9/${FAKE_PDF.length}`);
    expect(res.headers.get('content-length')).toBe('10');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(FAKE_PDF.subarray(0, 10));
  });

  it('returns 206 for suffix range (bytes=-N)', async () => {
    const id = insertWithPdf();
    const res = await getOriginal(req(id, 'bytes=-5'), ctx(id));
    expect(res.status).toBe(206);
    const start = FAKE_PDF.length - 5;
    expect(res.headers.get('content-range')).toBe(
      `bytes ${start}-${FAKE_PDF.length - 1}/${FAKE_PDF.length}`,
    );
    expect(res.headers.get('content-length')).toBe('5');
  });

  it('returns 206 for open-ended range (bytes=N-)', async () => {
    const id = insertWithPdf();
    const res = await getOriginal(req(id, 'bytes=5-'), ctx(id));
    expect(res.status).toBe(206);
    expect(res.headers.get('content-length')).toBe(String(FAKE_PDF.length - 5));
  });

  it('returns 416 when range start is beyond file size', async () => {
    const id = insertWithPdf();
    const res = await getOriginal(req(id, 'bytes=99999-'), ctx(id));
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${FAKE_PDF.length}`);
  });

  it('clamps explicit range end to total - 1 when client requests past EOF', async () => {
    const id = insertWithPdf();
    const res = await getOriginal(req(id, 'bytes=0-9999999'), ctx(id));
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(
      `bytes 0-${FAKE_PDF.length - 1}/${FAKE_PDF.length}`,
    );
    expect(res.headers.get('content-length')).toBe(String(FAKE_PDF.length));
    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(FAKE_PDF);
  });

  it('returns 404 for article without originalFilePath', async () => {
    const id = insertWithoutPdf();
    const res = await getOriginal(req(id), ctx(id));
    expect(res.status).toBe(404);
  });

  it('returns 404 for non-existent article ID', async () => {
    const res = await getOriginal(req(9999), ctx(9999));
    expect(res.status).toBe(404);
  });
});

// ── POST /api/articles/parse — PDF branch ────────────────────────────────────

describe('POST /api/articles/parse — PDF branch', () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    testDb = dbMock.setup();
    mockStorePdf.mockResolvedValue('b'.repeat(64));
    mockPreflightPdf.mockResolvedValue(GOOD_PREFLIGHT);
    mockProcessPdfWithMistral.mockResolvedValue(GOOD_MISTRAL);
  });

  it('creates PDF article via Mistral when URL serves application/pdf', async () => {
    const req = jsonReq('http://localhost/api/articles/parse', {
      url: 'https://example.com/paper.pdf',
    });
    const res = await parseArticle(req);
    expect(res.status).toBe(201);
    const { article } = await res.json();
    expect(article.url).toBe('https://example.com/paper.pdf');
    expect(article.originalFilePath).toBeTruthy();
    expect(article.extractionTier).toBe('mistral');
    expect(article.aiCleanedAt).toBeTruthy();
  });

  it('creates PDF article when magic bytes match despite wrong content-type', async () => {
    const req = jsonReq('http://localhost/api/articles/parse', {
      url: 'https://example.com/mislabeled.pdf',
    });
    const res = await parseArticle(req);
    expect(res.status).toBe(201);
    const { article } = await res.json();
    expect(article.originalFilePath).toBeTruthy();
  });

  it('returns 422 when PDF exceeds 1000 pages, stores then cleans up the file', async () => {
    mockPreflightPdf.mockResolvedValueOnce({ ...GOOD_PREFLIGHT, pageCount: 1001 });
    const req = jsonReq('http://localhost/api/articles/parse', {
      url: 'https://example.com/paper.pdf',
    });
    const res = await parseArticle(req);
    expect(res.status).toBe(422);
    expect(mockStorePdf).toHaveBeenCalled();
    expect(mockDeletePdf).toHaveBeenCalled();
  });

  it('does not set originalFilePath for non-PDF URL', async () => {
    // The direct-fetch handler above is too sparse for defuddle, so the parse
    // route falls back to Jina Reader. Mock it for this test only, keeping the
    // global tripwire armed for the rest of the file (this fallback used to
    // leak to the real r.jina.ai).
    server.use(
      http.get(
        'https://r.jina.ai/*',
        () => new HttpResponse(articleHtml, { headers: { 'Content-Type': 'text/html' } }),
      ),
    );
    const req = jsonReq('http://localhost/api/articles/parse', {
      url: 'https://example.com/article',
    });
    const res = await parseArticle(req);
    expect(res.status).toBe(201);
    const { article } = await res.json();
    expect(article.originalFilePath).toBeFalsy();
  });

  it('returns 409 with existingId when URL already in DB', async () => {
    testDb.db
      .insert(articles)
      .values({ url: 'https://example.com/paper.pdf', title: 'Existing' })
      .run();
    const req = jsonReq('http://localhost/api/articles/parse', {
      url: 'https://example.com/paper.pdf',
    });
    const res = await parseArticle(req);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.existingId).toBeTypeOf('number');
  });

  it('returns 409 when same PDF was previously uploaded (cross-flow dedup)', async () => {
    const hash = createHash('sha256').update(PDF_URL_BUFFER).digest('hex');
    testDb.db
      .insert(articles)
      .values({ url: `upload://${hash}`, title: 'Previously uploaded', contentHash: hash })
      .run();
    const req = jsonReq('http://localhost/api/articles/parse', {
      url: 'https://example.com/paper.pdf',
    });
    const res = await parseArticle(req);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.existingId).toBeTypeOf('number');
  });
});

// ── GET /api/articles — PDF fields ────────────────────────────────────────────

describe('GET /api/articles — PDF list fields', () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    testDb = dbMock.setup();
    testDb.db.insert(sources).values({ type: 'upload', name: 'Uploaded files' }).run();
    mockPreflightPdf.mockResolvedValue(GOOD_PREFLIGHT);
    mockProcessPdfWithMistral.mockResolvedValue(GOOD_MISTRAL);
    mockStorePdf.mockResolvedValue('a'.repeat(64));
  });

  it('returns pageCount, originalFilePath, and extractionTier for PDF articles', async () => {
    const uploadRes = await uploadPdf(multipartReq(pdfBuf(), 'paper.pdf'));
    expect(uploadRes.status).toBe(201);
    const { article } = await uploadRes.json();

    const listReq = new NextRequest('http://localhost/api/articles', { method: 'GET' });
    const listRes = await listArticles(listReq);
    expect(listRes.status).toBe(200);
    const { articles: list } = await listRes.json();

    const pdfArticle = list.find((a: { id: number }) => a.id === article.id);
    expect(pdfArticle).toBeDefined();
    expect(pdfArticle.pageCount).toBe(5);
    expect(pdfArticle.originalFilePath).toBeTruthy();
    expect(pdfArticle.extractionTier).toBe('mistral');
  });
});
