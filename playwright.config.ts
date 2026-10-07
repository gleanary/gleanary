import { defineConfig, devices } from '@playwright/test';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import bcrypt from 'bcryptjs';

/**
 * Session state written by auth.setup.ts (empty when auth is disabled).
 * Lives outside test-results/, which Playwright wipes at the start of each run.
 */
export const STORAGE_STATE = 'e2e/.auth/state.json';

/**
 * Auto-detect a Playwright-installed Chromium binary.
 * Checks PLAYWRIGHT_CHROMIUM_PATH env var first, then searches the cache.
 */
function findChromium(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  if (!existsSync('/root/.cache/ms-playwright')) {
    return undefined;
  }
  try {
    const result = execSync(
      'find /root/.cache/ms-playwright -name "chrome" -path "*/chrome-linux/*" 2>/dev/null | head -1',
      { encoding: 'utf-8' },
    ).trim();
    return result || undefined;
  } catch {
    return undefined;
  }
}

const chromiumPath = findChromium();

// CI serves the production build (ci.yml runs `npm run build` first); fail fast
// with a clear message instead of a webServer health-check timeout — or worse,
// silently testing a stale bundle — when the build step was skipped.
if (process.env.CI && !existsSync('.next/BUILD_ID')) {
  throw new Error('CI E2E runs against the production build — run `npm run build` first.');
}

const chromeUse = {
  ...devices['Desktop Chrome'],
  // Use detected Chromium binary (sandboxed/web environments)
  ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // CI: 2 retries for flaky tests; local: 1 retry to handle SQLite contention under parallel load
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    // The app registers public/sw.js; service-worker-mediated fetches bypass
    // page.route stubs. No journey tests offline/PWA behavior, so block it.
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      use: chromeUse,
    },
    {
      name: 'chromium',
      dependencies: ['setup'],
      use: {
        ...chromeUse,
        storageState: STORAGE_STATE,
      },
    },
  ],
  webServer: {
    // CI tests the production bundle: ci.yml runs `npm run build` before Playwright.
    // Both scripts migrate first via their pre-script (idempotent, drizzle-kit-compatible).
    command: process.env.CI ? 'npm run start' : 'npm run dev',
    // Surface migrate.mjs progress and next dev logs (Playwright default swallows stdout)
    stdout: 'pipe',
    url: 'http://localhost:3000/api/health',
    reuseExistingServer: !process.env.CI,
    env: {
      ...(process.env as Record<string, string>),
      // With E2E_AUTH_PASSWORD set, run against real auth: the matching hash is
      // derived here (single source of truth) and AUTH_DISABLED is forced off.
      // Otherwise the spawned server runs with auth disabled.
      // Caveats: none of this applies to a reused (already running) server, and
      // on machines whose .env also defines SETTINGS_AUTH_HASH the injected hash
      // gets $-expanded (destroyed) by @next/env — auth mode is intended for CI.
      ...(process.env.E2E_AUTH_PASSWORD
        ? {
            SETTINGS_AUTH_HASH: bcrypt.hashSync(process.env.E2E_AUTH_PASSWORD, 10),
            AUTH_DISABLED: '',
          }
        : { AUTH_DISABLED: 'true' }),
    },
  },
});
