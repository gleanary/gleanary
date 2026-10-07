# Content Pipeline Improvements

**Status**: Done
**Last verified against code**: 2026-05 (chunked reformat)
**Extends**: Module 2 (Article Parser), Module 7 (AI Features), Module 11 (Newsletter Ingestion)
**Schema tables**: `articles` (`content_original_html`, `content_markdown`, `ai_cleaned_at`); `ai_usage` (`run_id`)
**Unimplemented sections**: none
**Related ADRs**: [ADR-007](../adrs/ADR-007-mistral-for-reformat.md) (Mistral provider choice), [ADR-008](../adrs/ADR-008-partial-success-outcome-model-for-chunked-reformat.md) (partial-success outcome model)

## Problem

Article formatting degrades through the parsing pipeline. Two root causes:

1. **Jina URL path** returns markdown, which loses layout structure (grids become flat image sequences, carousels become linear text). Converting back to HTML via `marked` produces structurally flat output.
2. **Email/newsletter path** runs email HTML (table-based layouts, inline styles, tracking pixels) through Defuddle + DOMPurify, which strips the inline styles that hold email layouts together.

## Decisions

Five changes, implemented as a single feature branch:

### 1. Jina HTML mode

Switch the URL-only path from Jina's default markdown response to `x-respond-with: html`, which returns `documentElement.outerHTML`. This HTML then goes through the same Defuddle → DOMPurify pipeline as the browser extension path.

**Result**: Both the URL-only and browser extension paths produce the same quality output via the same extraction pipeline. Jina handles fetching + JS rendering + bot bypass; Defuddle handles content extraction.

### 2. Store original HTML (`content_original_html`)

Store the raw HTML before any content extraction, for all sources. This enables:

- Future re-processing when the extraction pipeline improves
- "Original view" toggle for newsletters
- Debugging parsing issues

For the Jina path, this is the full `outerHTML` returned by Jina. For the browser extension path, this is the HTML sent by the extension. For newsletters, this is the raw email HTML.

### 3. Store markdown (`content_markdown`)

Add a markdown column populated at save time, used exclusively as context for AI features (summarize, tag, explain, chat). Markdown is more compact and token-efficient than HTML.

- **Jina path**: Jina returns HTML now, so we convert `content_html` → markdown via `turndown` (or equivalent) after Defuddle extraction.
- **Defuddle path**: Same — convert the cleaned `content_html` to markdown.
- **Migration**: Backfill existing articles by converting their `content_html` to markdown.

All AI features (`src/lib/ai.ts`) switch from using `content_html`/`content_text` to `content_markdown` for context assembly.

### 4. AI cleanup on demand

Add an AI-powered content reformatting feature. Heuristics detect articles that likely have layout issues; the reader view shows a prompt to reformat. The AI-cleaned result replaces `content_html` (original is preserved in `content_original_html`).

### 5. Email preprocessing pipeline

Newsletters get a dedicated preprocessing step before Defuddle: unwrap layout tables, strip tracking pixels, collapse spacer elements, remove email scaffolding. Plus an "original view" toggle in the reader.

### 6. Shared HTML post-processor (Phase 2.5)

Deterministic transforms extracted from email preprocessing into `src/lib/html-post-processor.ts`, now applied to ALL ingestion paths (URL, Readwise, email) between Defuddle extraction and DOMPurify sanitization:

1. Remove 1×1 tracking pixels (known tracking domains/paths)
2. Strip empty/whitespace-only `<div>`, `<p>`, `<span>` elements
3. Unwrap layout tables (`role="presentation"` or 3+ nesting depth without `<th>`)
4. Wrap consecutive image sequences (4+) in `<div class="image-grid">`
5. Collapse nested wrapper divs with no semantic value

Email path keeps its own MSO-conditional stripping and `<td>`/`<tr>` spacer removal as a pre-step, then delegates to the shared `postProcessDocument()` on the same DOM (single JSDOM parse).

---

## Schema Changes

Three new columns on `articles`:

```typescript
// src/db/schema.ts — articles table additions
contentOriginalHtml: text('content_original_html'),  // raw HTML before extraction (all sources)
contentMarkdown: text('content_markdown'),            // markdown for AI features
aiCleanedAt: text('ai_cleaned_at'),                   // timestamp when AI cleanup was applied
```

**Column naming consistency** with existing schema:

| Existing                            | New                     | Pattern               |
| ----------------------------------- | ----------------------- | --------------------- |
| `content_html`                      | `content_original_html` | `content_{qualifier}` |
| `content_text`                      | `content_markdown`      | `content_{format}`    |
| `ai_summary`, `ai_tags`, `ai_index` | `ai_cleaned_at`         | `ai_{feature}`        |

**No `ai_cleaned_html` column.** When AI cleanup runs, it overwrites `content_html` directly. The original can always be recovered from `content_original_html` by re-running Defuddle + DOMPurify. The `ai_cleaned_at` timestamp tracks whether cleanup has been applied (null = not cleaned, timestamp = cleaned).

### Migration

```sql
ALTER TABLE articles ADD COLUMN content_original_html TEXT;
ALTER TABLE articles ADD COLUMN content_markdown TEXT;
ALTER TABLE articles ADD COLUMN ai_cleaned_at TEXT;
```

Backfill migration (runs as a one-time script or background job):

1. For all articles where `content_markdown IS NULL` and `content_html IS NOT NULL`:
   convert `content_html` → markdown via turndown and store in `content_markdown`.
2. `content_original_html` is NOT backfilled for existing articles (we don't have it).

### Types

```typescript
// src/types/index.ts additions
export type NewArticle = InferInsertModel<typeof articles>;
// (already inferred — no manual type changes needed, Drizzle picks up new columns)
```

---

## Pipeline Changes

### Current flow

```
URL path:    Jina (markdown) → marked (→ HTML) → DOMPurify → store contentHtml
HTML path:   browser extension HTML → Defuddle → DOMPurify → store contentHtml
Email path:  raw email HTML → Defuddle → DOMPurify → store contentHtml
```

### New flow

```
URL path:    Jina (x-respond-with: html)
                → store contentOriginalHtml
                → Defuddle → postProcessHtml() → DOMPurify → store contentHtml
                → turndown(contentHtml) → store contentMarkdown

HTML path:   browser extension HTML
                → store contentOriginalHtml
                → Defuddle → postProcessHtml() → DOMPurify → store contentHtml
                → turndown(contentHtml) → store contentMarkdown

Email path:  raw email HTML
                → store contentOriginalHtml
                → emailPreprocess(MSO + spacers) → postProcessDocument()
                → DOMPurify → store contentHtml
                → turndown(contentHtml) → store contentMarkdown

Readwise:    html_content from API
                → postProcessHtml() → DOMPurify → store contentHtml
                → turndown(contentHtml) → store contentMarkdown
```

All three paths converge on the same final steps: Defuddle → DOMPurify → turndown.

### Dependency changes

**Add**: `turndown` (HTML-to-markdown converter) — lightweight, well-maintained, used by Jina themselves.

**Remove**: `marked` — no longer needed in the article parser pipeline since Jina now returns HTML. Verify no other usages in the codebase before removing from `package.json`.

---

## Implementation Details

### 1. Article Parser Changes (`src/lib/article-parser.ts`)

#### `parseArticleFromUrl(url: string)`

```typescript
// Before:
// 1. Fetch from Jina (default markdown response)
// 2. Parse markdown for title/content
// 3. Convert markdown → HTML via marked
// 4. Sanitize HTML

// After:
// 1. Fetch from Jina with header: x-respond-with: html
// 2. Store raw response as contentOriginalHtml
// 3. Parse with Defuddle + jsdom (same as parseArticleFromHtml)
// 4. Sanitize HTML via DOMPurify
// 5. Convert sanitized HTML → markdown via turndown
```

This effectively merges both entry points into a shared extraction pipeline. The only difference is _where the HTML comes from_.

#### `parseArticleFromHtml(html: string, url: string)`

```typescript
// Before:
// 1. Parse with Defuddle + jsdom
// 2. Sanitize

// After:
// 1. Store raw HTML as contentOriginalHtml
// 2. Parse with Defuddle + jsdom
// 3. Sanitize
// 4. Convert sanitized HTML → markdown via turndown
```

#### Return type update

```typescript
interface ParsedArticle {
  url: string;
  title: string;
  author: string | null;
  contentHtml: string;
  contentText: string;
  contentMarkdown: string; // NEW
  contentOriginalHtml: string; // NEW
  excerpt: string | null;
  siteName: string | null;
  imageUrl: string | null;
  wordCount: number;
  publishedAt: string | null;
}
```

### 2. Email Preprocessing (`src/lib/email-preprocessor.ts`)

New library. Runs on raw email HTML **before** Defuddle extraction.

```typescript
/**
 * Preprocess email HTML for clean article extraction.
 * Strips email-specific scaffolding that confuses article extractors.
 */
export function preprocessEmailHtml(html: string): string;
```

Operations (in order):

1. **Strip tracking pixels**: Remove `<img>` tags where `width="1"` or `height="1"`, or whose `src` contains known tracking domains (e.g., `open.substack.com`, `email.mg.*`, `trk.*`).
2. **Unwrap layout tables**: Detect tables used for layout (not data). Heuristics: `role="presentation"`, single-column tables, tables with only `<td>` (no `<th>`), tables nested 3+ levels. Replace with their inner content.
3. **Strip spacer elements**: Remove empty `<td>`, `<tr>`, `<div>` elements that only contain `&nbsp;`, whitespace, or spacer GIFs.
4. **Remove MSO conditionals**: Strip `<!--[if mso]>...<![endif]-->` blocks.
5. **Collapse redundant wrappers**: Unwrap `<div>` and `<span>` elements that have no semantic value (no meaningful class, no text content other than their children).
6. **Preserve meaningful structure**: Keep `<blockquote>`, `<h1>`-`<h6>`, `<ul>`/`<ol>`, `<figure>`, `<a>`, `<img>` (non-tracking).

This runs before Defuddle, so Defuddle sees cleaner input and produces better extraction.

#### Integration point

In the newsletter IMAP poller (`src/lib/newsletter-poller.ts` or wherever email HTML is processed), add:

```typescript
import { preprocessEmailHtml } from '@/lib/email-preprocessor';

// Before passing to parseArticleFromHtml:
const cleanedEmailHtml = preprocessEmailHtml(rawEmailHtml);
const parsed = await parseArticleFromHtml(cleanedEmailHtml, articleUrl);
// contentOriginalHtml still stores the raw email HTML (set before preprocessing)
```

### 3. AI Cleanup Feature

> For articles over 35k chars, `POST /api/ai/clean` uses a parallel chunked path instead of a single call. See [Phase 4](#phase-4-parallel-chunking-for-long-articles) below.

#### Heuristic detection (`src/lib/content-quality.ts`)

```typescript
/**
 * Analyze parsed article content for potential layout/formatting issues.
 * Returns a score 0-100 where higher = more likely to have issues.
 */
export function detectFormattingIssues(contentHtml: string, source: SourceType): number;
```

Checks:

- **Consecutive images**: 4+ `<img>` tags without intervening text (likely a grid rendered as a list)
- **High empty-element ratio**: Many empty `<div>`, `<p>`, `<span>` elements relative to content
- **Table scaffolding residue**: `<table>` or `<tr>` tags without `<th>` (layout tables that survived cleanup)
- **HTML-to-text ratio**: Very high HTML size relative to `content_text` length (lots of markup, little content)
- **Source type bonus**: Newsletter source gets +20 to the score (emails almost always need cleanup)

Threshold: score >= 50 → flag for AI cleanup.

> **PDF articles**: `POST /api/ai/clean` has a separate branch for PDFs (OCR retry via Mistral, not Claude reformatting). See `docs/modules/pdf-import.md` §API contract.

#### API route: `POST /api/ai/clean`

```typescript
// Request
{
  articleId: number;
}

// Response 200
{
  contentHtml: string; // the AI-cleaned HTML
  contentMarkdown: string; // regenerated markdown from cleaned HTML
  provider: 'mistral' | 'anthropic'; // which provider produced this output
  fallback?: boolean; // true if primary failed and fallback succeeded
}
```

**Behavior**:

1. Fetch the article's `content_markdown` (or fall back to `content_html`)
2. Send to Claude with cleanup prompt (see below)
3. Claude returns restructured clean semantic HTML
4. Sanitize the HTML via DOMPurify
5. Convert sanitized HTML → markdown via turndown
6. Update `content_html`, `content_markdown`, and set `ai_cleaned_at` timestamp
7. Return the new content

**Claude prompt**:

```
You are a content formatter. Reformat this article into clean,
well-structured semantic HTML suitable for a reader application.

Rules:
- Preserve ALL text content, links, and image URLs. Do not summarize or omit.
- Convert sequences of images (logos, partner grids) into a simple list or
  remove if they are decorative and not part of the article content.
- Convert carousel/slideshow content into clearly separated sections
  using blockquotes with attribution.
- Remove decorative/spacer elements.
- Ensure proper heading hierarchy (h1 > h2 > h3).
- Use semantic HTML: <article>, <section>, <blockquote>, <figure>,
  <figcaption>, <ul>/<ol>, <p>, <h1>-<h6>.
- Do not include <style>, <script>, or inline style attributes.
- Output only the HTML body content. No commentary, no wrapping <html>
  or <body> tags.

Article content (markdown):
{contentMarkdown}
```

#### Provider strategy

> Long articles (>35k chars) fan out to multiple concurrent provider calls — one per chunk. See [Phase 4 § Per-chunk pipeline](#per-chunk-pipeline) for details.

`POST /api/ai/clean` (HTML branch — not the PDF OCR branch) uses a configurable
LLM provider with automatic fallback. See ADR-007 for the decision.

- **Primary**: Ministral 3 8B via Mistral's first-party API. ~10× cheaper on
  output than Haiku and ~1.5× faster sustained throughput. Intelligence Index
  is high enough for faithful structural HTML rewriting on the inputs observed
  (newsletter layouts, image grids, layout tables).
- **Fallback**: Claude Haiku — the original implementation. Used automatically
  when: Mistral returns 5xx / 429 (after 3 retries with exponential backoff),
  the Mistral API key is missing, or the Mistral response fails post-call
  validation (see below).
- **Selected by**: setting `reformat_provider` (default `mistral`).

#### Output validation

Before persisting the model's output as `content_html`:

1. Length must be within ±40 % of input length. Out-of-band outputs are rejected
   (likely truncation or runaway expansion).
2. After `sanitizeArticleHtml()`, the sanitized length must be ≥ 50 % of the
   raw model output. Significant drop indicates broken tag balance.

Both providers' outputs go through the same checks — a Mistral validation
failure triggers one fallback attempt to Haiku, and if the Haiku output also
fails validation (or is truncated at `max_tokens`) the reformat is rejected
with `422` and `content_html` is left untouched. The user sees a "Reformat
failed, content unchanged" banner.

The `ai_usage` row is written for every attempt (primary + fallback), so the
cost view shows the true spend even on failed paths. `feature` is `ai_clean`
for both providers; `model` distinguishes them.

#### Reader view integration

In the reader component, if `detectFormattingIssues() >= 50` and `ai_cleaned_at` is null:

```tsx
{
  qualityScore >= 50 && !article.aiCleanedAt && (
    <div className="...banner styles...">
      This article may have formatting issues.
      <button onClick={handleAiClean}>Reformat with AI</button>
    </div>
  );
}
```

For newsletter sources, consider auto-triggering cleanup on save (configurable via settings: `newsletter_auto_clean`).

### 4. Original View Toggle (Newsletters)

In the reader view, for articles where `source.type === 'newsletter'` and `content_original_html` is not null:

```tsx
<button onClick={() => setViewMode((v) => (v === 'clean' ? 'original' : 'clean'))}>
  {viewMode === 'clean' ? 'View original' : 'View clean'}
</button>
```

When `viewMode === 'original'`:

- Render `content_original_html` inside a sandboxed `<iframe>` or a `<div>` with `dangerouslySetInnerHTML` + DOMPurify (still sanitize — never render raw email HTML unsanitized)
- Disable highlighting in original view (position anchoring won't work)
- Remember the preference per newsletter source (store in `localStorage` keyed by `sourceId`, like Readwise does)

### 5. AI Features Adaptation (`src/lib/ai.ts`)

All existing functions that read article content for AI processing should prefer `content_markdown`:

```typescript
// Before:
const content = article.contentHtml || article.contentText;
const truncated = truncateContent(content);

// After:
const content = article.contentMarkdown || article.contentText;
const truncated = truncateContent(content);
```

Affected functions:

- `POST /api/ai/summarize` — article summarization
- `POST /api/ai/tag` — auto-tagging
- `POST /api/ai/explain` — highlight explanation
- `POST /api/ai/index` — concept index generation
- Chat retrieval context assembly (`src/lib/chat-retrieval.ts` or equivalent)

The `truncateContent()` function may need its character limit adjusted since markdown is more compact than HTML (likely can increase from ~100K chars).

---

## Edge Cases

1. **Jina returns HTML that Defuddle can't extract**: Fall back to using the full HTML body (same as current behavior when Defuddle fails on browser extension HTML). Log a warning.

2. **Turndown produces poor markdown**: For tables, code blocks, or complex HTML structures, turndown may lose fidelity. This is acceptable since `content_markdown` is only used for AI context, not rendering. The rendered view always uses `content_html`.

3. **AI cleanup produces worse output**: The user can re-trigger cleanup from `content_original_html` (effectively a "reset to original" then re-clean). Add a "Revert formatting" option when `ai_cleaned_at` is set, which re-runs Defuddle on `original_html`.

4. **`content_original_html` size**: The raw HTML is markup only (images/CSS/JS are external URL references, not inline data). A typical article page is 50-200KB of HTML, comparable to `content_html`. No size cap needed.

5. **Email preprocessor too aggressive**: If the preprocessor strips content that matters, the user can toggle to "original view". The preprocessor should err on the side of keeping content when uncertain.

6. **Existing articles without `content_original_html`**: Backfill is not possible (the original was never stored). These articles get `content_original_html = NULL`. The "original view" toggle is hidden when the column is null.

7. **Existing articles without `content_markdown`**: The migration backfills this from `content_html` via turndown. If `content_html` is also null, `content_markdown` stays null and AI features fall back to `content_text`.

8. **`marked` removal**: Verify `marked` is not imported anywhere else in the codebase (chat message rendering, etc.) before removing from `package.json`. If it has no other usages, remove it entirely.

9. **Mistral down or rate-limited**: After 3 retries with exponential backoff on 429s, fall back to Haiku for the same request Surface a warning banner in Settings if the fallback rate exceeds 10 % over 1 hour.

10. **Small-model structural drift**: Ministral 8B occasionally drops content, breaks tag balance, or paraphrases against the "preserve faithfully" instruction. Caught by the post-call validation (length bounds + sanitized length ratio). Failure triggers fallback to Haiku, not a quality regression.

11. **Mistral key absent**: When `reformat_provider = mistral` but no API key is set, silently fall back to Haiku and show a warning in Settings. The first-run experience works without configuration this way.

---

## Security

- **Original view (newsletters)**: Even in "original view", the HTML MUST be sanitized via `sanitizeArticleHtml()`. Never render raw `content_original_html` unsanitized. This applies whether using `dangerouslySetInnerHTML` or an `<iframe>`.
- **AI cleanup output**: The HTML returned by Claude must pass through DOMPurify before storage. Never store unsanitized AI output in `content_html`.
- **Email preprocessor**: Operates on HTML before sanitization — it is NOT a security boundary. DOMPurify remains the XSS prevention layer.
- **Turndown**: Runs on already-sanitized HTML, so no security concern for the conversion itself.
- **Jina HTML response**: The raw HTML from Jina is stored in `content_original_html` but never rendered directly. It always goes through Defuddle → DOMPurify before reaching `content_html`.

---

## Dependency Changes

| Action     | Package    | Purpose                                                                                                                                                                    |
| ---------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Add**    | `turndown` | HTML → markdown conversion (~30KB)                                                                                                                                         |
| **Remove** | `marked`   | No longer needed — Jina now returns HTML directly, and AI cleanup outputs HTML (not markdown). Verify no other usages in the codebase before removing from `package.json`. |

---

## Implementation Order

### Phase 1: Pipeline unification (no UI changes)

1. Add `turndown` dependency
2. Schema migration: add `content_original_html`, `content_markdown`, `ai_cleaned_at` columns
3. Update `parseArticleFromUrl` to use `x-respond-with: html` + Defuddle pipeline
4. Update both parser entry points to populate `content_original_html` and `content_markdown`
5. Backfill migration for `content_markdown` on existing articles
6. Update AI features to use `content_markdown`
7. Tests: unit tests for turndown conversion, integration tests for updated parser

### Phase 2: Email preprocessing

8. Create `src/lib/email-preprocessor.ts`
9. Integrate into newsletter poller (before `parseArticleFromHtml`)
10. Add "original view" toggle in reader for newsletter articles
11. Tests: unit tests for email preprocessor, integration test for newsletter pipeline

### Phase 3: AI cleanup

12. Create `src/lib/content-quality.ts` (heuristic detection)
13. Create `POST /api/ai/clean` route
14. Add cleanup banner + button in reader view
15. Add "Revert formatting" option when `ai_cleaned_at` is set
16. Tests: unit tests for quality detection, integration tests for cleanup route

### Phase 3.5: Mistral provider for HTML reformat

17. Add Ministral 3 8B to `src/lib/pricing.ts` `MODEL_PRICING`
18. Add `callMistralChat()` to `src/lib/ai.ts` (mirroring `callClaude`)
19. Update `POST /api/ai/clean` HTML branch to call Mistral by default, with
    Haiku fallback on error or validation failure
20. Add `reformat_provider` and `reformat_fallback_alert_threshold` to
    `SETTING_KEYS`
21. Surface fallback-rate warning banner in Settings
22. Tests: provider down → fallback engages; validation failure → fallback
    engages; missing key → fallback engages; primary success → no fallback

---

## Phase 4: Parallel chunking for long articles

`POST /api/ai/clean` silently switches to this path when `content.length > CHUNK_THRESHOLD` (35,000 chars). The single-call path is unchanged for smaller articles.

### Chunking strategy

`chunkHtml(html, targetSize = 25_000)` in `src/lib/reformat-chunker.ts`:

1. Parse with jsdom and walk the **top-level children** of the article root.
2. Greedily pack children into a chunk until adding the next child would exceed `targetSize`. Serialize each chunk's children as a self-contained HTML fragment.
3. **Oversized single block**: if a top-level child alone exceeds `targetSize`, recurse one level into its children using the same greedy rule. If a child of the recursion is still oversized, emit it as a single chunk with `isOversized: true` — no further recursion.
4. Never split a block element across chunks.
5. Empty or whitespace-only input returns `[]` (zero chunks).

**Hard ceiling**: any chunk whose serialized length exceeds 80,000 chars is truncated to 80k before dispatch and a `warn` log is emitted (`reformat_chunk_oversized_truncated`). `isOversized` is set to `true` as a result. Ministral's 128k context gives headroom, but this prevents pathological single-block articles from timing out.

### Per-chunk pipeline

For each chunk (bounded concurrency `Math.min(chunks.length, 8)` in flight):

1. Call Mistral via `callMistralChat(AI_CLEAN_PROMPT, chunk.html, { ...ctx, runId })`.
2. Strip markdown code fences, sanitize with `sanitizeArticleHtml`.
3. Validate with `validateCleanOutput(rawText, sanitized, chunk.html)` — same ±40% length bounds, same sanitized-length ratio as the single-call path. The caller passes the **chunk's original HTML**, not the full article.
4. On Mistral exception (including timeout abort) or validation failure → one Haiku attempt: `callClaudeWithMeta(AI_CLEAN_PROMPT, chunk.html, { ...ctx, runId }, UTILITY_MODEL, 32768, 240_000, 0)` → sanitize → validate.
5. On both failing → substitute `sanitizeArticleHtml(chunk.html)` and mark the chunk `skipped`.

All chunks run to completion (`Promise.all` — no early termination).

### Per-chunk failure handling

- **Partial success** (≥1 chunk succeeded): skipped chunks substitute their original sanitized HTML. The assembled result is persisted. The reader banner shows "Reformatted with AI (X/N sections; M kept original)" when `skipped > 0`.
- **Total failure** (all chunks skipped): throw `ValidationError` — `content_html` is NOT updated. `ai_usage` rows are still written for the failed attempts.

### Assembly

Chunks are joined in original order → `sanitizeArticleHtml` (belt-and-braces) → `convertHtmlToMarkdown`. The article is updated with the new `contentHtml`, `contentMarkdown`, and `aiCleanedAt`.

### Cost accounting (`runId`)

A `runId = crypto.randomUUID()` is generated once per chunked reformat and threaded through `TrackingContext` into every `callMistralChat` / `callClaudeWithMeta` call. All `ai_usage` rows for that reformat share the same `runId`. The Usage view groups rows by `runId` into a single line item showing aggregate tokens, cost, and per-model chunk counts (e.g. "mistral×3 + haiku×1").

### API contract additions

When the chunked path is taken, the response includes additional fields:

```typescript
// Extended response (chunked path only)
{
  contentHtml: string;
  contentMarkdown: string;
  provider: 'mistral' | 'anthropic' | 'mixed'; // 'mixed' when both providers contributed
  fallback?: boolean;
  chunked: true;
  chunksTotal: number;
  chunksSkipped: number;
}
```

`provider` reflects only the **accepted** chunks (skipped chunks do not contribute). All accepted on Mistral → `'mistral'`; all on Haiku → `'anthropic'`; mix → `'mixed'`.

### Reader-view banner

- `chunksSkipped === 0`: no extra text (fallback rescue is internal, invisible to the user).
- `chunksSkipped > 0`: banner reads "Reformatted with AI (X/N sections; M kept original)".

Implemented in `src/components/reader/ai-cleanup-banner.tsx` via the `partialOutcome` state set on API response.

### Structured logging schema

Each chunk emits a `reformat_chunk` info log on completion:

```typescript
{
  event: 'reformat_chunk',
  articleId: number,
  runId: string,
  chunkIndex: number,
  chunksTotal: number,
  status: 'success' | 'skipped',
  provider: 'mistral' | 'anthropic' | null, // null when skipped
}
```

### Edge cases

| Case                                      | Handling                                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Single top-level block larger than target | Recurse one level into its children                                                                        |
| Block still oversized after recursion     | Emit as `isOversized` chunk; truncate at 80k before dispatch                                               |
| All chunks skipped                        | `ValidationError` — content unchanged, `ai_usage` rows written                                             |
| `chunkHtml` returns `[]` (empty input)    | Not reachable via the route (guarded by the `> CHUNK_THRESHOLD` branch and the earlier "no content" check) |
| `reformat_provider = anthropic`           | Skip Mistral entirely; each chunk goes straight to Haiku                                                   |

---

## Settings

| Key                                 | Default   | Description                                                                      |
| ----------------------------------- | --------- | -------------------------------------------------------------------------------- |
| `newsletter_auto_clean`             | `false`   | Auto-trigger AI cleanup for newsletter articles on save                          |
| `reformat_provider`                 | `mistral` | `mistral` \| `anthropic` — primary provider for `POST /api/ai/clean` HTML branch |
| `reformat_fallback_alert_threshold` | `0.1`     | Fallback rate over 1 h that triggers a Settings warning                          |

---

## Files Created/Modified

### New files

- `src/lib/email-preprocessor.ts` — email HTML preprocessing
- `src/lib/content-quality.ts` — formatting issue detection heuristics
- `src/lib/html-to-markdown.ts` — turndown wrapper with reader-specific config
- `src/app/api/ai/clean/route.ts` — AI cleanup API route
- `__tests__/unit/email-preprocessor.test.ts`
- `__tests__/unit/content-quality.test.ts`
- `__tests__/unit/html-to-markdown.test.ts`
- `__tests__/integration/ai-clean.test.ts`

### Modified files

- `src/db/schema.ts` — 3 new columns on articles
- `src/types/index.ts` — types auto-inferred, add `SETTING_KEYS` entry
- `src/lib/article-parser.ts` — Jina HTML mode, populate new columns
- `src/lib/ai.ts` — use `content_markdown` for context
- `src/lib/chat-retrieval.ts` (or equivalent) — use `content_markdown`
- `src/lib/newsletter-poller.ts` — integrate email preprocessor
- Reader view component — cleanup banner, original view toggle
- `src/lib/validators.ts` — add `cleanArticleSchema`
- `package.json` — add `turndown`, `@types/turndown`; remove `marked`, `@types/marked` (if no other usages)
- `docs/modules/article-parser.md` — update pipeline documentation
- `docs/modules/ai-features.md` — document new cleanup endpoint
