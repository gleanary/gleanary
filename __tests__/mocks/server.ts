import { beforeEach } from 'vitest';
import type { RequestHandler } from 'msw';
import { setupServer } from 'msw/node';

/**
 * Shared MSW server for all vitest files, wired into vitest `setupFiles` via
 * `msw-setup.ts` with `onUnhandledRequest: 'error'` — any request without an
 * explicit handler fails the test instead of hitting the real network.
 *
 * It starts with no default handlers on purpose: a canned catch-all response
 * would let a test that forgets its mock pass green on nonsense. Register
 * per-file handlers with `setupHandlers(...)` below; reserve raw
 * `server.use(...)` for per-test overrides inside `it` bodies.
 */
export const server = setupServer();

/**
 * Registers the given handlers on the shared server before every test in the
 * calling file. Registration must happen per test — not in `beforeAll` or at
 * module scope — because the global `afterEach` resets all handlers; this
 * helper makes that mistake unrepresentable.
 *
 * @param handlers - MSW request handlers to apply for each test
 * @returns void
 */
export function setupHandlers(...handlers: RequestHandler[]): void {
  beforeEach(() => server.use(...handlers));
}
