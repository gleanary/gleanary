import { describe, it, expect, afterEach, vi } from 'vitest';
import { headers } from '../../next.config';

/** Extracts the global Content-Security-Policy header value from a `headers()` result. */
async function getGlobalCsp(headersFn: typeof headers): Promise<string> {
  const rules = await headersFn();
  const global = rules.find((r) => r.source === '/(.*)');
  return global?.headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
}

describe('CSP headers', () => {
  it('serves a Content-Security-Policy on all routes', async () => {
    const csp = await getGlobalCsp(headers);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('worker-src');
    expect(csp).toContain('blob:');
    expect(csp).toContain('style-src');
    expect(csp).toContain("'unsafe-inline'");
    expect(csp).toContain('script-src');
    expect(csp).toContain("'self'");
  });
});

describe('CSP script-src in production', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("allows framework inline hydration scripts via 'unsafe-inline' and no hash/nonce", async () => {
    // next.config computes script-src at import time, so import a fresh copy under
    // the production env to exercise the production branch.
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { headers: prodHeaders } = await import('../../next.config');

    const csp = await getGlobalCsp(prodHeaders);
    const scriptSrc = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('script-src'));

    expect(scriptSrc).toBeDefined();
    // Next.js App Router hydrates through its own dynamic inline scripts
    // (`self.__next_f.push(...)`), which cannot be hash-allowlisted. They only run
    // under 'unsafe-inline'.
    expect(scriptSrc).toContain("'unsafe-inline'");
    // Per the CSP spec, any hash or nonce in script-src makes the browser IGNORE
    // 'unsafe-inline', so the hashes must be REMOVED, not merely accompanied.
    expect(scriptSrc).not.toContain('sha256-');
    expect(scriptSrc).not.toContain('nonce-');
  });
});
