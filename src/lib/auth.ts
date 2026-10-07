import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { NextRequest } from 'next/server';
import { isEncryptionAvailable } from '@/lib/settings-crypto';

/** Name of the session cookie set on successful login. */
export const SESSION_COOKIE_NAME = 'gleanary_session';

/**
 * Request header set by the proxy on /login requests so the root layout
 * renders the bare (shell-less) layout without fetching sidebar data.
 */
export const LOGIN_PAGE_HEADER = 'x-gleanary-login-page';

/** Session lifetime: 30 days. */
export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

/** Login throttling: max failures per IP within the window. */
const MAX_LOGIN_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURES_SWEEP_SIZE = 1000;

/** Cache of successfully verified Basic auth headers (sha256 → verifiedAt ms). */
const basicAuthCache = new Map<string, number>();
const BASIC_AUTH_CACHE_TTL_MS = 60 * 60 * 1000;
const BASIC_AUTH_CACHE_MAX_SIZE = 100;

/** Per-IP login failure tracking (fixed window). */
const loginFailures = new Map<string, { count: number; windowStart: number }>();

/**
 * Whether auth is explicitly disabled via AUTH_DISABLED=true (VPN/Tailscale-only setups).
 * @returns true if the escape hatch is active
 */
export function isAuthDisabled(): boolean {
  return process.env.AUTH_DISABLED === 'true';
}

/**
 * Whether the two env vars required for authentication are present and valid.
 * @returns true if SETTINGS_AUTH_HASH and a valid SETTINGS_ENCRYPTION_KEY are set
 */
export function isAuthConfigured(): boolean {
  return isEncryptionAvailable() && Boolean(process.env.SETTINGS_AUTH_HASH);
}

/**
 * Whether authentication is actually enforced: configured and not disabled.
 * The canonical "is auth on?" predicate (used to gate auth-only UI like Sign out).
 * @returns true if login/session enforcement is active
 */
export function isAuthActive(): boolean {
  return isAuthConfigured() && !isAuthDisabled();
}

let signingKeyCache: { encKey: string; authHash: string; key: Buffer } | null = null;

/**
 * Derive the HMAC signing key for session tokens (memoized on its env inputs).
 * Includes SETTINGS_AUTH_HASH so a password change invalidates existing sessions.
 * @returns Signing key buffer, or null when auth is unconfigured
 */
function getSigningKey(): Buffer | null {
  const encKey = process.env.SETTINGS_ENCRYPTION_KEY;
  const authHash = process.env.SETTINGS_AUTH_HASH;
  if (!encKey || !authHash) return null;
  if (
    !signingKeyCache ||
    signingKeyCache.encKey !== encKey ||
    signingKeyCache.authHash !== authHash
  ) {
    signingKeyCache = {
      encKey,
      authHash,
      key: createHash('sha256').update(`${encKey}:${authHash}:session-v1`).digest(),
    };
  }
  return signingKeyCache.key;
}

function signExpiry(exp: number, key: Buffer): string {
  return createHmac('sha256', key).update(String(exp)).digest('hex');
}

/**
 * Create an HMAC-signed session token of the form `<expiryMs>.<signature>`.
 * @param now - Issue time in ms (defaults to Date.now(); injectable for tests)
 * @returns The signed token
 * @throws Error when auth is not configured
 */
export function createSessionToken(now: number = Date.now()): string {
  const key = getSigningKey();
  if (!key) {
    throw new Error('Cannot create session: SETTINGS_AUTH_HASH / SETTINGS_ENCRYPTION_KEY not set');
  }
  const exp = now + SESSION_DURATION_MS;
  return `${exp}.${signExpiry(exp, key)}`;
}

/**
 * Verify a session token's signature and expiry.
 * @param token - Token from the session cookie
 * @param now - Current time in ms (injectable for tests)
 * @returns true if the token is authentic and unexpired
 */
export function verifySessionToken(token: string, now: number = Date.now()): boolean {
  const key = getSigningKey();
  if (!key || !token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp <= now) return false;
  const expected = Buffer.from(signExpiry(exp, key), 'hex');
  const actual = Buffer.from(token.slice(dot + 1), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Cookie attributes for the session cookie — single source for set (login)
 * and clear (logout), which must agree on path to work.
 * @param secure - Whether to set the Secure flag (https requests)
 * @returns Options for NextResponse.cookies.set
 */
export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    maxAge: SESSION_DURATION_MS / 1000,
    path: '/',
  };
}

/**
 * Compare a plaintext password against the SETTINGS_AUTH_HASH bcrypt hash.
 * @param password - Candidate password
 * @returns true if the password matches; false when wrong or unconfigured
 */
export async function verifyPassword(password: string): Promise<boolean> {
  const authHash = process.env.SETTINGS_AUTH_HASH;
  if (!authHash) return false;
  return bcrypt.compare(password, authHash);
}

/**
 * Verify an `Authorization: Basic ...` header against the app password.
 * The username part is ignored (any value works — e.g. "reader").
 * Successful verifications are cached in memory to avoid a bcrypt compare
 * (~100ms) on every request from the browser extension.
 * @param header - Full Authorization header value
 * @returns true if the embedded password is correct
 */
export async function verifyBasicAuthHeader(header: string): Promise<boolean> {
  if (!/^basic /i.test(header)) return false;
  // Key includes the hash so a password rotation invalidates cached headers too
  const authHash = process.env.SETTINGS_AUTH_HASH ?? '';
  const cacheKey = createHash('sha256').update(`${header}\n${authHash}`).digest('hex');
  const cachedAt = basicAuthCache.get(cacheKey);
  if (cachedAt !== undefined) {
    if (Date.now() - cachedAt < BASIC_AUTH_CACHE_TTL_MS) return true;
    basicAuthCache.delete(cacheKey);
  }
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const colon = decoded.indexOf(':');
  if (colon === -1) return false;
  const valid = await verifyPassword(decoded.slice(colon + 1));
  if (valid) {
    if (basicAuthCache.size >= BASIC_AUTH_CACHE_MAX_SIZE) basicAuthCache.clear();
    basicAuthCache.set(cacheKey, Date.now());
  }
  return valid;
}

/**
 * Whether an IP has exceeded the login failure limit for the current window.
 * @param ip - Client IP (or 'unknown')
 * @param now - Current time in ms (injectable for tests)
 * @returns true if further login attempts should be rejected with 429
 */
export function isLoginThrottled(ip: string, now: number = Date.now()): boolean {
  const entry = loginFailures.get(ip);
  if (!entry) return false;
  if (now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginFailures.delete(ip);
    return false;
  }
  return entry.count >= MAX_LOGIN_FAILURES;
}

/**
 * Record a failed login attempt for an IP.
 * @param ip - Client IP (or 'unknown')
 * @param now - Current time in ms (injectable for tests)
 */
export function registerLoginFailure(ip: string, now: number = Date.now()): void {
  // Bound memory under spoofed-IP spray: sweep expired windows once the map grows,
  // and fail open (clear) rather than grow without bound if the spray is all in-window
  if (loginFailures.size >= LOGIN_FAILURES_SWEEP_SIZE) {
    for (const [key, value] of loginFailures) {
      if (now - value.windowStart > LOGIN_WINDOW_MS) loginFailures.delete(key);
    }
    if (loginFailures.size >= LOGIN_FAILURES_SWEEP_SIZE * 2) loginFailures.clear();
  }
  const entry = loginFailures.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginFailures.set(ip, { count: 1, windowStart: now });
    return;
  }
  entry.count += 1;
}

/**
 * Reset the failure counter for an IP after a successful login.
 * @param ip - Client IP (or 'unknown')
 */
export function clearLoginFailures(ip: string): void {
  loginFailures.delete(ip);
}

/**
 * Clear all in-memory auth caches (Basic auth cache + login throttling). For tests.
 */
export function clearAuthCaches(): void {
  basicAuthCache.clear();
  loginFailures.clear();
  signingKeyCache = null;
}

/**
 * Extract the client IP from request headers.
 * @param req - The incoming request
 * @returns Client IP string or null
 */
export function getClientIp(req: NextRequest): string | null {
  const forwarded = req.headers.get('x-forwarded-for');
  // First hop of the comma-separated list (client-supplied — best-effort identity)
  if (forwarded) return forwarded.split(',')[0]!.trim() || null;
  return req.headers.get('x-real-ip');
}

/**
 * Whether the request arrived over HTTPS (directly or via a proxy).
 * @param req - The incoming request
 * @returns true when the session cookie should carry the Secure flag
 */
export function isSecureRequest(req: NextRequest): boolean {
  const proto = req.headers.get('x-forwarded-proto');
  if (proto) return proto.split(',')[0]!.trim() === 'https';
  return req.nextUrl.protocol === 'https:';
}
