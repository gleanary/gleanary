import { NextRequest, NextResponse } from 'next/server';
import { withRoute } from '@/lib/api-error-handler';
import { loginSchema } from '@/lib/validators';
import {
  clearLoginFailures,
  createSessionToken,
  getClientIp,
  isAuthConfigured,
  isLoginThrottled,
  isSecureRequest,
  registerLoginFailure,
  sessionCookieOptions,
  verifyPassword,
  SESSION_COOKIE_NAME,
} from '@/lib/auth';
import { logger } from '@/lib/logger';

/**
 * Authenticate with the app password and receive a session cookie.
 * @param req - JSON body: { password }
 * @returns 200 with Set-Cookie on success; 403 wrong password; 422 invalid
 *   body; 429 throttled; 503 when auth env vars are missing
 */
export const POST = withRoute('POST /api/auth/login', async (req: NextRequest) => {
  if (!isAuthConfigured()) {
    return NextResponse.json(
      {
        error:
          'Authentication is not configured. Set SETTINGS_AUTH_HASH and SETTINGS_ENCRYPTION_KEY (see README).',
      },
      { status: 503 },
    );
  }

  const ip = getClientIp(req) ?? 'unknown';
  if (isLoginThrottled(ip)) {
    logger.warn({ event: 'login_throttled', ip }, 'Login attempts throttled');
    return NextResponse.json(
      { error: 'Too many failed attempts. Try again in 15 minutes.' },
      { status: 429 },
    );
  }

  const { password } = loginSchema.parse(await req.json());

  const valid = await verifyPassword(password);
  if (!valid) {
    registerLoginFailure(ip);
    logger.warn({ event: 'login_failed', ip }, 'Failed login attempt');
    return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
  }

  clearLoginFailures(ip);
  logger.info({ event: 'login_succeeded', ip }, 'Login succeeded');

  const res = NextResponse.json({ ok: true });
  res.cookies.set(
    SESSION_COOKIE_NAME,
    createSessionToken(),
    sessionCookieOptions(isSecureRequest(req)),
  );
  return res;
});
