import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';

/**
 * Guards the global MSW tripwire wired into vitest setupFiles: every test file
 * runs under the shared server with `onUnhandledRequest: 'error'`, so a test
 * that forgets a mock can never silently hit the real network.
 */
describe('global MSW tripwire', () => {
  it('serves requests registered on the shared server', async () => {
    server.use(
      http.get('https://tripwire.invalid/mocked', () => HttpResponse.json({ mocked: true })),
    );

    const res = await fetch('https://tripwire.invalid/mocked');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mocked: true });
  });

  it('rejects unhandled requests instead of hitting the real network', async () => {
    const error = await fetch('https://tripwire.invalid/unmocked').then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    // The MSW 'error' strategy surfaces as the cause of undici's "fetch failed" —
    // a plain DNS failure on the .invalid domain would not match this message.
    expect(String((error as Error).cause ?? error)).toMatch(/\[MSW\]|request handler/i);
  });
});
