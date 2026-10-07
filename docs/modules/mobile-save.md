# Module 10: Mobile Save

**Status**: Done
**Last verified against code**: 2026-04 (docs reconciliation)
**Schema tables**: `articles` (via API — no direct DB access)
**Unimplemented sections**: none

## Purpose

Enable saving articles from mobile devices via three mechanisms: a save page with manual URL input, Android PWA share target, and iOS Shortcut. Also improves URL-only article parsing by attempting direct server-side fetch + Defuddle before falling back to Jina Reader API.

## Dependencies

- Module 2: Article Parser (`src/lib/article-parser.ts`) — extended with direct-fetch path
- Module 8: Browser Extension — shares the same `POST /api/articles/parse` endpoint
- shadcn/ui components (`Button`, `Input`)

## Components

### 1. Improved URL-only parsing

**Current behavior:** `parseArticleFromUrl(url)` delegates entirely to Jina Reader API, which returns limited metadata (title, excerpt only — no author, siteName, imageUrl, publishedAt).

**New behavior:** Two-phase strategy:

1. Direct server-side fetch via `safeFetchText(url)` → parse with `parseArticleFromHtml(html, url)` (Defuddle)
2. If Phase 1 fails (network error, SPA shell, sparse content < 50 words) → fall back to Jina

**SPA shell detection:** Regex patterns on raw HTML before JSDOM instantiation:

- `<div id="root"></div>` or `<div id="app"></div>` (empty mount points)
- `<noscript>...enable javascript...</noscript>` with minimal surrounding content

**SSRF:** No new attack surface — `safeFetchText` already calls `validateUrl()`.

### 2. Save page (`/save`)

**Route:** `src/app/save/page.tsx` (client component)

**Inputs:**

- `?url=` query parameter (optional) — auto-fills and auto-saves on mount
- Manual URL text input

**Behavior:**

1. If `?url=` param present → auto-fill input, immediately call save
2. User can also paste a URL manually and tap "Save"
3. Calls `POST /api/articles/parse` with `{ url }`
4. Shows status: saving → saved (with reader link) / duplicate / error

**Auth:** Same-origin requests pass through Caddy basic auth automatically.

### 3. PWA (Android Share Target)

**Files:**

- `src/app/manifest.ts` — Web App Manifest with `share_target` config
- `public/sw.js` — Minimal service worker (fetch passthrough, no caching)
- `public/icons/icon-{192,512}.png` — App icons

**Share target config:**

```json
{
  "action": "/save",
  "method": "GET",
  "params": { "url": "url" }
}
```

When user shares a URL on Android → OS opens `/save?url=<shared_url>` → save page handles it.

**Service worker:** No caching. Exists solely for PWA installability. `skipWaiting()` + `clients.claim()` for immediate activation.

### 4. iOS Shortcut instructions

Displayed as a collapsible section on the `/save` page.

**Option A (recommended):** Shortcut opens `https://<domain>/save?url=[Shortcut Input]` in Safari. Uses existing Caddy auth session.

**Option B (advanced):** Shortcut POSTs directly to `/api/articles/parse` with Basic Auth header. Background save, no browser redirect.

## API Contract

No new API endpoints. Uses existing `POST /api/articles/parse`:

```
POST /api/articles/parse
Content-Type: application/json

{ "url": "https://example.com/article" }

→ 201 { "article": { "id": 1, "title": "...", ... } }
→ 409 { "error": "Article with this URL already exists" }
→ 422 { "error": "..." }  (invalid URL)
→ 502 { "error": "..." }  (external service failure)
```

## Edge Cases

- **SPA/JS-heavy pages:** Direct fetch returns empty shell → word count < 50 triggers Jina fallback
- **Bot-protected pages:** Direct fetch returns challenge page → `isBotChallengeContent()` or sparse content triggers Jina fallback
- **Both paths fail:** Returns 502 (ExternalServiceError)
- **Duplicate URL:** Returns 409 regardless of save mechanism
- **PWA not installed:** Share target unavailable; user falls back to manual paste
- **Caddy auth expired:** User sees basic auth prompt before save page loads
- **Invalid URL in query param:** Zod validation returns 422; save page shows error
