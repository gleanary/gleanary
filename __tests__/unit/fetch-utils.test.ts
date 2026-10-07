import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { ValidationError, ExternalServiceError } from '@/lib/errors';

// Mock dns.resolve4 to control SSRF validation without real DNS lookups
vi.mock('dns/promises', () => ({
  default: {
    resolve4: vi.fn(),
    resolve6: vi.fn().mockResolvedValue([]),
  },
}));

import dns from 'dns/promises';
import { safeFetch } from '@/lib/fetch-utils';

const mockResolve4 = vi.mocked(dns.resolve4);

type RouteMap = Record<string, Response>;

/** Installs a global.fetch mock that dispatches by URL. Unknown URLs get a 200 OK. */
function mockFetch(routes: RouteMap): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      return Promise.resolve(routes[url] ?? new Response('OK', { status: 200 }));
    }),
  );
  return calls;
}

describe('safeFetch redirect handling', () => {
  beforeEach(() => {
    mockResolve4.mockResolvedValue(['93.184.216.34']); // public IP by default
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('follows a redirect from a public URL to another public URL', async () => {
    const calls = mockFetch({
      'https://example.com/page': new Response(null, {
        status: 301,
        headers: { location: 'https://example.com/final' },
      }),
    });

    const res = await safeFetch('https://example.com/page');
    expect(res.status).toBe(200);
    expect(calls).toEqual(['https://example.com/page', 'https://example.com/final']);
  });

  it('rejects a redirect that resolves to a private IP', async () => {
    mockResolve4.mockImplementation((hostname: string) => {
      if (hostname === '10.0.0.1') return Promise.resolve(['10.0.0.1']);
      return Promise.resolve(['93.184.216.34']);
    });

    const calls = mockFetch({
      'https://example.com/page': new Response(null, {
        status: 302,
        headers: { location: 'http://10.0.0.1/secret' },
      }),
    });

    await expect(safeFetch('https://example.com/page')).rejects.toThrow(ValidationError);
    expect(calls).not.toContain('http://10.0.0.1/secret');
  });

  it('rejects a redirect to a literal private IP (127.0.0.1)', async () => {
    mockFetch({
      'https://example.com/page': new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/admin' },
      }),
    });

    await expect(safeFetch('https://example.com/page')).rejects.toThrow(ValidationError);
  });

  it('throws after exactly 3 redirects are followed', async () => {
    let count = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        count++;
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: `https://example.com/step${count}` },
          }),
        );
      }),
    );

    const err = await safeFetch('https://example.com/start').catch((e) => e);
    expect(err).toBeInstanceOf(ExternalServiceError);
    expect(err.message).toMatch(/Too many redirects/);
    // initial + 3 followed redirects = 4 calls; the 4th response triggers the cap before a 5th fetch
    expect(vi.mocked(global.fetch).mock.calls.length).toBe(4);
  });

  it('resolves relative Location headers against the current URL', async () => {
    const calls = mockFetch({
      'https://example.com/old-path': new Response(null, {
        status: 301,
        headers: { location: '/new-path' },
      }),
    });

    await safeFetch('https://example.com/old-path');
    expect(calls).toContain('https://example.com/new-path');
  });
});
