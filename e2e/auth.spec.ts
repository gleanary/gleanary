import { test, expect, type Page } from '@playwright/test';

/** Log in through the UI with E2E_AUTH_PASSWORD and wait until off /login. */
async function loginViaUi(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-password-input').fill(process.env.E2E_AUTH_PASSWORD!);
  await page.getByTestId('login-submit-button').click();
  await expect(page).not.toHaveURL(/\/login/);
}

/**
 * Login journey — runs only against an auth-enabled server
 * (E2E_AUTH_PASSWORD set, matching SETTINGS_AUTH_HASH).
 */
test.describe('authentication', () => {
  test.skip(!process.env.E2E_AUTH_PASSWORD, 'requires E2E_AUTH_PASSWORD (auth-enabled server)');

  // Start these tests without the shared logged-in session
  test.use({ storageState: { cookies: [], origins: [] } });

  test('redirects unauthenticated visitor to login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId('login-password-input')).toBeVisible();
  });

  test('rejects a wrong password', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('login-password-input').fill('definitely-wrong-password');
    await page.getByTestId('login-submit-button').click();
    await expect(page.getByTestId('login-error')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('logs in with the correct password and lands on the app', async ({ page }) => {
    await loginViaUi(page);
  });

  test('blocks API requests without credentials', async ({ request }) => {
    const res = await request.get('/api/articles');
    expect(res.status()).toBe(401);
  });

  test('allows API requests with Basic auth (extension flow)', async ({ request }) => {
    const credentials = Buffer.from(`reader:${process.env.E2E_AUTH_PASSWORD}`).toString('base64');
    const res = await request.get('/api/articles', {
      headers: { Authorization: `Basic ${credentials}` },
    });
    expect(res.ok()).toBe(true);
  });

  test('signs out from Settings and is redirected to login', async ({ page }) => {
    // Log in fresh (this describe block runs without the shared session)
    await loginViaUi(page);

    await page.goto('/settings');
    await page.getByTestId('sign-out-button').click();
    await expect(page).toHaveURL(/\/login/);

    // Session is really gone: a protected page bounces back to login
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });
});
