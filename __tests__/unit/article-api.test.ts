import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { uploadPdf, parseArticleByUrl } from '@/lib/article-api';

const mockFetch = vi.fn();

function mockResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeAll(() => {
  // Stub after the global MSW setup patches fetch in its beforeAll — this file
  // tests client-side relative-URL fetches, which MSW cannot intercept in Node.
  vi.stubGlobal('fetch', mockFetch);
});

beforeEach(() => {
  mockFetch.mockReset();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('uploadPdf', () => {
  it('returns ok:true with article on 201 response', async () => {
    const article = { id: 42, title: 'My PDF', extractionTier: 'mistral' };
    mockFetch.mockResolvedValue(mockResponse(201, { article }));
    const result = await uploadPdf(new File([], 'doc.pdf', { type: 'application/pdf' }));
    expect(result).toEqual({ ok: true, duplicate: false, article });
  });

  it('returns duplicate:true with existingId on 409 with body', async () => {
    mockFetch.mockResolvedValue(mockResponse(409, { existingId: 7 }));
    const result = await uploadPdf(new File([], 'doc.pdf', { type: 'application/pdf' }));
    expect(result).toEqual({ ok: false, duplicate: true, existingId: 7 });
  });

  it('returns duplicate:true with no existingId on 409 with empty body', async () => {
    mockFetch.mockResolvedValue(mockResponse(409, {}));
    const result = await uploadPdf(new File([], 'doc.pdf', { type: 'application/pdf' }));
    expect(result).toEqual({ ok: false, duplicate: true, existingId: undefined });
  });

  it('returns ok:false with error message on 422 with error body', async () => {
    mockFetch.mockResolvedValue(mockResponse(422, { error: 'PDF is encrypted' }));
    const result = await uploadPdf(new File([], 'doc.pdf', { type: 'application/pdf' }));
    expect(result).toEqual({ ok: false, duplicate: false, error: 'PDF is encrypted' });
  });

  it('returns ok:false with generic error on non-ok status with non-JSON body', async () => {
    mockFetch.mockResolvedValue({
      status: 500,
      ok: false,
      json: () => Promise.reject(new Error('not json')),
    } as unknown as Response);
    const result = await uploadPdf(new File([], 'doc.pdf', { type: 'application/pdf' }));
    expect(result).toEqual({ ok: false, duplicate: false, error: 'Error 500' });
  });

  it('returns ok:false with network error message when fetch rejects', async () => {
    mockFetch.mockRejectedValue(new Error('Failed to fetch'));
    const result = await uploadPdf(new File([], 'doc.pdf', { type: 'application/pdf' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Network error/);
  });
});

describe('parseArticleByUrl', () => {
  it('returns duplicate:true with existingId on 409 with body', async () => {
    mockFetch.mockResolvedValue(mockResponse(409, { existingId: 99 }));
    const result = await parseArticleByUrl('https://example.com/dup');
    expect(result).toEqual({ ok: false, duplicate: true, existingId: 99 });
  });

  it('returns duplicate:true with undefined existingId on 409 with empty body', async () => {
    mockFetch.mockResolvedValue(mockResponse(409, {}));
    const result = await parseArticleByUrl('https://example.com/dup');
    expect(result).toEqual({ ok: false, duplicate: true, existingId: undefined });
  });
});
