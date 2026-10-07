import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { http, HttpResponse } from 'msw';
import { setupHandlers } from '../mocks/server';
import { readFileSync } from 'fs';
import { join } from 'path';

const richHtml = readFileSync(join(__dirname, '../mocks/fixtures/rich-article.html'), 'utf-8');

// Prevent real DNS lookups (fake test domains hang in dns.resolve4)
vi.mock('dns/promises', () => ({
  default: { resolve4: vi.fn().mockResolvedValue([]), resolve6: vi.fn().mockResolvedValue([]) },
}));

// --- DB mock setup (same pattern as other integration tests) ---

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

// Import route handler after mock setup
import { POST as parseArticle } from '@/app/api/articles/parse/route';

// --- MSW setup: direct fetch + Jina Reader ---

const spaShellHtml =
  '<html><head><title>My SPA</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';

let jinaHit = false;

setupHandlers(
  // SSRF probe: catches any attempt to reach Jina with a 127.0.0.1 URL
  http.get(/^https:\/\/r\.jina\.ai\/http:\/\/127\.0\.0\.1/, () => {
    jinaHit = true;
    return new HttpResponse('<html><body><p>Leaked internal content</p></body></html>', {
      headers: { 'Content-Type': 'text/html' },
    });
  }),

  // Public URL that 302s to a private IP
  http.get(
    'https://example.com/redirects-to-private',
    () => new HttpResponse(null, { status: 302, headers: { Location: 'http://10.0.0.1/secret' } }),
  ),
  http.get(
    'http://10.0.0.1/secret',
    () =>
      new HttpResponse('<html><body>Secret</body></html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
  ),

  // Direct fetch handlers (Phase 1: server-side fetch + Defuddle)
  http.get('https://example.com/blog/2024/web-architecture', () => {
    return new HttpResponse(richHtml, {
      headers: { 'Content-Type': 'text/html' },
    });
  }),
  http.get('https://example.com/spa-page', () => {
    return new HttpResponse(spaShellHtml, {
      headers: { 'Content-Type': 'text/html' },
    });
  }),
  http.get('https://example.com/bot-protected', () => {
    return new HttpResponse(null, { status: 403 });
  }),
  // 403 with a substantive HTML error body — regression test for prefetched-ok bug
  http.get('https://example.com/bot-protected-with-body', () => {
    const errorHtml = `<html><head><title>403 Forbidden</title></head><body>
      <h1>403 Forbidden</h1>
      <p>You don't have permission to access this resource on this server. ${'Lorem ipsum dolor sit amet, '.repeat(40)}</p>
      </body></html>`;
    return new HttpResponse(errorHtml, { status: 403, headers: { 'Content-Type': 'text/html' } });
  }),
  http.get('https://example.com/direct-fetch-fails', () => {
    return HttpResponse.error();
  }),
  http.get('https://example.com/jina-fails', () => {
    return HttpResponse.error();
  }),

  // Jina Reader API — fallback (Phase 2)
  // x-respond-with: html returns plain HTML body (not JSON)
  http.get(/^https:\/\/r\.jina\.ai\//, ({ request }) => {
    const url = request.url;
    if (url.includes('/bot-protected-with-body')) {
      const html = `<html><head><title>Recovered Bot Article</title></head><body>
        <article><h1>Recovered Bot Article</h1>
        <p>A non-2xx HTML error page was returned by the origin, but Jina recovered the real article.</p>
        <p>This is the real article content fetched via Jina headless browser.</p>
        </article></body></html>`;
      return new HttpResponse(html, { headers: { 'Content-Type': 'text/html' } });
    }
    if (url.includes('/bot-protected')) {
      const html = `<html><head><title>Bot Protected Article</title></head><body>
        <article><h1>Bot Protected Article</h1>
        <p>An article behind a bot wall.</p>
        <p>This is the article content fetched via Jina.</p>
        </article></body></html>`;
      return new HttpResponse(html, { headers: { 'Content-Type': 'text/html' } });
    }
    if (url.includes('/spa-page')) {
      const html = `<html><head><title>My SPA App</title></head><body>
        <article><h1>My SPA App</h1>
        <p>A single-page application.</p>
        <p>This is the rendered SPA content fetched via Jina headless browser.</p>
        </article></body></html>`;
      return new HttpResponse(html, { headers: { 'Content-Type': 'text/html' } });
    }
    if (url.includes('/direct-fetch-fails')) {
      const html = `<html><head><title>Recovered Article</title></head><body>
        <article><h1>Recovered Article</h1>
        <p>Article recovered via Jina after direct fetch failed.</p>
        <p>This content was recovered via Jina after direct fetch failed.</p>
        </article></body></html>`;
      return new HttpResponse(html, { headers: { 'Content-Type': 'text/html' } });
    }
    if (url.includes('/jina-fails')) {
      return new HttpResponse(null, { status: 429 });
    }
    return new HttpResponse(null, { status: 404 });
  }),
);

// --- Helpers ---

function jsonReq(method: string, url: string, body?: object) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
      : {}),
  });
}

describe('POST /api/articles/parse', () => {
  beforeEach(() => {
    jinaHit = false;
    dbMock.setup();
  });

  it('parses a URL via direct fetch + Defuddle with rich metadata', async () => {
    const res = await parseArticle(
      jsonReq('POST', '/api/articles/parse', {
        url: 'https://example.com/blog/2024/web-architecture',
      }),
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.article.title).toBe('Understanding Modern Web Architecture');
    expect(body.article.url).toBe('https://example.com/blog/2024/web-architecture');
    expect(body.article.contentHtml).toBeDefined();
    expect(body.article.contentText).toBeDefined();
    expect(body.article.contentOriginalHtml).toBeDefined();
    expect(body.article.contentMarkdown).toBeDefined();
    expect(body.article.contentMarkdown.length).toBeGreaterThan(0);
    expect(body.article.wordCount).toBeGreaterThan(0);
    expect(body.article.status).toBe('inbox');
    // Direct fetch + Defuddle extracts rich metadata that Jina misses
    expect(body.article.author).toBe('Jane Smith');
    expect(body.article.siteName).toBe('Tech Blog');
  });

  it('creates article from provided HTML (browser extension mode)', async () => {
    const res = await parseArticle(
      jsonReq('POST', '/api/articles/parse', {
        url: 'https://example.com/extension-test',
        html: richHtml,
      }),
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.article.title).toBe('Understanding Modern Web Architecture');
    expect(body.article.author).toBe('Jane Smith');
  });

  it('returns 409 when URL already exists', async () => {
    await parseArticle(
      jsonReq('POST', '/api/articles/parse', {
        url: 'https://example.com/blog/2024/web-architecture',
      }),
    );

    const res = await parseArticle(
      jsonReq('POST', '/api/articles/parse', {
        url: 'https://example.com/blog/2024/web-architecture',
      }),
    );
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.existingId).toBeTypeOf('number');
  });

  it('returns 422 for missing url', async () => {
    const res = await parseArticle(jsonReq('POST', '/api/articles/parse', {}));
    expect(res.status).toBe(422);
  });

  it('returns 422 for invalid url', async () => {
    const res = await parseArticle(jsonReq('POST', '/api/articles/parse', { url: 'not-a-url' }));
    expect(res.status).toBe(422);
  });

  it('falls back to Jina when direct fetch returns SPA shell', async () => {
    const res = await parseArticle(
      jsonReq('POST', '/api/articles/parse', {
        url: 'https://example.com/spa-page',
      }),
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    // Jina fallback returns the rendered SPA content
    expect(body.article.title).toBe('My SPA App');
    expect(body.article.contentHtml).toContain('rendered SPA content');
  });

  it('falls back to Jina when direct fetch fails with HTTP error', async () => {
    const res = await parseArticle(
      jsonReq('POST', '/api/articles/parse', {
        url: 'https://example.com/bot-protected',
      }),
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    // Jina fallback succeeds for bot-protected pages
    expect(body.article.title).toBe('Bot Protected Article');
    expect(body.article.contentHtml).toContain('article content fetched via Jina');
  });

  it('falls back to Jina when direct fetch throws network error', async () => {
    const res = await parseArticle(
      jsonReq('POST', '/api/articles/parse', {
        url: 'https://example.com/direct-fetch-fails',
      }),
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.article.title).toBe('Recovered Article');
    expect(body.article.contentHtml).toContain('recovered via Jina');
  });

  it('links article to sourceId when provided', async () => {
    const { POST: createSource } = await import('@/app/api/sources/route');
    await createSource(
      jsonReq('POST', '/api/sources', {
        type: 'browser_extension',
        name: 'Test Extension',
      }),
    );

    const res = await parseArticle(
      jsonReq('POST', '/api/articles/parse', {
        url: 'https://example.com/blog/2024/web-architecture',
        sourceId: 1,
      }),
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.article.sourceId).toBe(1);
  });

  it('respects custom status', async () => {
    const res = await parseArticle(
      jsonReq('POST', '/api/articles/parse', {
        url: 'https://example.com/blog/2024/web-architecture',
        status: 'reading',
      }),
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.article.status).toBe('reading');
  });

  it('sanitizes HTML content (no script tags in stored content)', async () => {
    const res = await parseArticle(
      jsonReq('POST', '/api/articles/parse', {
        url: 'https://example.com/blog/2024/web-architecture',
      }),
    );
    const body = await res.json();
    expect(body.article.contentHtml).not.toContain('<script');
  });

  it('fetches bot-protected articles transparently via Jina', async () => {
    const res = await parseArticle(
      jsonReq('POST', '/api/articles/parse', {
        url: 'https://example.com/bot-protected',
      }),
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.article.title).toBe('Bot Protected Article');
    expect(body.article.contentHtml).toContain('article content fetched via Jina');
    expect(body.article.contentOriginalHtml).toBeDefined();
    expect(body.article.contentMarkdown).toBeDefined();
    expect(body.article.wordCount).toBeGreaterThan(0);
  });

  it('returns 502 when Jina fails', async () => {
    const res = await parseArticle(
      jsonReq('POST', '/api/articles/parse', {
        url: 'https://example.com/jina-fails',
      }),
    );
    expect(res.status).toBe(503);
  });

  it('falls back to Jina when origin returns 403 with an HTML error body', async () => {
    // Regression: previously the prefetched buffer was passed to parseArticleFromUrl
    // with ok hardcoded to true, so a substantive HTML error page got parsed as the article.
    const res = await parseArticle(
      jsonReq('POST', '/api/articles/parse', {
        url: 'https://example.com/bot-protected-with-body',
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.article.title).toBe('Recovered Bot Article');
    expect(body.article.contentHtml).toContain('real article content fetched via Jina');
    expect(body.article.contentHtml).not.toContain('403 Forbidden');
  });

  it('rejects private-IP URLs and does not fall back to Jina', async () => {
    const res = await parseArticle(
      jsonReq('POST', '/api/articles/parse', { url: 'http://127.0.0.1:8080/admin' }),
    );
    expect(res.status).toBe(422);
    expect(jinaHit).toBe(false);
    const body = await res.json();
    expect(body.error).toMatch(/internal|private|allowed/i);
  });

  it('rejects URLs that redirect to a private IP', async () => {
    const res = await parseArticle(
      jsonReq('POST', '/api/articles/parse', {
        url: 'https://example.com/redirects-to-private',
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/private|internal|allowed/i);
  });
});
