# ADR-002: Readwise Import — Reader API and Text-Based Highlight Anchoring

**Status**: Accepted
**Date**: 2026-04

## Context

The user wanted to import their existing Readwise library (articles + highlights) into the app. Two decisions were required:

1. **Which Readwise API to use** — Readwise has two APIs: the original Highlights API (`/api/v2/`) which provides highlights without article HTML, and the newer Reader API (`/api/v3/list/?withHtmlContent=true`) which returns full article content inline.

2. **How to anchor imported highlights** — Native highlights use `position_data` (DOM path serialization from `src/lib/highlight-anchoring.ts`). Readwise provides highlight text but not DOM positions.

## Decision

### 1. Use the Readwise Reader API (`/api/v3/`)

Use the Reader API endpoint `/api/v3/list/?withHtmlContent=true` for import, which returns articles with full inline HTML content (`html_content` field), rather than the Highlights API (`/api/v2/highlights/`).

**Why:**

- Avoids a second HTTP fetch per article (Reader API returns HTML inline; Highlights API would require fetching each article URL separately).
- `withHtmlContent=true` gives the full article body, allowing `parseArticleFromHtml()` to extract clean content and metadata in the same pipeline as the article parser.
- Reader API supports incremental sync via `updatedAfter` query param, enabling efficient re-runs without re-importing the full library.
- Highlights are child documents in the Reader API response (linked via `parent_id`), co-located with their parent article — simpler to process in a single pass.

**Tradeoff:** The Reader API is newer and less documented. Fallback: if the Reader API becomes unavailable, the Highlights API (`/api/v2/`) remains an option but would require per-article fetches.

### 2. Text-Based Highlight Anchoring for Imported Highlights

Store imported highlights using text-match anchoring (`position_data: null`) rather than the DOM-path-based `position_data` used by native highlights.

**Why:**

- Native DOM positions require a live browser DOM to compute. During server-side import, there is no DOM.
- Readwise provides the highlight text verbatim. Storing `position_data: null` and the exact `text` string is sufficient for display (the reader view renders highlights with text-match fallback when `position_data` is absent).
- Computing accurate DOM positions from raw HTML server-side (via jsdom) would be brittle across HTML normalization differences (whitespace, entity encoding) between the stored content and the Readwise source.

**Tradeoff:** Imported highlights cannot be repositioned via drag handles (edit mode requires `position_data`). They appear correctly in reader view (yellow marks via text match) and in highlight library, but entering edit mode would require a re-anchor step. This is acceptable for an import scenario.

## Consequences

- `sources` table gains `type = 'readwise'` to track the Readwise library as a source.
- `articles.external_id` and `highlights.external_id` store Readwise document/highlight IDs for deduplication on re-import.
- Incremental sync tracks last import timestamp via Settings key `readwise_last_synced`.
- Import endpoint: `POST /api/readwise/import` with SSE progress streaming for large libraries.
- API token stored encrypted in Settings (AES-256-GCM, same mechanism as INWORLD_API_KEY).
