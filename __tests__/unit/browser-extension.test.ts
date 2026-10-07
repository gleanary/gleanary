import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import {
  isValidTabUrl,
  saveArticle,
  checkHealth,
  normalizeBaseUrl,
} from '../../extension/lib/api-client.js';

// vi.restoreAllMocks() (per-describe afterEach) resets the mock but does NOT undo
// vi.stubGlobal, so the fetch stub outlives this file and would exempt later files
// from the MSW tripwire. Unstub globals once after every test in this file.
afterAll(() => {
  vi.unstubAllGlobals();
});

const API_BASE = 'https://reader.example.com';

describe('normalizeBaseUrl', () => {
  it('strips single trailing slash', () => {
    expect(normalizeBaseUrl('https://example.com/')).toBe('https://example.com');
  });

  it('strips multiple trailing slashes', () => {
    expect(normalizeBaseUrl('https://example.com///')).toBe('https://example.com');
  });

  it('leaves URL without trailing slash unchanged', () => {
    expect(normalizeBaseUrl('https://example.com')).toBe('https://example.com');
  });
});

describe('isValidTabUrl', () => {
  it('accepts http URLs', () => {
    expect(isValidTabUrl('http://example.com/article')).toBe(true);
  });

  it('accepts https URLs', () => {
    expect(isValidTabUrl('https://example.com/article')).toBe(true);
  });

  it('rejects chrome:// URLs', () => {
    expect(isValidTabUrl('chrome://extensions')).toBe(false);
  });

  it('rejects chrome-extension:// URLs', () => {
    expect(isValidTabUrl('chrome-extension://abc123/popup.html')).toBe(false);
  });

  it('rejects about: URLs', () => {
    expect(isValidTabUrl('about:blank')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidTabUrl('')).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isValidTabUrl(undefined as unknown as string)).toBe(false);
  });

  it('rejects invalid URLs', () => {
    expect(isValidTabUrl('not-a-url')).toBe(false);
  });

  it('rejects javascript: URLs', () => {
    expect(isValidTabUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects data: URLs', () => {
    expect(isValidTabUrl('data:text/html,<h1>Hi</h1>')).toBe(false);
  });

  it('rejects file: URLs', () => {
    expect(isValidTabUrl('file:///etc/passwd')).toBe(false);
  });
});

describe('saveArticle', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends URL to /api/articles/parse and returns created', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 201,
      json: () => Promise.resolve({ article: { id: 42 } }),
    });

    const result = await saveArticle(API_BASE, 'https://example.com/article');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://reader.example.com/api/articles/parse',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/article' }),
      }),
    );
    expect(result).toEqual({ status: 'created', articleId: 42 });
  });

  it('includes HTML when provided', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 201,
      json: () => Promise.resolve({ article: { id: 43 } }),
    });

    await saveArticle(API_BASE, 'https://example.com/article', '<html><body>Content</body></html>');

    const call = mockFetch.mock.calls[0]!;
    const body = JSON.parse(call[1].body);
    expect(body.html).toBe('<html><body>Content</body></html>');
  });

  it('returns duplicate status on 409', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 409,
      json: () => Promise.resolve({ error: 'Article with this URL already exists' }),
    });

    const result = await saveArticle(API_BASE, 'https://example.com/article');
    expect(result).toEqual({ status: 'duplicate' });
  });

  it('returns error with message on 422', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 422,
      json: () => Promise.resolve({ error: 'Validation failed' }),
    });

    const result = await saveArticle(API_BASE, 'https://example.com/article');
    expect(result).toEqual({ status: 'error', error: 'Validation failed' });
  });

  it('returns error with message on 502', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 502,
      json: () => Promise.resolve({ error: 'External service unavailable' }),
    });

    const result = await saveArticle(API_BASE, 'https://example.com/article');
    expect(result).toEqual({ status: 'error', error: 'External service unavailable' });
  });

  it('returns generic error when response body is not JSON', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 500,
      json: () => Promise.reject(new Error('not JSON')),
    });

    const result = await saveArticle(API_BASE, 'https://example.com/article');
    expect(result).toEqual({ status: 'error', error: 'Server error (500)' });
  });

  it('strips trailing slashes from API base URL', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 201,
      json: () => Promise.resolve({ article: { id: 1 } }),
    });

    await saveArticle('https://reader.example.com/', 'https://example.com/article');

    const call = mockFetch.mock.calls[0]!;
    expect(call[0]).toBe('https://reader.example.com/api/articles/parse');
  });

  it('rejects HTML larger than 5MB', async () => {
    const hugeHtml = 'x'.repeat(5 * 1024 * 1024 + 1);

    const result = await saveArticle(API_BASE, 'https://example.com/article', hugeHtml);

    expect(result).toEqual({ status: 'error', error: 'Page HTML exceeds 5MB limit' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('checkHealth', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when health and the auth probe both respond 200', async () => {
    mockFetch.mockResolvedValue({ ok: true });

    const result = await checkHealth(API_BASE);
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://reader.example.com/api/health',
      expect.objectContaining({ method: 'GET' }),
    );
    // /api/health is public, so credentials are verified against a gated endpoint
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://reader.example.com/api/tags',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('returns false when the server is unreachable (health non-200)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });

    const result = await checkHealth(API_BASE);
    expect(result).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns false when credentials are rejected by the gated endpoint', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false });

    const result = await checkHealth(API_BASE, { username: 'reader', password: 'wrong' });
    expect(result).toBe(false);
  });

  it('strips trailing slashes from API base URL', async () => {
    mockFetch.mockResolvedValue({ ok: true });

    await checkHealth('https://reader.example.com///');

    const call = mockFetch.mock.calls[0]!;
    expect(call[0]).toBe('https://reader.example.com/api/health');
  });
});
