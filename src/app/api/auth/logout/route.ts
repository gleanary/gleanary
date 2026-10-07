import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME, isSecureRequest, sessionCookieOptions } from '@/lib/auth';

/**
 * End the current session by clearing the session cookie.
 * Public path: must work even when the session is already invalid/expired.
 * @param req - The incoming request
 * @returns 200 with an expired Set-Cookie header
 */
export async function POST(req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, '', {
    ...sessionCookieOptions(isSecureRequest(req)),
    maxAge: 0,
  });
  return res;
}
