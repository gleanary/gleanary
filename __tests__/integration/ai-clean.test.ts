import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { http, HttpResponse } from 'msw';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

vi.mock('@/lib/pdf-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pdf-storage')>();
  return {
    ...actual,
    storePdfImage: vi.fn(),
    deletePdfImages: vi.fn(),
  };
});

// callMistralOcr reads the PDF from disk via readFile; mock that for test paths
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn((path: string) => {
      if (typeof path === 'string' && path.includes('/data/originals/')) {
        return Promise.resolve(Buffer.from('%PDF-1.4 test'));
      }
      return actual.readFile(path);
    }),
  };
});

import { eq } from 'drizzle-orm';
import { server, setupHandlers } from '../mocks/server';
import { resetClient } from '@/lib/ai';
import { clearSettingsCache } from '@/lib/settings';
import { MISTRAL_REFORMAT_MODEL } from '@/lib/mistral-chat';
import { articles, aiUsage } from '@/db/schema';
import { storePdfImage, deletePdfImages } from '@/lib/pdf-storage';
import { POST as createArticle } from '@/app/api/articles/route';
import { POST as cleanArticle } from '@/app/api/ai/clean/route';
import { POST as revertArticle } from '@/app/api/ai/revert/route';

const mockStorePdfImage = storePdfImage as ReturnType<typeof vi.fn>;
const mockDeletePdfImages = deletePdfImages as ReturnType<typeof vi.fn>;

const CLEAN_HTML_RESPONSE = '<section><h2>Reformatted</h2><p>Clean content here.</p></section>';

const MISTRAL_OCR_SUCCESS = {
  pages: [{ index: 0, markdown: '## Reformatted\n\nClean content here.' }],
  model: 'mistral-ocr-4-0',
  usage_info: { pages_processed: 10 },
};

const MISTRAL_CHAT_SUCCESS = {
  id: 'chat-id',
  model: MISTRAL_REFORMAT_MODEL,
  choices: [
    { message: { content: CLEAN_HTML_RESPONSE, role: 'assistant' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 150, completion_tokens: 50, total_tokens: 200 },
};

/** Build a mock Anthropic messages-API response envelope. */
function anthropicReply(text: string, stopReason = 'end_turn', outputTokens = 50) {
  return HttpResponse.json({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: 'claude-haiku-4-5-20251001',
    stop_reason: stopReason,
    usage: { input_tokens: 200, output_tokens: outputTokens },
  });
}

setupHandlers(
  http.post('https://api.mistral.ai/v1/chat/completions', () =>
    HttpResponse.json(MISTRAL_CHAT_SUCCESS),
  ),
  http.post('https://api.anthropic.com/v1/messages', () => anthropicReply(CLEAN_HTML_RESPONSE)),
  http.post('https://api.mistral.ai/v1/files', () => HttpResponse.json({ id: 'test-file-id' })),
  http.delete('https://api.mistral.ai/v1/files/:id', () => HttpResponse.json({ deleted: true })),
  http.post('https://api.mistral.ai/v1/ocr', () => HttpResponse.json(MISTRAL_OCR_SUCCESS)),
);

function jsonReq(method: string, url: string, body?: object) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
      : {}),
  });
}

const validArticle = {
  url: 'https://example.com/clean-test',
  title: 'Clean Test Article',
  contentHtml: '<p>This is a detailed article about formatting issues.</p>',
  contentText: 'This is a detailed article about formatting issues.',
  excerpt: 'Formatting article',
};

describe('AI Clean + Revert API', () => {
  let articleId: number;

  beforeEach(async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-dummy-key');
    vi.stubEnv('MISTRAL_API_KEY', 'test-mistral-key');
    dbMock.setup();
    resetClient();

    const res = await createArticle(jsonReq('POST', '/api/articles', validArticle));
    const body = await res.json();
    articleId = body.article.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('POST /api/ai/clean', () => {
    it('cleans an article and updates the database', async () => {
      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.contentHtml).toBeTruthy();
      expect(body.contentMarkdown).toBeTruthy();
      expect(typeof body.contentHtml).toBe('string');
      expect(typeof body.contentMarkdown).toBe('string');
    });

    it('returns sanitized HTML (strips script tags from AI output)', async () => {
      const xssContent = '<p>Clean content</p><script>alert("xss")</script>';
      server.use(
        http.post('https://api.mistral.ai/v1/chat/completions', () =>
          HttpResponse.json({
            ...MISTRAL_CHAT_SUCCESS,
            choices: [
              { message: { content: xssContent, role: 'assistant' }, finish_reason: 'stop' },
            ],
          }),
        ),
      );

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.contentHtml).not.toContain('<script>');
      expect(body.contentHtml).toContain('Clean content');
    });

    it('returns 404 for nonexistent article', async () => {
      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId: 9999 }));
      expect(res.status).toBe(404);
    });

    it('returns 422 for invalid input', async () => {
      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId: -1 }));
      expect(res.status).toBe(422);
    });

    it('returns 422 for missing articleId', async () => {
      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', {}));
      expect(res.status).toBe(422);
    });

    it('returns 422 for article with no content', async () => {
      const createRes = await createArticle(
        jsonReq('POST', '/api/articles', {
          url: 'https://example.com/no-content-clean',
          title: 'No Content',
        }),
      );
      const { article } = await createRes.json();

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId: article.id }));
      expect(res.status).toBe(422);
    });

    it('returns 503 when both Mistral and Claude fail', async () => {
      server.use(
        http.post('https://api.mistral.ai/v1/chat/completions', () =>
          HttpResponse.json({ message: 'Internal error' }, { status: 500 }),
        ),
        http.post('https://api.anthropic.com/v1/messages', () =>
          HttpResponse.json({ error: { message: 'Rate limited' } }, { status: 429 }),
        ),
      );

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(503);
    });

    it('returns 422 and leaves DB unchanged when Claude returns max_tokens (truncated output)', async () => {
      // Force Anthropic path to isolate the max_tokens guard (Mistral skipped).
      vi.stubEnv('REFORMAT_PROVIDER', 'anthropic');
      clearSettingsCache();

      const db = dbMock.mock.db!;
      const originalRow = db.select().from(articles).where(eq(articles.id, articleId)).get();
      const originalHtml = originalRow?.contentHtml;

      server.use(
        http.post('https://api.anthropic.com/v1/messages', () =>
          anthropicReply('<p>Truncated mid-sentence', 'max_tokens', 32768),
        ),
      );

      try {
        const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
        expect(res.status).toBe(422);

        const body = await res.json();
        expect(body.error).toMatch(/truncated/i);

        const row = db.select().from(articles).where(eq(articles.id, articleId)).get();
        expect(row?.contentHtml).toBe(originalHtml);
        expect(row?.aiCleanedAt).toBeNull();
      } finally {
        vi.stubEnv('REFORMAT_PROVIDER', undefined);
        clearSettingsCache();
      }
    });

    it('returns 422 and leaves DB unchanged when Haiku output fails validation (non-chunked)', async () => {
      // Force Anthropic path to isolate the Haiku validation guard (Mistral skipped).
      vi.stubEnv('REFORMAT_PROVIDER', 'anthropic');
      clearSettingsCache();

      const db = dbMock.mock.db!;
      const originalRow = db.select().from(articles).where(eq(articles.id, articleId)).get();
      const originalHtml = originalRow?.contentHtml;

      server.use(
        http.post('https://api.anthropic.com/v1/messages', () =>
          // Drastically shorter than the input — fails validateCleanOutput's 0.6 min ratio
          anthropicReply('<p>x</p>', 'end_turn', 5),
        ),
      );

      try {
        const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
        expect(res.status).toBe(422);

        const body = await res.json();
        expect(body.error).toMatch(/validation/i);

        const row = db.select().from(articles).where(eq(articles.id, articleId)).get();
        expect(row?.contentHtml).toBe(originalHtml);
        expect(row?.aiCleanedAt).toBeNull();
      } finally {
        vi.stubEnv('REFORMAT_PROVIDER', undefined);
        clearSettingsCache();
      }
    });
  });

  describe('HTML branch — Mistral provider', () => {
    it('uses Mistral as primary and records ai_usage with token counts', async () => {
      const db = dbMock.mock.db!;

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.provider).toBe('mistral');
      expect(body.fallback).toBeUndefined();
      expect(body.contentHtml).toBeTruthy();

      const usageRows = db.select().from(aiUsage).where(eq(aiUsage.resourceId, articleId)).all();
      const mistralRow = usageRows.find((r) => r.model === MISTRAL_REFORMAT_MODEL);
      expect(mistralRow).toBeDefined();
      expect(mistralRow?.status).toBe('success');
      expect(mistralRow?.inputTokens).toBe(150);
      expect(mistralRow?.outputTokens).toBe(50);
    });

    it('falls back to Haiku and sets fallback:true when Mistral returns 5xx', async () => {
      server.use(
        http.post('https://api.mistral.ai/v1/chat/completions', () =>
          HttpResponse.json({ message: 'Internal error' }, { status: 500 }),
        ),
      );
      const db = dbMock.mock.db!;

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.provider).toBe('anthropic');
      expect(body.fallback).toBe(true);

      const usageRows = db.select().from(aiUsage).where(eq(aiUsage.resourceId, articleId)).all();
      const mistralRow = usageRows.find((r) => r.model === MISTRAL_REFORMAT_MODEL);
      expect(mistralRow?.status).toBe('error');
      const haikuRow = usageRows.find((r) => r.model?.startsWith('claude-haiku'));
      expect(haikuRow?.status).toBe('success');
    });

    it('falls back to Haiku and sets fallback:true when Mistral returns 429', async () => {
      server.use(
        http.post('https://api.mistral.ai/v1/chat/completions', () =>
          HttpResponse.json({ message: 'Too many requests' }, { status: 429 }),
        ),
      );

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.provider).toBe('anthropic');
      expect(body.fallback).toBe(true);
    });

    it('falls back to Haiku when Mistral output fails length validation', async () => {
      // Return a response that is far too short relative to the input (~58 chars).
      server.use(
        http.post('https://api.mistral.ai/v1/chat/completions', () =>
          HttpResponse.json({
            ...MISTRAL_CHAT_SUCCESS,
            choices: [
              { message: { content: '<p>Hi</p>', role: 'assistant' }, finish_reason: 'stop' },
            ],
          }),
        ),
      );
      const db = dbMock.mock.db!;

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.fallback).toBe(true);

      // Mistral call was attempted and succeeded (but output was invalid)
      const usageRows = db.select().from(aiUsage).where(eq(aiUsage.resourceId, articleId)).all();
      const mistralRow = usageRows.find((r) => r.model === MISTRAL_REFORMAT_MODEL);
      expect(mistralRow?.status).toBe('success');
      expect(mistralRow?.outputTokens).toBeGreaterThan(0);
    });

    it('falls back to Haiku when Mistral key is missing', async () => {
      vi.stubEnv('MISTRAL_API_KEY', undefined);
      clearSettingsCache();
      const db = dbMock.mock.db!;

      try {
        const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.provider).toBe('anthropic');
        expect(body.fallback).toBe(true);

        const usageRows = db.select().from(aiUsage).where(eq(aiUsage.resourceId, articleId)).all();
        const mistralRow = usageRows.find((r) => r.model === MISTRAL_REFORMAT_MODEL);
        expect(mistralRow).toBeUndefined();
      } finally {
        clearSettingsCache();
      }
    });

    it('falls back to Haiku when Mistral finish_reason is length (truncated output)', async () => {
      server.use(
        http.post('https://api.mistral.ai/v1/chat/completions', () =>
          HttpResponse.json({
            ...MISTRAL_CHAT_SUCCESS,
            choices: [
              {
                message: { content: CLEAN_HTML_RESPONSE, role: 'assistant' },
                finish_reason: 'length',
              },
            ],
          }),
        ),
      );

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.fallback).toBe(true);
    });

    it('uses Haiku directly when reformat_provider is set to anthropic', async () => {
      vi.stubEnv('REFORMAT_PROVIDER', 'anthropic');
      clearSettingsCache();
      const db = dbMock.mock.db!;

      try {
        const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.provider).toBe('anthropic');
        expect(body.fallback).toBeUndefined();

        const usageRows = db.select().from(aiUsage).where(eq(aiUsage.resourceId, articleId)).all();
        const mistralRow = usageRows.find((r) => r.model === MISTRAL_REFORMAT_MODEL);
        expect(mistralRow).toBeUndefined();
      } finally {
        vi.stubEnv('REFORMAT_PROVIDER', undefined);
        clearSettingsCache();
      }
    });

    it('returns 503 when both Mistral and Haiku fail', async () => {
      server.use(
        http.post('https://api.mistral.ai/v1/chat/completions', () =>
          HttpResponse.json({ message: 'Internal error' }, { status: 500 }),
        ),
        http.post('https://api.anthropic.com/v1/messages', () =>
          HttpResponse.json({ error: { message: 'Rate limited' } }, { status: 429 }),
        ),
      );
      const db = dbMock.mock.db!;

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(503);

      const usageRows = db.select().from(aiUsage).where(eq(aiUsage.resourceId, articleId)).all();
      const mistralRow = usageRows.find((r) => r.model === MISTRAL_REFORMAT_MODEL);
      expect(mistralRow?.status).toBe('error');
      const haikuRow = usageRows.find((r) => r.model?.startsWith('claude-haiku'));
      expect(haikuRow?.status).toBe('error');
    });

    // Characterization: single-shot uses minRatio 0.6, unlike the chunk path's 0.4.
    // A Mistral output whose sanitized length lands strictly between 0.4x and 0.6x of
    // the input must FAIL single-shot validation and fall back to Haiku. If the gate
    // were loosened to 0.4, this output would be accepted and no fallback would occur.
    it('falls back to Haiku when Mistral output length is in the 0.4–0.6 gap (pins minRatio 0.6)', async () => {
      // Input is ~58 chars; a 29-char sanitized output is ratio ~0.5 — passes 0.4, fails 0.6.
      server.use(
        http.post('https://api.mistral.ai/v1/chat/completions', () =>
          HttpResponse.json({
            ...MISTRAL_CHAT_SUCCESS,
            choices: [
              {
                message: { content: '<p>abcdefghijklmnopqrstuv</p>', role: 'assistant' },
                finish_reason: 'stop',
              },
            ],
          }),
        ),
      );

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.provider).toBe('anthropic');
      expect(body.fallback).toBe(true);
    });

    // Characterization: single-shot usage rows carry NO runId (null), unlike the chunked
    // path which stamps a shared runId across every per-chunk row.
    it('records single-shot ai_usage rows with no runId', async () => {
      const db = dbMock.mock.db!;

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(200);

      const usageRows = db.select().from(aiUsage).where(eq(aiUsage.resourceId, articleId)).all();
      expect(usageRows.length).toBeGreaterThan(0);
      for (const row of usageRows) {
        expect(row.runId == null).toBe(true);
      }
    });

    // Characterization: after Mistral output FAILS validation, the single-shot Haiku
    // attempt is NOT wrapped in try/catch — a Haiku provider error propagates to the
    // route and surfaces as 503 (whereas the chunk path would catch it into 'skipped').
    it('returns 503 when Mistral output fails validation and the Haiku fallback errors', async () => {
      server.use(
        http.post('https://api.mistral.ai/v1/chat/completions', () =>
          HttpResponse.json({
            ...MISTRAL_CHAT_SUCCESS,
            choices: [
              { message: { content: '<p>Hi</p>', role: 'assistant' }, finish_reason: 'stop' },
            ],
          }),
        ),
        http.post('https://api.anthropic.com/v1/messages', () =>
          HttpResponse.json({ error: { message: 'Server error' } }, { status: 500 }),
        ),
      );

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(503);
    });
  });

  describe('POST /api/ai/revert', () => {
    it('reverts a cleaned article to original content', async () => {
      // Set contentOriginalHtml so revert has something to work with
      const db = dbMock.mock.db!;
      const originalHtml =
        '<html><head><title>Test</title></head><body><p>Original article content.</p></body></html>';
      db.update(articles)
        .set({ contentOriginalHtml: originalHtml })
        .where(eq(articles.id, articleId))
        .run();

      // First clean
      await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));

      // Then revert
      const res = await revertArticle(jsonReq('POST', '/api/ai/revert', { articleId }));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.contentHtml).toBeTruthy();
      expect(body.contentMarkdown).toBeTruthy();
      // Content should differ from the AI-cleaned version
      expect(body.contentHtml).not.toContain('Reformatted');
    });

    it('returns 404 for nonexistent article', async () => {
      const res = await revertArticle(jsonReq('POST', '/api/ai/revert', { articleId: 9999 }));
      expect(res.status).toBe(404);
    });

    it('returns 422 for article without original HTML', async () => {
      // Articles created via the create route (not parse) won't have contentOriginalHtml
      const res = await revertArticle(jsonReq('POST', '/api/ai/revert', { articleId }));
      expect(res.status).toBe(422);
    });

    it('returns 422 for invalid input', async () => {
      const res = await revertArticle(jsonReq('POST', '/api/ai/revert', {}));
      expect(res.status).toBe(422);
    });
  });

  describe('PDF branch (Mistral OCR)', () => {
    const PDF_HASH = 'a'.repeat(64);
    const PDF_PATH = `/data/originals/${PDF_HASH}.pdf`;

    beforeEach(() => {
      const db = dbMock.mock.db!;
      db.update(articles)
        .set({ originalFilePath: PDF_PATH, pageCount: 10, extractionTier: 'failed' })
        .where(eq(articles.id, articleId))
        .run();
    });

    it('cleans a PDF article via Mistral, sets extractionTier to mistral, and tracks pagesProcessed', async () => {
      const db = dbMock.mock.db!;

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.contentHtml).toBeTruthy();
      expect(body.contentMarkdown).toBeTruthy();

      const row = db.select().from(articles).where(eq(articles.id, articleId)).get();
      expect(row?.extractionTier).toBe('mistral');
      expect(row?.aiCleanedAt).not.toBeNull();
      expect(row?.contentText).toBeTruthy();
      expect(row?.contentText).not.toContain('<');
      expect(row?.wordCount).toBeGreaterThan(0);

      const usageRows = db.select().from(aiUsage).where(eq(aiUsage.resourceId, articleId)).all();
      const pdfCleanRow = usageRows.find((r) => r.feature === 'ai_clean_pdf');
      expect(pdfCleanRow).toBeDefined();
      expect(pdfCleanRow?.pagesProcessed).toBe(10);
    });

    it('returns 422 for pageCount > 1000', async () => {
      const db = dbMock.mock.db!;
      db.update(articles).set({ pageCount: 1001 }).where(eq(articles.id, articleId)).run();

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(422);

      const body = await res.json();
      expect(body.error).toMatch(/1000/i);
    });

    it('returns 503 when MISTRAL_API_KEY is missing', async () => {
      vi.stubEnv('MISTRAL_API_KEY', undefined);
      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(503);
    });

    it('returns 503 when Mistral API returns 5xx', async () => {
      server.use(
        http.post('https://api.mistral.ai/v1/ocr', () =>
          HttpResponse.json({ message: 'Internal error' }, { status: 500 }),
        ),
      );

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(503);
    });

    it('returns 503 when Mistral API returns 401 (invalid API key)', async () => {
      server.use(
        http.post('https://api.mistral.ai/v1/ocr', () =>
          HttpResponse.json({ message: 'Unauthorized' }, { status: 401 }),
        ),
      );

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toMatch(/api key/i);
    });

    it('returns 422 when Mistral API returns 400 (encrypted or corrupted PDF)', async () => {
      server.use(
        http.post('https://api.mistral.ai/v1/ocr', () =>
          HttpResponse.json({ message: 'Invalid document' }, { status: 400 }),
        ),
      );

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(422);
    });

    it('revert returns 422 for PDF articles — server guard for direct API callers', async () => {
      const res = await revertArticle(jsonReq('POST', '/api/ai/revert', { articleId }));
      expect(res.status).toBe(422);

      const body = await res.json();
      expect(body.error).toMatch(/revert.*not supported.*pdf/i);
    });
  });

  describe('PDF branch — image extraction and markdown rewriting', () => {
    const PDF_HASH = 'a'.repeat(64);
    const PDF_PATH = `/data/originals/${PDF_HASH}.pdf`;

    const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff]);
    const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    // Mistral returns image_base64 as a data URI, not raw base64
    const VALID_JPEG_B64 = `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`;
    const VALID_PNG_B64 = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

    const MISTRAL_WITH_IMAGES = {
      pages: [
        {
          index: 0,
          markdown:
            '# Document\n\n![Figure 1](img-0.jpeg)\n\nSome text.\n\n![Figure 2](img-1.png)\n\n![Orphan](img-orphan.jpeg)\n\nEnd.',
          images: [
            { id: 'img-0.jpeg', image_base64: VALID_JPEG_B64 },
            { id: 'img-1.png', image_base64: VALID_PNG_B64 },
            { id: '../etc/passwd', image_base64: 'dGVzdA==' },
          ],
        },
      ],
      model: 'mistral-ocr-4-0',
      usage_info: { pages_processed: 5 },
    };

    beforeEach(() => {
      const db = dbMock.mock.db!;
      db.update(articles)
        .set({ originalFilePath: PDF_PATH, pageCount: 5, extractionTier: 'failed' })
        .where(eq(articles.id, articleId))
        .run();
      mockStorePdfImage.mockResolvedValue(undefined);
      mockDeletePdfImages.mockResolvedValue(undefined);

      server.use(
        http.post('https://api.mistral.ai/v1/ocr', () => HttpResponse.json(MISTRAL_WITH_IMAGES)),
      );
    });

    it('saves 2 valid images, skips bad-name image, rewrites refs in contentHtml', async () => {
      const db = dbMock.mock.db!;

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(200);

      expect(mockDeletePdfImages).toHaveBeenCalledWith(PDF_HASH);

      expect(mockStorePdfImage).toHaveBeenCalledTimes(2);
      expect(mockStorePdfImage).toHaveBeenCalledWith(PDF_HASH, 'img-0.jpeg', JPEG_BYTES);
      expect(mockStorePdfImage).toHaveBeenCalledWith(PDF_HASH, 'img-1.png', PNG_BYTES);

      const row = db.select().from(articles).where(eq(articles.id, articleId)).get();
      expect(row?.contentHtml).toContain(`/api/articles/${articleId}/images/img-0.jpeg`);
      expect(row?.contentHtml).toContain(`/api/articles/${articleId}/images/img-1.png`);
      expect(row?.contentHtml).not.toContain('img-orphan.jpeg');
      expect(row?.contentHash).toBe(PDF_HASH);
    });

    it('re-run calls deletePdfImages before storing new images (overwrite-mode)', async () => {
      await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      mockDeletePdfImages.mockClear();
      mockStorePdfImage.mockClear();

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(200);
      expect(mockDeletePdfImages).toHaveBeenCalledOnce();
      expect(mockStorePdfImage).toHaveBeenCalledTimes(2);
    });
  });

  describe('PDF branch — Session 10: quality params', () => {
    const PDF_HASH = 'a'.repeat(64);
    const PDF_PATH = `/data/originals/${PDF_HASH}.pdf`;

    beforeEach(() => {
      const db = dbMock.mock.db!;
      db.update(articles)
        .set({ originalFilePath: PDF_PATH, pageCount: 5, extractionTier: 'failed' })
        .where(eq(articles.id, articleId))
        .run();
      mockStorePdfImage.mockResolvedValue(undefined);
      mockDeletePdfImages.mockResolvedValue(undefined);
    });

    it('discards header and footer fields — neither appears in final content_html', async () => {
      server.use(
        http.post('https://api.mistral.ai/v1/ocr', () =>
          HttpResponse.json({
            pages: [
              {
                index: 0,
                markdown: '## Article Body\n\nActual content here.',
                header: 'Journal of Science Vol. 42',
                footer: 'Page 1 of 8',
              },
            ],
            model: 'mistral-ocr-4-0',
            usage_info: { pages_processed: 5 },
          }),
        ),
      );

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(200);

      const db = dbMock.mock.db!;
      const row = db.select().from(articles).where(eq(articles.id, articleId)).get();
      expect(row?.contentHtml).not.toContain('Journal of Science Vol. 42');
      expect(row?.contentHtml).not.toContain('Page 1 of 8');
      expect(row?.contentHtml).toContain('Actual content here');
    });

    it('preserves HTML tables with colspan and rowspan from Mistral table_format: html', async () => {
      server.use(
        http.post('https://api.mistral.ai/v1/ocr', () =>
          HttpResponse.json({
            pages: [
              {
                index: 0,
                markdown: '## Results',
                tables: [
                  {
                    id: 'tbl-0',
                    html: '<table><thead><tr><th colspan="2">Header</th></tr></thead><tbody><tr><td rowspan="2">A</td><td>B</td></tr><tr><td>C</td></tr></tbody></table>',
                  },
                ],
              },
              {
                index: 1,
                markdown: '## Discussion',
                tables: [
                  {
                    id: 'tbl-1',
                    html: '<table><tr><td>Second table</td></tr></table>',
                  },
                ],
              },
            ],
            model: 'mistral-ocr-4-0',
            usage_info: { pages_processed: 5 },
          }),
        ),
      );

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(200);

      const db = dbMock.mock.db!;
      const row = db.select().from(articles).where(eq(articles.id, articleId)).get();
      expect(row?.contentHtml).toContain('<table>');
      expect(row?.contentHtml).toContain('colspan="2"');
      expect(row?.contentHtml).toContain('rowspan="2"');
      expect(row?.contentHtml).toContain('Second table');
    });

    it('renders inline hyperlinks from Mistral markdown as clickable <a> tags', async () => {
      server.use(
        http.post('https://api.mistral.ai/v1/ocr', () =>
          HttpResponse.json({
            pages: [
              {
                index: 0,
                markdown:
                  '## References\n\nSee [the paper](https://example.com/paper) for details.',
              },
            ],
            model: 'mistral-ocr-4-0',
            usage_info: { pages_processed: 5 },
          }),
        ),
      );

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(200);

      const db = dbMock.mock.db!;
      const row = db.select().from(articles).where(eq(articles.id, articleId)).get();
      expect(row?.contentHtml).toContain('href="https://example.com/paper"');
      expect(row?.contentHtml).toContain('the paper');
    });

    it('stripPageNumbers backstop fires even when header is null', async () => {
      server.use(
        http.post('https://api.mistral.ai/v1/ocr', () =>
          HttpResponse.json({
            pages: [
              {
                index: 0,
                markdown: '## Intro\n\nSome text.\n\nPage 3 of 12\n\nMore text.',
                header: null,
                footer: null,
              },
            ],
            model: 'mistral-ocr-4-0',
            usage_info: { pages_processed: 5 },
          }),
        ),
      );

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(200);

      const db = dbMock.mock.db!;
      const row = db.select().from(articles).where(eq(articles.id, articleId)).get();
      expect(row?.contentHtml).not.toContain('Page 3 of 12');
      expect(row?.contentHtml).toContain('Some text');
    });

    it('preserves relative image URLs in final HTML (regression guard)', async () => {
      const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff]);
      const VALID_JPEG_B64 = `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`;

      server.use(
        http.post('https://api.mistral.ai/v1/ocr', () =>
          HttpResponse.json({
            pages: [
              {
                index: 0,
                markdown: '## Doc\n\n![Figure](img-0.jpeg)\n\nText.',
                images: [{ id: 'img-0.jpeg', image_base64: VALID_JPEG_B64 }],
              },
            ],
            model: 'mistral-ocr-4-0',
            usage_info: { pages_processed: 5 },
          }),
        ),
      );
      mockStorePdfImage.mockResolvedValue(undefined);

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(200);

      const db = dbMock.mock.db!;
      const row = db.select().from(articles).where(eq(articles.id, articleId)).get();
      // Relative /api/articles/... URL must survive sanitization
      expect(row?.contentHtml).toContain(`/api/articles/${articleId}/images/img-0.jpeg`);
    });

    it('strips orphan image refs when image_min_size filters out a small image', async () => {
      // img-0.jpeg appears in markdown but NOT in images array (simulates image_min_size: 100
      // filtering it out on the Mistral side). img-1.jpeg is present and should be preserved.
      server.use(
        http.post('https://api.mistral.ai/v1/ocr', () =>
          HttpResponse.json({
            pages: [
              {
                index: 0,
                markdown:
                  '## Doc\n\n![Watermark](img-0.jpeg)\n\nReal content.\n\n![Figure](img-1.jpeg)',
                images: [
                  {
                    id: 'img-1.jpeg',
                    image_base64: `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff]).toString('base64')}`,
                  },
                  // img-0.jpeg intentionally absent — filtered by image_min_size
                ],
              },
            ],
            model: 'mistral-ocr-4-0',
            usage_info: { pages_processed: 5 },
          }),
        ),
      );
      mockStorePdfImage.mockResolvedValue(undefined);

      const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
      expect(res.status).toBe(200);

      const db = dbMock.mock.db!;
      const row = db.select().from(articles).where(eq(articles.id, articleId)).get();
      expect(row?.contentHtml).not.toContain('img-0.jpeg');
      expect(row?.contentHtml).toContain(`/api/articles/${articleId}/images/img-1.jpeg`);
    });
  });
});
