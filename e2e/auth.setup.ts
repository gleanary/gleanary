import { test as setup, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { STORAGE_STATE } from '../playwright.config';

/**
 * Prepares the shared session state for the E2E suite.
 * With E2E_AUTH_PASSWORD set (auth-enabled server), it logs in via the API
 * and saves the session cookie; otherwise (AUTH_DISABLED server) it writes
 * an empty state so specs run unauthenticated.
 */
setup('authenticate', async ({ request }) => {
  fs.mkdirSync(path.dirname(STORAGE_STATE), { recursive: true });

  const password = process.env.E2E_AUTH_PASSWORD;
  if (!password) {
    // Auth-disabled mode: verify the server really is open before writing empty state.
    // A reused dev server with auth enabled would otherwise fail every spec opaquely.
    const probe = await request.get('/api/tags');
    expect(
      probe.status(),
      'server requires auth — restart your dev server (the E2E config sets AUTH_DISABLED=true) or set E2E_AUTH_PASSWORD',
    ).not.toBe(401);
    fs.writeFileSync(STORAGE_STATE, JSON.stringify({ cookies: [], origins: [] }));
    return;
  }

  const res = await request.post('/api/auth/login', { data: { password } });
  expect(
    res.ok(),
    `login with E2E_AUTH_PASSWORD failed (HTTP ${res.status()}: ${await res.text()}) — a reused server's SETTINGS_AUTH_HASH may not match, and a local .env defining SETTINGS_AUTH_HASH $-mangles the injected hash (auth mode is intended for CI)`,
  ).toBe(true);
  await request.storageState({ path: STORAGE_STATE });
});
