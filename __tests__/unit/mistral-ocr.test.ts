import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { http, HttpResponse } from 'msw';
import { server, setupHandlers } from '../mocks/server';
import { ExternalServiceError } from '@/lib/errors';

const MISTRAL_FILES_URL = 'https://api.mistral.ai/v1/files';
const MISTRAL_OCR_URL = 'https://api.mistral.ai/v1/ocr';

const mockGetConfig = vi.hoisted(() => vi.fn());
vi.mock('@/lib/settings', () => ({
  getConfig: mockGetConfig,
  SETTINGS_SCHEMA: {},
  ENCRYPTED_KEYS: new Set(),
  getSetting: vi.fn().mockReturnValue(null),
}));

import { callMistralOcr } from '@/lib/mistral-ocr';

const MOCK_PDF_PATH = join(tmpdir(), 'test-mistral-ocr.pdf');

const MISTRAL_SUCCESS = {
  pages: [
    { index: 0, markdown: '# Page One\n\nFirst page content.' },
    { index: 1, markdown: '## Section\n\nSecond page content.' },
  ],
  model: 'mistral-ocr-4-0',
  usage_info: { pages_processed: 2 },
};

setupHandlers(
  http.post(MISTRAL_FILES_URL, () => HttpResponse.json({ id: 'test-file-id-abc' })),
  http.delete(`${MISTRAL_FILES_URL}/:id`, () => HttpResponse.json({ deleted: true })),
  http.post(MISTRAL_OCR_URL, () => HttpResponse.json(MISTRAL_SUCCESS)),
);

beforeAll(() => {
  writeFileSync(MOCK_PDF_PATH, Buffer.from('%PDF-1.4 test content'));
});
afterEach(() => {
  mockGetConfig.mockReset();
});
afterAll(() => {
  try {
    unlinkSync(MOCK_PDF_PATH);
  } catch {}
});

describe('callMistralOcr', () => {
  it('returns joined markdown and pagesProcessed on success', async () => {
    mockGetConfig.mockReturnValue('test-mistral-key');

    const result = await callMistralOcr(MOCK_PDF_PATH);

    expect(result.markdown).toContain('# Page One');
    expect(result.markdown).toContain('## Section');
    expect(result.pagesProcessed).toBe(2);
  });

  it('uploads the PDF via the Files API and sends the file_id to the OCR endpoint', async () => {
    mockGetConfig.mockReturnValue('test-mistral-key');
    let capturedFileUpload: { method: string; contentType: string | null } | null = null;
    let capturedOcrBody: unknown = null;

    server.use(
      http.post(MISTRAL_FILES_URL, ({ request }) => {
        capturedFileUpload = {
          method: request.method,
          contentType: request.headers.get('content-type'),
        };
        return HttpResponse.json({ id: 'uploaded-file-id' });
      }),
      http.post(MISTRAL_OCR_URL, async ({ request }) => {
        capturedOcrBody = await request.json();
        return HttpResponse.json(MISTRAL_SUCCESS);
      }),
    );

    await callMistralOcr(MOCK_PDF_PATH);

    expect(capturedFileUpload).not.toBeNull();
    expect(capturedFileUpload!.contentType).toMatch(/^multipart\/form-data/);
    expect(capturedOcrBody).toMatchObject({
      model: 'mistral-ocr-4-0',
      document: { file_id: 'uploaded-file-id' },
    });
  });

  it('sends Authorization header with the API key on both upload and OCR requests', async () => {
    mockGetConfig.mockReturnValue('my-secret-key');
    const capturedAuth: string[] = [];

    server.use(
      http.post(MISTRAL_FILES_URL, ({ request }) => {
        capturedAuth.push(request.headers.get('Authorization') ?? '');
        return HttpResponse.json({ id: 'file-123' });
      }),
      http.post(MISTRAL_OCR_URL, ({ request }) => {
        capturedAuth.push(request.headers.get('Authorization') ?? '');
        return HttpResponse.json(MISTRAL_SUCCESS);
      }),
    );

    await callMistralOcr(MOCK_PDF_PATH);

    expect(capturedAuth).toHaveLength(2);
    expect(capturedAuth[0]).toBe('Bearer my-secret-key');
    expect(capturedAuth[1]).toBe('Bearer my-secret-key');
  });

  it('throws ExternalServiceError (503) for missing API key', async () => {
    mockGetConfig.mockReturnValue('');

    await expect(callMistralOcr(MOCK_PDF_PATH)).rejects.toThrow(ExternalServiceError);
    await expect(callMistralOcr(MOCK_PDF_PATH)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('throws ExternalServiceError (503) if the Files API upload fails', async () => {
    mockGetConfig.mockReturnValue('test-key');
    server.use(
      http.post(MISTRAL_FILES_URL, () =>
        HttpResponse.json({ error: 'Bad Request' }, { status: 400 }),
      ),
    );

    const err = await callMistralOcr(MOCK_PDF_PATH).catch((e) => e);
    expect(err).toBeInstanceOf(ExternalServiceError);
    expect(err.statusCode).toBe(503);
  });

  it('throws ExternalServiceError (503) for 401 — maps to "Invalid API key" message', async () => {
    mockGetConfig.mockReturnValue('bad-key');
    server.use(
      http.post(MISTRAL_OCR_URL, () =>
        HttpResponse.json({ message: 'Unauthorized' }, { status: 401 }),
      ),
    );

    const err = await callMistralOcr(MOCK_PDF_PATH).catch((e) => e);
    expect(err).toBeInstanceOf(ExternalServiceError);
    expect(err.statusCode).toBe(503);
    expect(err.message).toMatch(/invalid mistral api key/i);
  });

  it('throws ExternalServiceError (422) for 400 — PDF rejected by Mistral', async () => {
    mockGetConfig.mockReturnValue('test-key');
    server.use(
      http.post(MISTRAL_OCR_URL, () =>
        HttpResponse.json({ message: 'Invalid PDF' }, { status: 400 }),
      ),
    );

    const err = await callMistralOcr(MOCK_PDF_PATH).catch((e) => e);
    expect(err).toBeInstanceOf(ExternalServiceError);
    expect(err.statusCode).toBe(422);
  });

  it('throws ExternalServiceError (422) for 422 from Mistral', async () => {
    mockGetConfig.mockReturnValue('test-key');
    server.use(
      http.post(MISTRAL_OCR_URL, () =>
        HttpResponse.json({ message: 'Unprocessable' }, { status: 422 }),
      ),
    );

    const err = await callMistralOcr(MOCK_PDF_PATH).catch((e) => e);
    expect(err).toBeInstanceOf(ExternalServiceError);
    expect(err.statusCode).toBe(422);
  });

  it('throws ExternalServiceError (503) for other 4xx', async () => {
    mockGetConfig.mockReturnValue('test-key');
    server.use(
      http.post(MISTRAL_OCR_URL, () =>
        HttpResponse.json({ message: 'Forbidden' }, { status: 403 }),
      ),
    );

    const err = await callMistralOcr(MOCK_PDF_PATH).catch((e) => e);
    expect(err).toBeInstanceOf(ExternalServiceError);
    expect(err.statusCode).toBe(503);
  });

  it('throws ExternalServiceError (503) for 5xx', async () => {
    mockGetConfig.mockReturnValue('test-key');
    server.use(
      http.post(MISTRAL_OCR_URL, () =>
        HttpResponse.json({ message: 'Internal error' }, { status: 500 }),
      ),
    );

    const err = await callMistralOcr(MOCK_PDF_PATH).catch((e) => e);
    expect(err).toBeInstanceOf(ExternalServiceError);
    expect(err.statusCode).toBe(503);
  });

  it('sends include_image_base64: true in the request body', async () => {
    mockGetConfig.mockReturnValue('test-mistral-key');
    let capturedBody: unknown = null;

    server.use(
      http.post(MISTRAL_OCR_URL, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(MISTRAL_SUCCESS);
      }),
    );

    await callMistralOcr(MOCK_PDF_PATH);

    expect(capturedBody).toMatchObject({ include_image_base64: true });
  });

  it('collects images from each page in the Mistral response', async () => {
    mockGetConfig.mockReturnValue('test-mistral-key');
    const page0Image = { id: 'img-0.jpeg', image_base64: 'aGVsbG8=' };
    const page1Image = { id: 'img-1.png', image_base64: 'd29ybGQ=' };

    server.use(
      http.post(MISTRAL_OCR_URL, () =>
        HttpResponse.json({
          ...MISTRAL_SUCCESS,
          pages: [
            { index: 0, markdown: '# Page One\n\nFirst page content.', images: [page0Image] },
            { index: 1, markdown: '## Section\n\nSecond page content.', images: [page1Image] },
          ],
        }),
      ),
    );

    const result = await callMistralOcr(MOCK_PDF_PATH);

    expect(result.images).toEqual([page0Image, page1Image]);
  });

  it('returns empty images array when pages have no images field', async () => {
    mockGetConfig.mockReturnValue('test-mistral-key');

    const result = await callMistralOcr(MOCK_PDF_PATH);

    expect(result.images).toEqual([]);
  });

  it('sends new quality params in request body', async () => {
    mockGetConfig.mockReturnValue('test-mistral-key');
    let capturedBody: unknown = null;

    server.use(
      http.post(MISTRAL_OCR_URL, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(MISTRAL_SUCCESS);
      }),
    );

    await callMistralOcr(MOCK_PDF_PATH);

    expect(capturedBody).toMatchObject({
      include_image_base64: true,
      extract_header: true,
      extract_footer: true,
      table_format: 'html',
      image_min_size: 100,
    });
  });

  it('returns pages array from response', async () => {
    mockGetConfig.mockReturnValue('test-mistral-key');
    const pageWithExtras = {
      index: 0,
      markdown: '# Doc\n\nSome text.',
      images: [],
      tables: [{ id: 'tbl-0', html: '<table><tr><td>A</td></tr></table>' }],
      hyperlinks: [{ url: 'https://example.com', text: 'Example' }],
      header: 'My Journal',
      footer: 'Page 1 of 10',
    };

    server.use(
      http.post(MISTRAL_OCR_URL, () =>
        HttpResponse.json({
          pages: [pageWithExtras],
          model: 'mistral-ocr-4-0',
          usage_info: { pages_processed: 1 },
        }),
      ),
    );

    const result = await callMistralOcr(MOCK_PDF_PATH);

    expect(result.pages).toHaveLength(1);
    const page = result.pages[0]!;
    expect(page.tables).toEqual(pageWithExtras.tables);
    expect(page.hyperlinks).toEqual(pageWithExtras.hyperlinks);
    expect(page.header).toBe('My Journal');
    expect(page.footer).toBe('Page 1 of 10');
  });

  it('handles pages with null header/footer and missing tables/hyperlinks gracefully', async () => {
    mockGetConfig.mockReturnValue('test-mistral-key');

    server.use(
      http.post(MISTRAL_OCR_URL, () =>
        HttpResponse.json({
          pages: [{ index: 0, markdown: '# Doc', header: null, footer: null }],
          model: 'mistral-ocr-4-0',
          usage_info: { pages_processed: 1 },
        }),
      ),
    );

    const result = await callMistralOcr(MOCK_PDF_PATH);

    expect(result.pages).toHaveLength(1);
    const page = result.pages[0]!;
    expect(page.header).toBeNull();
    expect(page.footer).toBeNull();
    expect(page.tables).toBeUndefined();
    expect(page.hyperlinks).toBeUndefined();
  });
});
