# Module 21 — Authentication

**Status**: Done
**Last verified against code**: 2026-07 (source-available release prep)
**Schema tables**: none (stateless sessions)
**Unimplemented sections**: none

## Purpose

Built-in single-user authentication so the app is safe by default regardless of
how it is deployed (bare `docker run`, `npm start`, behind any proxy). Replaces
the reverse-proxy basic-auth requirement; the reverse proxy's role shrinks to
TLS termination.

## Mechanism

- **Request gate**: `src/proxy.ts` (Next.js proxy, runs on every request).
  Accepts either a valid session cookie or a valid `Authorization: Basic`
  header. Unauthenticated API requests get `401` JSON (+ `WWW-Authenticate`);
  page requests redirect to `/login?next=<path+query>` (query preserved for
  deep links / the mobile save flow). Wrong-password Basic headers count
  toward the same per-IP throttle as login attempts. The proxy marks `/login`
  requests with an internal header so the root layout renders it bare —
  no sidebar data (feed names, counts) is fetched or serialized for
  unauthenticated visitors.
- **Sessions**: stateless HMAC-signed tokens (`<expiryMs>.<hmac-sha256>`), no
  DB table. The signing key is derived from `SETTINGS_ENCRYPTION_KEY` +
  `SETTINGS_AUTH_HASH`, so changing the password invalidates all sessions.
  Lifetime 30 days. Cookie: `gleanary_session`, httpOnly, SameSite=Lax,
  Secure on HTTPS.
- **Password**: the existing `SETTINGS_AUTH_HASH` bcrypt hash (same password
  as settings confirmation). `verifySettingsPassword()` delegates to
  `verifyPassword()` in `src/lib/auth.ts`.
- **Basic auth**: username is ignored; the password part is bcrypt-compared
  (scheme match is case-insensitive). Successful headers are cached in memory
  (sha256 of header+hash → timestamp, 1h TTL, capped) so the browser extension
  doesn't pay ~100ms bcrypt per request; a password rotation invalidates the
  cache.
- **Throttling**: 5 failed logins per IP per 15 minutes → `429` (in-memory,
  swept, capped).
- **Escape hatch**: `AUTH_DISABLED=true` disables the gate entirely (for
  VPN/Tailscale-only deployments); logs a one-time warning.
- **Safe by default**: when `SETTINGS_AUTH_HASH` / `SETTINGS_ENCRYPTION_KEY`
  are missing, the app still blocks and `POST /api/auth/login` returns `503`
  with setup instructions.

## API contract

### POST /api/auth/login

- Body: `{ password: string }` (Zod: `loginSchema` in `src/lib/validators.ts`)
- `200` `{ ok: true }` + `Set-Cookie: gleanary_session=…`
- `403` wrong password · `422` invalid body · `429` throttled ·
  `503` auth env vars missing

### POST /api/auth/logout

- `200` `{ ok: true }` + expired session cookie
- UI caller: the "Sign out" button in Settings → General → Account. The
  section only renders when auth is active: `GET /api/settings` reports
  `authActive` (`isAuthConfigured() && !isAuthDisabled()`), so it is hidden
  for `AUTH_DISABLED` (VPN/Tailscale) deployments.

### Public (unauthenticated) paths

`/login`, `/api/auth/login`, `/api/auth/logout` (an expired session must
still be clearable), `/api/health`, and static assets (`sw.js` must be public
— service workers cannot register through a redirect).

## Clients

- **Web**: `/login` page sets the session cookie; all browser fetches ride on
  it. Settings → General → Account has a "Sign out" button that POSTs
  `/api/auth/logout` and hard-navigates back to `/login`.
- **Browser extension / iOS Shortcut**: unchanged wire format —
  `Authorization: Basic base64(anyuser:password)`. The extension defaults the
  username to `reader` when left blank, and its "Test connection" verifies
  credentials against the gated `/api/tags` (since `/api/health` is public).

## E2E

The Playwright suite runs with `AUTH_DISABLED=true` by default (webServer env).
Set `E2E_AUTH_PASSWORD` to run against real auth: the config derives a matching
`SETTINGS_AUTH_HASH` for the spawned server, `e2e/auth.setup.ts` logs in and
shares the session via storage state (`e2e/.auth/`, gitignored), and
`e2e/auth.spec.ts` (login journey) un-skips. Auth mode is intended for CI: on a
machine whose `.env` defines `SETTINGS_AUTH_HASH`, @next/env $-expands (and so
destroys) the injected bcrypt hash.

## Edge cases

- Passwords containing `:` work (split on first colon only).
- `next` param on `/login` only honors same-origin relative paths.
- Client IP comes from `x-forwarded-for`/`x-real-ip` (spoofable without a
  trusted proxy — throttle map is size-capped to bound memory under spray).
