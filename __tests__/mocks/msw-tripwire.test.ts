import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import { RETIRED_MODEL_ID } from './active-models';
import {
  MESSAGES_URL,
  assertNoInactiveModelRequests,
  drainModelViolations,
} from './anthropic-model-tripwire';
import { DEFAULT_CHAT_MODEL } from '@/lib/models';

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

// Self-tests for the global model tripwire installed by msw-setup.ts. Each test
// that sends an offending request drains the recorded violation itself, so the
// global afterEach stays green; a drain returning [] proves nothing was caught.

function postMessages(body: BodyInit, url = MESSAGES_URL): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
}

describe('Anthropic model tripwire', () => {
  it('records a /v1/messages request that sends the retired model', async () => {
    server.use(http.post(MESSAGES_URL, () => HttpResponse.json({ ok: true })));

    await postMessages(JSON.stringify({ model: RETIRED_MODEL_ID, messages: [] }));

    expect(await drainModelViolations()).toEqual([RETIRED_MODEL_ID]);
  });

  it('fails the check with a message naming the offending model', async () => {
    server.use(http.post(MESSAGES_URL, () => HttpResponse.json({ ok: true })));

    await postMessages(JSON.stringify({ model: RETIRED_MODEL_ID, messages: [] }));

    await expect(assertNoInactiveModelRequests()).rejects.toThrow(RETIRED_MODEL_ID);
    // The failed check drained its state: the next check (global afterEach) is clean
    await expect(assertNoInactiveModelRequests()).resolves.toBeUndefined();
  });

  it.each([
    ['the default chat model', DEFAULT_CHAT_MODEL],
    ['a dated apiId', 'claude-haiku-4-5-20251001'],
  ])('ignores an active model (%s)', async (_label, model) => {
    server.use(http.post(MESSAGES_URL, () => HttpResponse.json({ ok: true })));

    await postMessages(JSON.stringify({ model, messages: [] }));

    expect(await drainModelViolations()).toEqual([]);
  });

  it('ignores non-Anthropic hosts and other Anthropic endpoints', async () => {
    const otherHost = 'https://example.test/v1/messages';
    const countTokens = `${MESSAGES_URL}/count_tokens`;
    server.use(
      http.post(otherHost, () => HttpResponse.json({ ok: true })),
      http.post(countTokens, () => HttpResponse.json({ ok: true })),
    );
    const body = JSON.stringify({ model: RETIRED_MODEL_ID });

    await postMessages(body, otherHost);
    await postMessages(body, countTokens);

    expect(await drainModelViolations()).toEqual([]);
  });

  it('ignores non-POST requests to /v1/messages', async () => {
    server.use(http.get(MESSAGES_URL, () => HttpResponse.json({ ok: true })));

    const res = await fetch(`${MESSAGES_URL}?model=${RETIRED_MODEL_ID}`);

    expect(res.ok).toBe(true);
    expect(await drainModelViolations()).toEqual([]);
  });

  it('ignores bodies that are not JSON or have no model, without crashing', async () => {
    server.use(http.post(MESSAGES_URL, () => HttpResponse.json({ ok: true })));

    const responses = await Promise.all([
      postMessages('not json {'),
      postMessages(JSON.stringify({ messages: [] })),
      postMessages(JSON.stringify(null)),
    ]);

    expect(responses.every((r) => r.ok)).toBe(true);
    expect(await drainModelViolations()).toEqual([]);
  });

  it('leaves the request body readable by the handler', async () => {
    let seen: unknown;
    server.use(
      http.post(MESSAGES_URL, async ({ request }) => {
        seen = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );

    await postMessages(JSON.stringify({ model: DEFAULT_CHAT_MODEL, messages: [] }));

    expect(seen).toEqual({ model: DEFAULT_CHAT_MODEL, messages: [] });
    expect(await drainModelViolations()).toEqual([]);
  });
});
