import { NextRequest, NextResponse } from 'next/server';
import {
  LOGIN_PAGE_HEADER,
  SESSION_COOKIE_NAME,
  getClientIp,
  isAuthDisabled,
  isLoginThrottled,
  registerLoginFailure,
  verifyBasicAuthHeader,
  verifySessionToken,
} from '@/lib/auth';
import { logger } from '@/lib/logger';

/** Paths reachable without authentication. */
const PUBLIC_PATHS = new Set(['/login', '/api/auth/login', '/api/auth/logout', '/api/health']);

let warnedAuthDisabled = false;

/** Continue the request, never trusting a client-supplied login-page marker. */
function passThrough(req: NextRequest, markLoginPage = false): NextResponse {
  if (!markLoginPage && !req.headers.has(LOGIN_PAGE_HEADER)) return NextResponse.next();
  const requestHeaders = new Headers(req.headers);
  if (markLoginPage) requestHeaders.set(LOGIN_PAGE_HEADER, '1');
  else requestHeaders.delete(LOGIN_PAGE_HEADER);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

/**
 * Request gate: every request must carry a valid session cookie or a valid
 * `Authorization: Basic` header (browser extension / API clients), unless the
 * path is public or AUTH_DISABLED=true (VPN/Tailscale-only deployments).
 *
 * Unauthenticated API requests get 401 JSON; page requests redirect to /login.
 * @param req - Incoming request
 * @returns NextResponse continuing, redirecting, or rejecting the request
 */
export default async function proxy(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  if (isAuthDisabled()) {
    if (!warnedAuthDisabled) {
      warnedAuthDisabled = true;
      logger.warn(
        { event: 'auth_disabled' },
        'AUTH_DISABLED=true — the app is served without authentication. Only use this behind a VPN/private network.',
      );
    }
    return passThrough(req, pathname === '/login');
  }

  if (PUBLIC_PATHS.has(pathname)) return passThrough(req, pathname === '/login');

  const session = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (session && verifySessionToken(session)) return passThrough(req);

  const authorization = req.headers.get('authorization');
  if (authorization) {
    // Same per-IP throttle as the login endpoint: bounds brute force and the
    // ~100ms bcrypt cost of each wrong-password header.
    const ip = getClientIp(req) ?? 'unknown';
    if (!isLoginThrottled(ip)) {
      if (await verifyBasicAuthHeader(authorization)) return passThrough(req);
      registerLoginFailure(ip);
    }
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Gleanary"' } },
    );
  }

  const loginUrl = new URL('/login', req.url);
  if (pathname !== '/' || req.nextUrl.search) {
    loginUrl.searchParams.set('next', pathname + req.nextUrl.search);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Skip Next.js internals and static assets; everything else is gated.
  // sw.js must be public: service workers cannot register through a redirect.
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|icon\\.svg|manifest\\.webmanifest|sw\\.js|icons/).*)',
  ],
};
