# Module: Global Search

**Status**: Done
**Last verified against code**: 2026-06 (module-build session 2 — UI)
**Schema tables**: `articles`, `highlights`, `theses`, `drafts` (reads); new FTS table `drafts_fts`
**Unimplemented sections**: none

---

## 1. Purpose

One entry point to find anything in the knowledge base — articles, highlights, theses, and drafts — from anywhere in the app. Two surfaces:

1. A **command palette** (`Cmd/Ctrl+K`) for fast "jump to" navigation with as-you-type results.
2. A **`/search` page** for exhaustive, filterable, paginated results.

Global Search is for _retrieval_ ("where is that article about X"). Knowledge Chat remains the surface for _synthesis_. Chat messages are explicitly **out of scope** for search.

This module is primarily UI + one route extension. The FTS5 infrastructure already exists: `articles_fts` (includes `ai_index`), `highlights_fts`, theses FTS (Module 13), and `escapeFts5Query()`. The only new index is `drafts_fts`.

### Confirmed decisions (2026-06)

| #   | Decision               | Choice                                                                                                                                                                                                                                                                                                                  |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | v1 entity scope        | Articles + highlights + theses + **drafts** (chat messages excluded)                                                                                                                                                                                                                                                    |
| 2   | Palette implementation | **Hand-rolled** on existing Radix Dialog primitives — no `cmdk` dependency. Rationale: server-side BM25 ranking means cmdk's filtering engine (its main value and main bug surface) would run with `shouldFilter={false}` and be dead weight; the consumed 20% (keyboard nav, aria, scroll-into-view) is ~100–150 lines |
| 3   | Palette matching       | **Prefix match** on the last token in palette mode                                                                                                                                                                                                                                                                      |
| 4   | Recent searches        | **Skipped** — no `search_history` table, no localStorage                                                                                                                                                                                                                                                                |
| 5   | Sidebar entry point    | **Icon-only** trigger next to the existing `+` button                                                                                                                                                                                                                                                                   |

Two structural design decisions, confirmed:

- **Grouped, not interleaved.** BM25 scores from different FTS tables are not comparable. Results are grouped by entity type and ranked _within_ each group. Never merge groups into a single ranked list.
- **Snippets via sentinel markers.** FTS5 `snippet()` output is HTML-escaped server-side _before_ sentinel markers are replaced with `<mark>` tags. See §6.1.

---

## 2. API contract

### `GET /api/search` (extension of the existing Module 1 route)

> **Migration note for implementation**: a search route already exists (Module 1, "FTS5 search across articles and highlights with type filtering") and is exercised by E2E tests (`highlight-search` journey). Read the current implementation first. The response shape below is a breaking change to that route — acceptable (single-user, internal API) — but every existing caller and the existing E2E/integration tests must be located and migrated in the same session.

#### Query parameters

| Param                 | Type                                           | Default  | Notes                                                          |
| --------------------- | ---------------------------------------------- | -------- | -------------------------------------------------------------- |
| `q`                   | string, **min 2 chars**                        | required | Escaped via `escapeFts5Query()` before any FTS use             |
| `types`               | CSV subset of `article,highlight,thesis,draft` | all four | Invalid value → 422                                            |
| `status`              | `ArticleStatus`                                | —        | Applies to article results only; ignored for other types       |
| `sourceId`            | int                                            | —        | Applies to article results only                                |
| `dateFrom` / `dateTo` | ISO date                                       | —        | `articles.saved_at` for articles; `created_at` for other types |
| `limit`               | int 1–50                                       | 10       | Per-type, not global                                           |
| `offset`              | int ≥ 0                                        | 0        | Per-type                                                       |
| `mode`                | `palette` \| `full`                            | `full`   | See behavior table below                                       |

|              | `mode=palette`                                                                         | `mode=full`              |
| ------------ | -------------------------------------------------------------------------------------- | ------------------------ |
| Per-type cap | 5 (ignores `limit`/`offset`)                                                           | `limit`/`offset` honored |
| Matching     | Prefix match: `*` appended to the **last token**, **after** `escapeFts5Query()` (§6.2) | Exact tokens only        |
| Filters      | Ignored (`types` still honored)                                                        | All honored              |
| Snippets     | Included                                                                               | Included                 |

#### Response shape (`200`)

```typescript
// src/types/index.ts

export const SEARCH_ENTITY_TYPES = ['article', 'highlight', 'thesis', 'draft'] as const;
export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

export interface SearchResultArticle {
  id: number;
  title: string;
  siteName: string | null;
  status: ArticleStatus;
  snippet: string; // escaped HTML containing only <mark> tags — see §6.1
  savedAt: string;
}

export interface SearchResultHighlight {
  id: number;
  articleId: number;
  articleTitle: string;
  snippet: string;
}

export interface SearchResultThesis {
  id: number;
  title: string;
  status: ThesisStatus;
  snippet: string;
}

export interface SearchResultDraft {
  id: number;
  title: string;
  templateId: TemplateId;
  thesisId: number;
  snippet: string;
}

export interface SearchResponse {
  query: string;
  results: {
    articles: SearchResultArticle[];
    highlights: SearchResultHighlight[];
    theses: SearchResultThesis[];
    drafts: SearchResultDraft[];
  };
  totals: Record<SearchEntityType, number>; // unpaginated match counts per type
}
```

Types not present in `types=` return empty arrays and `0` totals (shape is stable; client never branches on key existence).

#### Errors

| Status | Condition                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------- |
| 422    | `q` missing or < 2 chars after trim; invalid `types`/`status`/`limit`/`offset`; malformed dates |
| 500    | Unexpected (standard `handleApiError`)                                                          |

Zod schema (`searchSchema`) validation is the first operation in the handler, per convention.

#### Ranking

- Order within each group: `ORDER BY bm25(<fts_table>, <weights...>) ASC` (in SQLite, **lower bm25() = better match**).
- Articles: weight the `title` column ~3× over `content` and `ai_index` (e.g. `bm25(articles_fts, 3.0, 1.0, 1.0)`). **The weight argument order must match the actual FTS column order in the migration that created/rebuilt `articles_fts` — verify against the migration SQL, do not assume.**
- Other tables: default weights (1.0) in v1.
- `totals` computed with `COUNT(*)` over the same filtered FTS match, without limit/offset.

#### Exclusions

- Articles with `status = 'pending_review'` are **never** returned (consistent with `GET /api/articles`).
- No other soft exclusions in v1 (archived articles are searchable — that is often exactly what the user is looking for).

---

## 3. Schema changes

One migration:

```sql
CREATE VIRTUAL TABLE drafts_fts USING fts5(
  title,
  content,
  content='drafts',
  content_rowid='id'
);
```

Plus the standard three sync triggers (insert / update / delete), mirroring the existing `articles_fts` trigger pattern, and a one-time rebuild (`INSERT INTO drafts_fts(drafts_fts) VALUES('rebuild');`) to index existing rows.

Notes:

- Triggers are DB-level, so the draft **streaming-generation persist path** indexes automatically with no application change — but an integration test must prove it (§7).
- Drafts are the largest documents in the system (full blog posts); the index size is acceptable at single-user N.
- **No** `search_history` table (decision 4). **No** changes to any existing table.

---

## 4. UI — Command palette (primary surface)

### 4.1 Triggers

- `Cmd+K` (macOS) / `Ctrl+K` global keyboard shortcut. Registered at the app shell level; does **not** fire when focus is inside an input/textarea/contenteditable _other than_ the palette's own input. `Cmd/Ctrl+K` while open closes it (toggle).
- Search icon (lucide `Search`) in the sidebar header, adjacent to the existing `+` `AddContentButton` (decision 5 — icon only, no persistent input field).
- Mobile: same icon opens the same component rendered full-screen (Radix Dialog with full-viewport content on `< sm`).

### 4.2 Component structure (hand-rolled, decision 2)

Built on the **existing Radix Dialog** primitives already in the dependency tree. No new dependency.

```
src/components/search/
  search-palette.tsx        // Dialog shell, open-state, global shortcut
  search-palette-input.tsx  // combobox input, debounce
  search-palette-results.tsx// grouped listbox, active-index reducer
  use-search-query.ts       // debounced fetch w/ AbortController (shared with /search page)
```

State: a single `useReducer` over `{ activeIndex, items }` where `items` is the flattened ordered list of result rows (group headers are not focusable items). Mouse hover sets `activeIndex`; keyboard moves it.

### 4.3 Behavior

- Debounce: **200 ms** after last keystroke; each fetch aborts the previous via `AbortController` (same pattern as the library page).
- Calls `GET /api/search?mode=palette&q=...`.
- Below 2 characters: render nothing (no request). Empty-query state is empty (decision 4 — no recent searches, no suggestions).
- Results render grouped under type headers — **Articles / Highlights / Theses / Drafts** — max 5 per group, groups with zero results omitted.
- Each row: title (or snippet for highlights), one-line secondary text (site name / article title / thesis status / template), `<mark>` spans in snippets styled with the existing highlight-yellow token.
- Footer row (always last focusable item when any results exist): **"See all N results →"** where N = sum of `totals` → navigates to `/search?q=<encoded>`.
- Loading: subtle inline spinner in the input's right slot; previous results stay visible until replaced (no flash-of-empty).
- Zero results (query ≥ 2 chars, response empty): single non-focusable "No results for '…'" row.

### 4.4 Navigation on select (Enter or click)

| Type      | Destination                                                                                                                                                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Article   | `/reader/[id]`                                                                                                                                                                                                                                 |
| Highlight | `/reader/[articleId]?highlight=[id]` — reader scrolls to the corresponding `<mark>` after highlight anchoring completes; if `position_data` no longer anchors (article reformatted since), **fall back silently to top of article** — no error |
| Thesis    | `/theses/[id]`                                                                                                                                                                                                                                 |
| Draft     | `/drafts/[id]`                                                                                                                                                                                                                                 |

The `?highlight=` reader param is **new** and part of this module's scope (small addition to the reader page: after highlight layer mount, `scrollIntoView({ block: 'center' })` on the matching mark + a brief emphasis pulse).

Palette closes on navigation, on `Escape`, and on outside click (Radix Dialog defaults).

### 4.5 Keyboard & ARIA contract (normative — do not improvise)

This is the part cmdk would have provided; it is fixed here so implementation doesn't drift.

**Pattern**: WAI-ARIA combobox with listbox popup.

- Input: `role="combobox"`, `aria-expanded={hasResults}`, `aria-controls="search-palette-listbox"`, `aria-activedescendant={activeItemId | undefined}`, `aria-autocomplete="list"`. DOM focus **stays on the input at all times**; the active option is virtual (via `aria-activedescendant`).
- Results container: `role="listbox"`, `id="search-palette-listbox"`.
- Group: `role="group"` with `aria-labelledby` pointing at its header element; header itself `role="presentation"`.
- Row: `role="option"`, `id="search-option-<type>-<id>"`, `aria-selected={isActive}`.
- "See all" footer: also `role="option"` (it is a focusable item in the flattened list).

**Keys** (handled on the input):

| Key                     | Action                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `ArrowDown` / `ArrowUp` | Move `activeIndex` ±1 across the flattened item list, crossing group boundaries; no wrap in v1 |
| `Enter`                 | Activate active item (navigate)                                                                |
| `Escape`                | Close palette (Radix default)                                                                  |
| `Home` / `End`          | First / last item                                                                              |
| `Tab`                   | Close palette (do not trap-cycle inside the listbox)                                           |

On every `activeIndex` change: `element.scrollIntoView({ block: 'nearest' })`.

---

## 5. UI — `/search` page (secondary surface)

- **URL-driven state**: `?q=&types=&status=&sourceId=&dateFrom=&dateTo=` — results are linkable and back-button-safe (same pattern as `/settings?tab=usage`). The palette's "See all" deep-links here.
- Layout, top to bottom:
  1. Search input, pre-filled from `q`, debounced (reuses `use-search-query.ts`), updates the URL via `router.replace` (no history spam per keystroke).
  2. Type tabs: **All / Articles / Highlights / Theses / Drafts**, each showing its count from `totals`. "All" renders the four groups stacked with per-group "Show all <type> →" links that activate that tab.
  3. Contextual filter row, visible only when relevant: status + source + date range on the Articles tab; date range only elsewhere. Filters map to query params.
  4. Results. **Reuse existing components**: `ArticleCard` for articles, the library highlight card for highlights, the thesis list row for theses, the drafts list row for drafts — extended minimally to accept an optional `snippet` slot rather than forked.
- Pagination: per-type "Load more" (`offset` increments), only on a single-type tab; the "All" tab shows the first page of each group only.
- Rapid filter/tab changes cancel in-flight requests via `AbortController` (library-page pattern).
- Empty states: distinct copy for "no query yet" vs "no results for filters" (with a "clear filters" action).
- No sidebar nav item in v1 — the palette is the entry point; the page exists as the palette's overflow. Revisit if usage says otherwise.

---

## 6. Security

### 6.1 Snippet escaping (XSS — the critical invariant of this module)

FTS5 `snippet()` returns **raw stored text** with injected markers. Stored text may contain `<`, `>`, `&`, quotes — and for `content_markdown`/draft content, literal HTML-looking sequences. The pipeline, server-side, in this exact order:

1. `snippet(<fts_table>, <col>, '\x01', '\x02', '…', 12)` — sentinel bytes `\x01`/`\x02` as open/close markers. These control bytes are vanishingly unlikely in legitimate stored text and are **not** stripped at ingestion, so the safety of step 3 must not depend on their absence (see below).
2. **HTML-escape the entire snippet string** (`&`, `<`, `>`, `"`, `'`).
3. Replace `\x01` → `<mark>` and `\x02` → `</mark>`.

The resulting string contains no HTML other than `<mark>` pairs. **The load-bearing safety control is the escape-first ordering, not any ingestion-time filtering of sentinel bytes.** Because step 2 escapes every `<`, `>`, `&`, `"`, `'` before step 3 runs, a literal `\x01`/`\x02` byte that survives in stored text can only ever produce an attribute-less `<mark>`/`</mark>` tag — it cannot introduce other tags, attributes, or script. The client renders the result via `dangerouslySetInnerHTML` **only** because of this server-side guarantee — add a code comment at the render site pointing at this section. Never reorder steps 2 and 3.

Unit tests must include a stored-text fixture containing `<script>`, `<img onerror=...>`, and a literal `\x01` byte (the byte is **not** stripped — it becomes a bare `<mark>` tag, which is harmless because escaping already ran).

### 6.2 FTS5 query escaping & prefix star

- All query input passes through the existing `escapeFts5Query()` **first**.
- In `mode=palette`, the `*` is appended to the last token **after** escaping. Dedicated unit tests for the interaction, including: query ending in a double quote, query ending in `*`, query that is entirely special characters, single-token vs multi-token queries.
- A query that escapes to an empty/invalid FTS expression returns the empty `SearchResponse`, not 500.

### 6.3 Other invariants

- Zod validation first operation in the route handler.
- All non-FTS lookups via Drizzle; FTS queries are the sanctioned raw-SQL exception and must use `escapeFts5Query()`.
- `pending_review` exclusion enforced in SQL, not post-filtered in JS.
- No new external fetches, no new secrets, no new env vars.

---

## 7. Edge cases & required tests

### Unit (`__tests__/unit/search.test.ts` extension + new files)

- `escapeFts5Query` + prefix-star interaction matrix (§6.2).
- Snippet escape pipeline with hostile fixtures (§6.1).
- Flattened-list reducer: arrow navigation across group boundaries, Home/End, no-wrap behavior.

### Integration (`__tests__/integration/global-search.test.ts`)

- Each `types` filter independently and combined; invalid type → 422.
- `q` < 2 chars → 422.
- `pending_review` article matching the query is absent from results.
- `status`/`sourceId`/date filters apply to articles and are ignored for other types.
- Per-type `limit`/`offset`; `totals` unaffected by pagination.
- `mode=palette` caps at 5 per type and prefix-matches (e.g. `q=neur` matches "neural").
- **`drafts_fts` trigger fires on the draft generation persist path** (create a draft via the generation pipeline's persistence function, then search for its content).
- Migration of all pre-existing search tests/callers from the old response shape.

### E2E (`e2e/global-search.spec.ts`)

- `Ctrl+K` opens palette → type query → arrow to a highlight result → Enter → reader opens scrolled to the mark.
- "See all" → `/search` page shows tabs with counts → tab switch filters.
- (Note: the existing `Escape`-key headless-Chromium issue from TECH_DEBT applies — use the DOM-dispatch workaround for palette-close assertions.)

### Behavioral edge cases (handled in code, asserted where practical)

- Highlight result whose `position_data` no longer anchors → reader opens at top, no error (manual/E2E check).
- Highlights on `extraction_tier='failed'` articles match on highlight text/note only — expected, no special handling.
- Orphaned highlights cannot exist (cascade delete from articles) — no handling needed.
- Concurrent rapid queries: later response must never be overwritten by an earlier slow one (AbortController + ignore-stale guard).

---

## 8. Out of scope (v1)

- Chat message search (confirmed exclusion).
- Semantic / embedding search — `ai_index` inside `articles_fts` already provides concept-level matching.
- Recent searches / search history in any storage (decision 4).
- Sidebar persistent input field (decision 5).
- Cross-type interleaved ranking.
- Search-as-chat-scope (already exists via chat scoping).

---

## 9. Open items for future phases

- If draft count or article corpus grows enough that "All" tab feels slow, consider a single batched SQL round-trip per request (4 FTS queries + 4 counts in one transaction) — likely already how v1 lands, noted here in case implementation splits them.
- Highlight-yellow `<mark>` styling token shared between reader highlights and search snippets — if visual confusion arises, give snippets a distinct (lighter) token.
- Palette result thumbnails (article `imageUrl`) — deferred, text-only in v1.
