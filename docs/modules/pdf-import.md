# Module 18: PDF Import

**Status**: Done
**Last verified against code**: 2026-05 (Sessions 1–10 complete)
**Schema tables**: `articles` (added `original_file_path`, `page_count`, `extraction_tier`, `content_hash`), `sources` (enum extended with `upload`), `ai_usage` (`pages_processed` column added in migration 0018)
**Unimplemented sections**: none

### Reader view notes

- **localStorage key**: `article_view_${articleId}`, values `'original'` | absent (default = extracted view). Implemented via `createPersistedToggleStore('article_view_')` in `src/lib/local-storage-toggle.ts`.
- **style-src dependency**: react-pdf injects inline styles for text/annotation layer positioning. The existing `style-src 'self' 'unsafe-inline'` CSP directive covers this. If `'unsafe-inline'` is ever removed from `style-src`, layer rendering will break silently — text selection still works but layers will be mispositioned.
- **Highlight suppression**: `PdfViewer` is intentionally not wrapped in `HighlightLayer` or `HighlightSelectionProvider`. PDF canvas has no HTML anchors for highlight injection; the component lives outside the highlight context by design.

---

## Purpose

Extend Gleanary's ingestion beyond URLs and emails to accept PDFs — both uploaded directly and discovered via URL when the target serves `application/pdf`. PDFs become first-class articles in the existing library with full highlighting, AI features (summarize, tag, index, chat), and reader-view continuity. A "View Original" toggle preserves access to the source PDF when desired.

This module does **not** introduce a new content type. Extracted PDF content flows through the same `articles` table with the same downstream consumers. PDFs are a new _source path_, not a new _primary data model_.

---

## Architecture

### Import flow

```
PDF buffer  (from /api/upload multipart OR /api/articles/parse URL detection)
   → validatePdfMagicBytes
   → sha256 hash + contentHash dedup (409 if seen)
   → preflightPdf  (pdfjs metadata: numPages, /Info Title/Author/CreationDate)
       └─ throws EncryptedPdfError  → 422, no row, no disk write
   → pageCount > 1000 guard          → 422, no disk write
   → storePdf                         (data/originals/<hash>.pdf)
   → INSERT articles row              (extraction_tier='failed', empty content,
                                       pageCount/title/author/publishedAt populated)
   → processPdfWithMistral(buffer, hash, articleId)
       ok:  UPDATE row (content fields, extraction_tier='mistral', aiCleanedAt=now)
            + recordPageBasedUsage(ai_clean_pdf, pagesProcessed, model)
            + scheduleConceptIndex
       failed: row stays as inserted; response includes `warning: <reason>`
```

### Key modules

| File                                               | Purpose                                                                                                                                                                                                                                            |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/pdf-preflight.ts`                         | Metadata-only pdfjs inspection. Throws `EncryptedPdfError` / `ParsingError`. Returns `{ pageCount, title, author, creationDate }`.                                                                                                                 |
| `src/lib/pdf-processor.ts`                         | `processPdfWithMistral(buffer, hash, articleId)`. Orchestrates OCR, image storage, table splicing, HTML pipeline. Returns a discriminated union (`ok: true` / `ok: false` with `reason`). Exports `MAX_PDF_PAGES = 1000`.                          |
| `src/lib/mistral-ocr.ts`                           | `callMistralOcr(buffer)`. Single POST to Mistral. Sends `include_image_base64: true`, `extract_header: true`, `extract_footer: true`, `table_format: 'html'`, `image_min_size: 100`. Returns `{ markdown, pagesProcessed, model, images, pages }`. |
| `src/lib/pdf-image-rewriter.ts`                    | `rewriteImageRefs(markdown, storedNames, articleId)`. Rewrites `![](img-N.ext)` refs to `/api/articles/<id>/images/<name>`; strips orphan refs.                                                                                                    |
| `src/lib/pdf-table-splicer.ts`                     | `appendPageTables(markdown, tables)`. Replaces `[tbl-N.html](tbl-N.html)` markers with Mistral HTML tables; appends unplaced tables at end.                                                                                                        |
| `src/lib/pdf-storage.ts`                           | Disk I/O for PDF files and extracted images. SHA-256 content-addressable layout.                                                                                                                                                                   |
| `src/app/api/upload/route.ts`                      | Direct file upload endpoint (multipart).                                                                                                                                                                                                           |
| `src/app/api/articles/parse/route.ts`              | URL-import endpoint. PDF branch activated by `.pdf` extension or `application/pdf` content-type (or magic bytes).                                                                                                                                  |
| `src/app/api/ai/clean/route.ts`                    | For PDFs: retry endpoint for failed imports (reads from disk, re-runs OCR).                                                                                                                                                                        |
| `src/app/api/articles/[id]/original/route.ts`      | Streams source PDF with full Range request support for react-pdf.                                                                                                                                                                                  |
| `src/app/api/articles/[id]/images/[name]/route.ts` | Serves images extracted by Mistral OCR.                                                                                                                                                                                                            |

### Mistral OCR pipeline (per page)

```
callMistralOcr(buffer)
   → POST to api.mistral.ai/v1/ocr with:
       model: mistral-ocr-latest
       include_image_base64: true
       extract_header: true        ← header content separated from body
       extract_footer: true        ← footer content separated from body
       table_format: 'html'        ← tables returned as HTML with colspan/rowspan
       image_min_size: 100         ← filters tracking pixels / icons
   → per-page fields: markdown, images[], tables[], hyperlinks[], header, footer

processPdfWithMistral:
   → deletePdfImages(hash)          (overwrite mode — clear stale images)
   → for each valid image: storePdfImage(hash, id, base64-decoded bytes)
   → for each page:
       rewriteImageRefs(markdown, storedNames, articleId)
       appendPageTables(rewritten, page.tables)
   → join pages → marked (markdown→HTML)
   → postProcessHtml(html, { isPdfContext: true })
       stripPageNumbers + stripRepeatingHeaders (defensive backstops;
       most cases handled upstream by extract_header/extract_footer)
   → sanitizeArticleHtml()
   → convertHtmlToMarkdown() + stripHtml() + computeWordCount()
```

Headers and footers from Mistral are discarded — they are not included in the article body.

---

## Schema changes

### Migrations

**Migration 0016** — core PDF columns on `articles`:

```typescript
originalFilePath: text('original_file_path'),
pageCount: integer('page_count'),
extractionTier: text('extraction_tier', { enum: ['pdfjs', 'jina', 'mistral', 'failed'] }),
```

**Migration 0017** — content-hash deduplication:

```typescript
contentHash: text('content_hash').unique(),
```

**Migration 0018** — AI usage tracking for page-based billing:

```sql
ALTER TABLE ai_usage ADD COLUMN pages_processed INTEGER;
UPDATE articles SET extraction_tier = 'mistral' WHERE extraction_tier = 'claude';
```

`extraction_tier` values: `'mistral'` (Mistral OCR succeeded), `'failed'` (OCR not yet run or failed; retry offered in reader). Legacy values `'pdfjs'` and `'jina'` are left in the enum for backward compatibility but are not produced by any current code path.

### Source type

`'upload'` added to `sources.type` enum. Generic enough to accommodate future file-based ingestion (EPUB, DOCX) without further schema changes.

---

## API contract

### POST /api/upload

Accept a PDF file upload, run Mistral OCR at import time.

**Request:** `multipart/form-data`

- `file` — PDF binary, max 50MB
- `title` (optional) — override extracted title (max 500 chars)

**Response 201:**

```json
{
  "article": {
    "id": 1234,
    "url": "upload://<sha256>",
    "title": "Document Title",
    "pageCount": 42,
    "extractionTier": "mistral"
  }
}
```

When Mistral OCR fails, the article is still saved with `extraction_tier='failed'` and the response includes a `warning` field:

```json
{
  "article": { "id": 1234, "extractionTier": "failed", ... },
  "warning": "mistral_error"
}
```

`url` uses the `upload://` synthetic scheme to satisfy the `url UNIQUE` constraint on `articles` without collisions.

**Errors:**

- `400` — not a PDF (magic bytes check), missing `file` field
- `409` — duplicate content hash; body: `{ existingId: number }`
- `413` — file > 50MB
- `422` — encrypted PDF (no article created, no disk write); Zod validation error on `title`

### POST /api/articles/parse (PDF branch)

The existing URL-import route gains a PDF branch triggered by:

- URL ending in `.pdf`
- Response `Content-Type: application/pdf`
- Response body starting with `%PDF-` magic bytes

Pre-fetches HTML with 5MB cap; re-fetches with 50MB cap once PDF is detected. Follows the same preflight → dedup → OCR flow. Article `url` retains the original HTTP URL; the binary is also stored at `data/originals/<sha256>.pdf`.

### POST /api/ai/clean (PDF branch)

Retry endpoint for articles with `extraction_tier='failed'`.

**Request body:** `{ articleId: number }`

1. Load PDF from disk (`original_file_path`)
2. If `pageCount > 1000` → 422
3. If `MISTRAL_API_KEY` missing → 503
4. Run `processPdfWithMistral(buffer, hash, articleId)`
5. On success: update `content_html`, `content_markdown`, set `ai_cleaned_at`, `extraction_tier='mistral'`, record usage
6. On failure: 503 for Mistral errors, 422 for empty output or bad PDF

`POST /api/ai/revert` is blocked for PDF articles (422) — `content_original_html` is always NULL for PDFs.

### GET /api/articles/[id]/original

Stream the source PDF for the reader's "View Original" toggle.

- `Content-Type: application/pdf`
- `Accept-Ranges: bytes`
- Full RFC 7233 Range support: `bytes=N-M`, `bytes=N-` (open-ended), `bytes=-N` (suffix)
- `Content-Disposition: inline; filename="<ascii-safe-title>.pdf"`
- 404 if article has no `original_file_path`
- 416 for invalid ranges; `Content-Range: bytes */<total>` in response

### GET /api/articles/[id]/images/[name]

Serve images extracted by Mistral OCR and referenced inline in article HTML.

**Path params:**

- `id` — article ID (validated via `parseIdParam`)
- `name` — must match `/^img-\d{1,10}\.(jpe?g|png)$/`

**Response 200:**

- `Content-Type: image/jpeg` or `image/png` (by extension)
- `Cache-Control: public, max-age=31536000, immutable`

**Errors:**

- `404` — article not found, article is not a PDF (`content_hash` null), or image file missing
- `422` — invalid `name` format

---

## Storage layout

```
data/originals/
  <sha256>.pdf                         — source PDF (content-addressable)
  images/<sha256>/
    img-0.jpg                          — images extracted by Mistral OCR
    img-1.png
    ...
```

- PDFs stored outside `public/` — only served via `/api/articles/[id]/original`
- Images stored outside `public/` — only served via `/api/articles/[id]/images/[name]`
- Image directory deleted and recreated atomically on each OCR run (overwrite mode)
- Both directories removed on article deletion (same deletion hook)

Image filenames come from Mistral OCR responses (untrusted input). Every disk operation gates on `isValidPdfImageName` (whitelist `/^img-\d{1,10}\.(jpe?g|png)$/`). Paths built via `path.join` exclusively.

---

## Reader experience

PDF articles render via two modes with a toggle button:

1. **Reader view (default)** — extracted HTML with standard reader typography. Highlighting works exactly as in regular articles. If Mistral OCR failed (`extraction_tier='failed'`), the AI cleanup banner offers a retry.

2. **Original view** — `react-pdf` viewer showing the source PDF, loaded from `/api/articles/[id]/original` via Range requests. Native text selection enabled for copying. Highlight creation disabled. Toggle persisted per article in `localStorage` (`article_view_${articleId}`).

Article cards show `"42 pages"` instead of `"N min read"` when `pageCount` is set.

### AI cleanup banner states

| Condition                      | Banner                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `extractionTier === 'failed'`  | "Text extraction failed · Retry extraction"                                          |
| `extractionTier === 'mistral'` | No banner (already OCR-cleaned; revert unavailable for PDFs)                         |
| `MISTRAL_API_KEY` missing      | "AI cleanup unavailable — Mistral API key not configured (Settings → Integrations)." |
| `pageCount > 1000`             | "AI cleanup unavailable for PDFs over 1000 pages. Split externally."                 |

### Upload UI

PDFs are uploaded via the `+` dropdown button in the sidebar header and on the home page. The dropdown offers two options: URL and PDF. The PDF option opens a modal with drag-and-drop or file picker. Client-side validation checks MIME type and 50MB limit before upload.

The Library sidebar section includes a **PDFs** nav item (`/inbox?sourceType=upload`) alongside Articles and Emails.

---

## Pricing and usage

Mistral OCR is billed per page. `pricing.ts` includes a per-page rate card entry:

```typescript
'mistral-ocr-latest': { perPageUsd: 0.002 }
```

`ai_usage` rows for PDF OCR use the `'ai_clean_pdf'` feature with `pagesProcessed` instead of token counts. Cost is computed at read time from the page-based rate card.

---

## Security

### File handling

- SHA-256 computed before any other processing
- PDF magic bytes (`%PDF-`) checked before accepting; wrong type → 400
- Files stored at `data/originals/<sha256>.pdf` — never using user-provided filename
- 50MB limit enforced server-side (Content-Length + byte counter); client-side check before upload

### Image handling

- Filenames from Mistral OCR treated as untrusted input
- Whitelist regex `/^img-\d{1,10}\.(jpe?g|png)$/` enforced before every disk operation
- Paths assembled with `path.join`; never string concatenation
- No image content reaches the client without passing through article-existence check

### URL fetching

`safeFetch()` from `src/lib/fetch-utils.ts` is SSRF-validated, size-limited, and timeout-capped. PDF fetch cap is parameterized separately from the 5MB HTML cap.

### Mistral integration

- `MISTRAL_API_KEY` from encrypted settings only; never logged, never returned in responses
- Mistral endpoint is fixed (`https://api.mistral.ai`); no user-controllable URL
- OCR response (Markdown including embedded HTML tables) sanitized via `sanitizeArticleHtml` after conversion
- 120s timeout; single-shot response (no streaming)
- Table HTML from Mistral passes through `sanitizeArticleHtml` — any disallowed tags or attributes are stripped before storage

### react-pdf / pdfjs

- `pdfjs-dist` used server-side only for metadata extraction (`pdf-preflight.ts`); no `getTextContent()` calls on the server
- Worker runs in its own context; embedded JavaScript disabled by default
- CSP: `worker-src 'self' blob:` in Caddyfile; `style-src 'unsafe-inline'` already present for layer CSS

---

## Edge cases

| Case                                                | Handling                                                                                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Encrypted PDF                                       | `preflightPdf` throws `EncryptedPdfError` → 422, no article created, no disk write                                                                                    |
| Corrupted PDF                                       | `preflightPdf` throws `ParsingError` → 422, no article created                                                                                                        |
| Duplicate (same SHA-256 hash)                       | 409 with `{ existingId }` so client can redirect to existing article                                                                                                  |
| PDF > 50MB                                          | 413 before any processing; client-side check prevents wasted upload                                                                                                   |
| PDF > 1000 pages                                    | 422 from preflight; article not created                                                                                                                               |
| Scanned PDF (no text layer)                         | Mistral OCR handles; if Mistral also fails → article saved with `extraction_tier='failed'`; retry banner shown                                                        |
| Mistral key missing                                 | Article saved with `extraction_tier='failed'`; banner shows key configuration hint                                                                                    |
| Mistral 5xx / network error                         | Article saved with `extraction_tier='failed'`, `warning: 'mistral_error'`; retry button in reader                                                                     |
| Mistral returns empty markdown                      | Article saved with `extraction_tier='failed'`, `warning: 'empty_markdown'`; retry button in reader                                                                    |
| Mistral image with invalid filename                 | Whitelist regex rejects → image skipped, markdown ref stripped, warning logged. OCR still succeeds with text-only output.                                             |
| Re-running OCR on a PDF with prior images           | `deletePdfImages(hash)` before writing new images — no stale images from previous runs                                                                                |
| Article deletion with cleaned PDF + images          | `deletePdfImages(hash)` called alongside `deletePdf(hash)` in the same deletion hook                                                                                  |
| URL serves PDF but mislabels content-type           | Magic byte check before content-type; `%PDF-` prefix forces PDF branch regardless of header                                                                           |
| URL re-import of same PDF                           | Returns existing article via `contentHash` dedup (409 → client redirects)                                                                                             |
| User selects text in original view                  | Native browser selection works via react-pdf text layer; ctrl+C copies. No highlight created.                                                                         |
| Mistral table with no positional marker in markdown | `appendPageTables` falls back to appending table HTML at end of page content                                                                                          |
| Header/footer content in Mistral response           | Discarded; not included in article body. `stripPageNumbers` / `stripRepeatingHeaders` in `html-post-processor` serve as defensive backstops for cases Mistral misses. |
