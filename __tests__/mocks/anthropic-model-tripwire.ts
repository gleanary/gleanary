import type { SetupServer } from 'msw/node';
import { ACTIVE_MODEL_IDS } from './active-models';

/** The only Anthropic endpoint whose `model` the tripwire inspects (exact match). */
export const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

let pending: Promise<void>[] = [];
let violations: string[] = [];

/**
 * Returns the request's `model` when it is a POST to /v1/messages naming a
 * model outside ACTIVE_MODEL_IDS, else null. Non-JSON bodies, bodies without a
 * `model`, other methods, other endpoints and other hosts are ignored.
 *
 * @param request - An unread request (pass a clone; the body is consumed)
 * @returns The offending model id, or null when the request is fine/out of scope
 */
export async function inactiveModelOf(request: Request): Promise<string | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || `${url.origin}${url.pathname}` !== MESSAGES_URL) return null;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null || !('model' in body)) return null;
  const { model } = body;
  return typeof model === 'string' && ACTIVE_MODEL_IDS.has(model) ? null : String(model);
}

/**
 * Subscribes the model tripwire to the shared MSW server: every request is
 * inspected at `request:start` (before any handler reads the body) via a
 * clone, and inactive models are recorded for `assertNoInactiveModelRequests`.
 *
 * @param server - The shared MSW server from server.ts
 * @returns void
 */
export function installAnthropicModelTripwire(server: SetupServer): void {
  server.events.on('request:start', ({ request }) => {
    pending.push(
      inactiveModelOf(request.clone()).then((model) => {
        if (model !== null) violations.push(model);
      }),
    );
  });
}

/**
 * Awaits every in-flight body read, then returns and clears the recorded
 * violations. Exported for the tripwire's own self-tests.
 *
 * @returns Inactive model ids sent to /v1/messages since the last drain
 */
export async function drainModelViolations(): Promise<string[]> {
  while (pending.length > 0) {
    const batch = pending;
    pending = [];
    await Promise.all(batch);
  }
  const found = violations;
  violations = [];
  return found;
}

/**
 * Throws if any request since the last drain sent a non-active model to
 * /v1/messages. Called from the global `afterEach` so the offending test fails.
 *
 * @returns Resolves when no violation was recorded
 */
export async function assertNoInactiveModelRequests(): Promise<void> {
  const found = await drainModelViolations();
  if (found.length > 0) {
    throw new Error(
      `Anthropic model tripwire: POST ${MESSAGES_URL} sent non-active model(s) ` +
        `${[...new Set(found)].join(', ')}. Use an id from ACTIVE_MODEL_IDS ` +
        `(__tests__/mocks/active-models.ts); retired ids 404 in production.`,
    );
  }
}
