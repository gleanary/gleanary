# Module 2: Article Parser

**Status**: Done
**Last verified against code**: 2026-04 (docs session)
**Schema tables**: `articles`, `sources`
**Unimplemented sections**: none

## Purpose

Given a URL (or raw HTML + URL), fetch the page, extract clean readable content, sanitize the HTML, compute metadata, and save it as an article. This is the core ingestion pipeline used by the browser extension (Module 8) and RSS engine (Module 3).

## Dependencies

- `src/lib/sanitize.ts` — DOMPurify HTML sanitization (exists)
- `src/lib/url-validator.ts` — SSRF prevention (exists)
- `src/lib/fetch-utils.ts` — `safeFetchText()` with SSRF validation, timeout, and size limits
- `src/lib/errors.ts` — Custom error classes (exists)
- `src/lib/logger.ts` — Structured logging (exists)
- `src/lib/validators.ts` — Zod schemas (exists)
- `src/lib/html-to-markdown.ts` — `convertHtmlToMarkdown()` turndown wrapper (exists)
- `src/app/api/articles/route.ts` — Article creation API (exists)
- `defuddle` — Article content extraction (both paths)
- `jsdom` — Server-side DOM implementation (both paths)
- `turndown` — HTML-to-markdown conversion for AI context (`content_markdown` column)

## Architecture

### Library: `src/lib/article-parser.ts`

Pure library function with no DB dependency. Takes a URL or HTML and returns parsed article data.

```typescript
interface ParsedArticle {
  url: string;
  title: string;
  author: string | null;
  contentHtml: string; // sanitized via DOMPurify
  contentText: string; // plain text extraction
  contentOriginalHtml: string; // raw HTML before Defuddle extraction
  contentMarkdown: string; // turndown-converted markdown for AI context
  excerpt: string | null; // first ~200 chars or Defuddle description
  siteName: string | null;
  imageUrl: string | null; // lead image URL
  wordCount: number; // computed from contentText
  publishedAt: string | null; // extracted from meta tags if available
}
```

**Two entry points:**

1. `parseArticleFromUrl(url: string): Promise<ParsedArticle>` — Direct server-side fetch first (Defuddle), falls back to Jina Reader API for JS-heavy/bot-protected pages
2. `parseArticleFromHtml(html: string, url: string): Promise<ParsedArticle>` — Parses provided HTML with Defuddle + jsdom (for browser extension sending pre-fetched content from paywalled sites)

**Both paths converge on `runContentPipeline(rawHtml, url)`** — a shared private function that runs Defuddle → DOMPurify → turndown.

### Fetch Strategy

**Primary path (URL):** Tries a direct server-side fetch first (faster, richer metadata from Defuddle). If the page is an SPA shell, returns too little content, or the fetch fails, falls back to Jina Reader API.

**Jina fallback:** Uses `x-respond-with: html` header — Jina returns the page's rendered HTML body. This HTML goes through the same Defuddle → DOMPurify pipeline as the direct path.

**Shared pipeline (`runContentPipeline`):**

1. Parse HTML with `jsdom` to create a DOM
2. Run Defuddle to extract article content and metadata (title, author, published, site, image)
3. Sanitize HTML via `sanitizeArticleHtml()` (Defuddle resolves relative URLs internally)
4. Extract plain text for FTS and word count
5. Convert sanitized HTML to markdown via `convertHtmlToMarkdown()` for `content_markdown`

**Input HTML storage:** Both entry points store the raw input HTML as `contentOriginalHtml` before any extraction. For the Jina path, this is Jina's rendered HTML. For the HTML path, this is whatever the caller provided.

### API Route: `POST /api/articles/parse`

Accepts a URL (or URL + raw HTML), runs the parser, creates the article via the existing data layer, and returns the saved article.

## API Contract

### `POST /api/articles/parse`

Parse a URL and save it as an article. If the article URL already exists, returns the existing article (idempotent save).

**Request body:**

```typescript
{
  url: string;              // required — the article URL
  html?: string;            // optional — pre-fetched HTML (browser extension)
  sourceId?: number;        // optional — link to source (RSS feed, extension, etc.)
  status?: "inbox" | "reading" | "archived";  // default: "inbox"
}
```

**Response:** `201` with created article object (same shape as `GET /api/articles/[id]`).

**Errors:**

- `422` — Invalid URL or validation failure
- `409` — Article with this URL already exists (returns existing article ID)
- `502` — Failed to fetch the URL (timeout, DNS failure, etc.)
- `500` — Parsing failure or internal error

## Fetch Configuration

### Jina Reader path (fallback — `parseArticleFromUrl`):

- **Jina URL**: `https://r.jina.ai/{originalUrl}`
- **Headers**: `x-respond-with: html` (returns rendered HTML body, not JSON)
- **Timeout**: 60 seconds (Jina needs time for JS rendering)
- **SSRF**: Delegated to Jina (we validate the Jina URL itself via `safeFetchText`)
- **Bot challenge detection**: Parser detects Cloudflare-style challenge pages from Defuddle output

### Direct HTML path (`parseArticleFromHtml`):

- **No fetch needed** — HTML is provided by the caller (browser extension)
- **Relative URL resolution**: Handled internally by Defuddle
- **Metadata extraction**: Defuddle extracts author, published date, site name, image from meta tags and schema.org data

### Metadata differences between paths

| Field       | Jina path                     | HTML path                         |
| ----------- | ----------------------------- | --------------------------------- |
| title       | Extracted from Jina response  | Defuddle extraction               |
| author      | null (not provided by Jina)   | Defuddle (meta tags + schema.org) |
| siteName    | null (not provided by Jina)   | Defuddle (meta tags + schema.org) |
| imageUrl    | null (not provided by Jina)   | Defuddle (og:image + schema.org)  |
| publishedAt | null (not provided by Jina)   | Defuddle (meta tags + schema.org) |
| contentHtml | Markdown → marked → DOMPurify | Defuddle → DOMPurify              |
| contentText | Strip HTML tags               | Strip HTML tags                   |

## Edge Cases

1. **URL already saved**: Return `409` with existing article ID — don't re-parse
2. **Defuddle fails to extract** (HTML path): Fall back to page `<title>` for title, full body HTML for content
3. **Empty content**: If extraction yields no content, store with empty `contentHtml`/`contentText` and log warning
4. **Jina returns bot challenge page**: Detected and logged as warning; article saved with whatever content was returned
5. **Timeout/DNS failure**: Return `502` with "Failed to fetch URL" message
6. **Very large pages**: `safeFetchText` enforces size limits
7. **Relative URLs in content** (HTML path only): Defuddle resolves relative URLs internally
8. **Character encoding**: jsdom handles encoding detection (HTML path); Jina handles encoding (URL path)
9. **Paywalled content with provided HTML**: When `html` is provided, skip Jina, parse directly with Defuddle — this supports the browser extension use case where the user has access

## Security

- **SSRF**: Jina path — SSRF delegated to Jina service; the Jina URL itself is validated via `safeFetchText`. HTML path — no server-side fetch needed
- **XSS**: All extracted HTML sanitized via `sanitizeArticleHtml()` (DOMPurify) before storage
- **Input validation**: Zod schema on all API inputs
- **Timeout**: 60s fetch timeout for Jina path prevents resource exhaustion
- **Size limit**: Enforced via `safeFetchText` defaults
