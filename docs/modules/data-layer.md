# Module 1: Data Layer + API

**Status**: Done
**Last verified against code**: 2026-10 (docs session)
**Schema tables**: `sources`, `articles`, `highlights`, `tags`, `highlight_tags`, `settings`, `audit_log`
**Unimplemented sections**: none

## Purpose

Implement all CRUD API routes for the core entities (articles, highlights, sources, tags) plus full-text search via SQLite FTS5. This module provides the complete data access layer that all other modules depend on.

## Dependencies

- `src/db/schema.ts` — Drizzle schema (already exists)
- `src/db/index.ts` — DB connection singleton (already exists)
- `src/types/index.ts` — Shared types (already exists)
- `src/lib/errors.ts` — Custom error classes (already exists)
- `src/lib/logger.ts` — pino logger (already exists)
- `src/lib/search.ts` — FTS5 query escaping (already exists)

## FTS5 Setup

Five virtual tables with sync triggers, initialized in `src/db/fts.ts` (called from `src/db/index.ts`):

- `articles_fts` — title, content_text, **ai_index**, author, site_name
- `highlights_fts` — text, note
- `theses_fts` — title, claim, counterarguments, implications, notes (added Module 13)
- `chat_messages_fts` — content (added Module 14)
- `drafts_fts` — title, content (added Module 16)

The `articles_fts` table includes `ai_index` (added by Module 14) so FTS5 searches automatically match concept-level terms from the AI-generated index alongside full-text content. Because FTS5 does not support `ALTER TABLE`, `initFts()` compares the actual `articles_fts` column set against the expected shape (`ARTICLES_FTS_COLUMNS`) and rebuilds the table + triggers on any drift. `initFts()` is the sole owner of FTS shape — `scripts/migrate.mjs` deliberately does not touch FTS.

```sql
-- Articles full-text search (v2: includes ai_index)
CREATE VIRTUAL TABLE articles_fts USING fts5(
  title, content_text, ai_index, author, site_name,
  content='articles', content_rowid='id'
);

-- Highlights full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS highlights_fts USING fts5(
  text, note,
  content='highlights', content_rowid='id'
);

-- Theses full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS theses_fts USING fts5(
  title, claim, counterarguments, implications, notes,
  content='theses', content_rowid='id'
);

-- Chat messages full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
  content,
  content='chat_messages', content_rowid='id'
);

-- Drafts full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS drafts_fts USING fts5(
  title, content,
  content='drafts', content_rowid='id'
);
```

All five tables have corresponding AFTER INSERT/DELETE/UPDATE sync triggers. See `src/db/fts.ts` for the full trigger definitions.

**Trigger self-heal.** The expected trigger names live in `FTS_TRIGGERS`. Every `initFts()` call creates all triggers with `CREATE TRIGGER IF NOT EXISTS`; if a table's `_fts` index already existed but one of its triggers was missing (a table rebuild drops them), the index is rebuilt from the content table (`INSERT INTO <t>_fts(<t>_fts) VALUES('rebuild')`) and `fts_triggers_restored` is logged with the table. A fresh DB logs nothing.

## Migrations

`scripts/migrate-runner.mjs` (`runMigrations`) is the only migration runner: `scripts/migrate.mjs` (`npm run db:migrate`, `predev`, `prestart`) and `createTestDb()` both call it. It applies each pending file in its own transaction with foreign keys off (restored to the caller's mode afterwards), so a table rebuild cannot cascade-delete child rows and a failing file is rolled back whole, with an error naming it. All pending files are checked before any runs: a statement starting with transaction control (`BEGIN`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`) rejects the run, `PRAGMA foreign_keys` statements are dropped, and each `--> statement-breakpoint` chunk must hold one statement. A migration that introduces a foreign key violation is rolled back; violations that already existed are logged once (`migration_fk_preexisting`) and left as is. The runner throws if the connection holds an open transaction. Tracking rows keep the hash format (sha256 of the file, journal `when`). Never run `drizzle-kit migrate` or `drizzle-kit push`.

## API Contract

### Articles

#### `POST /api/articles`

Create a new article (from browser extension, RSS, or manual save).

**Request body**:

```typescript
{
  url: string;                    // required, unique
  title: string;                  // required
  author?: string;
  contentHtml?: string;
  contentText?: string;
  excerpt?: string;
  siteName?: string;
  imageUrl?: string;
  wordCount?: number;
  sourceId?: number;              // default: the `web_save` singleton source ("Web saves")
  publishedAt?: string;           // ISO 8601
  status?: "inbox" | "reading" | "archived";  // default: "inbox"
}
```

Every article has a source (`articles.source_id` is NOT NULL, `ON DELETE restrict`). Without `sourceId`, the article goes to the `web_save` singleton, created on demand. A given `sourceId` must refer to an existing source that is not soft-deleted, otherwise the request is a `422`. `POST /api/articles/parse` applies the same rule, after its URL-duplicate `409` check and before any fetch.

> The DB status enum also contains `pending_review` (`src/db/schema.ts`), set only by newsletter ingestion for unknown senders — the public API neither accepts it as input nor returns such rows (see `GET /api/articles` below and `docs/modules/newsletter-ingestion.md`).

**Response**: `201` with `{ article: Article }`.
**Errors**: `422` (validation, unknown or soft-deleted `sourceId`), `409` (duplicate URL).

#### `GET /api/articles`

List articles with filtering, sorting, and pagination.

**Query params**:

- `status` — filter by status (comma-separated for multiple; `inbox` / `reading` / `archived` only)
- `sourceId` — filter by source
- `sourceType` / `excludeSourceType` — filter by the source's type (e.g. `newsletter`, `rss_feed`)
- `isFavorite` — `true`/`false`
- `sort` — `savedAt` (default), `title`, `readingProgress`
- `order` — `desc` (default), `asc`
- `limit` — default 50, max 200
- `offset` — default 0

**Response**: `200` with `{ articles: Article[], total: number }`. The list projection omits the heavy content fields (`contentHtml`, `contentText`, `contentMarkdown`, `aiIndex`) — fetch a single article for those. Rows with status `pending_review` are always excluded (they are held for newsletter sender approval and managed via `/api/newsletters`).

#### `GET /api/articles/[id]`

Get a single article with its highlights.

**Response**: `200` with `{ article: Article, highlights: Highlight[] }`.
**Errors**: `404` if not found.

#### `PATCH /api/articles/[id]`

Update article fields (status, progress, favorite, etc.).

**Request body** (all optional):

```typescript
{
  status?: "inbox" | "reading" | "archived";
  readingProgress?: number;       // 0-1
  readingAnchorBlock?: number | null;   // int >= 0, index of the first visible content block
  readingAnchorOffset?: number | null;  // 0-1, fraction of that block scrolled past
  isFavorite?: boolean;
  title?: string;
  readAt?: string;                // ISO 8601
  ifStatus?: "inbox" | "reading" | "archived"; // precondition, never stored
}
```

**Conditional update (`ifStatus`)**: when `ifStatus` is present and the stored status differs, the whole update is ignored and the existing article is returned with `200`. It is a precondition, not a field: it is never written, and a body with only `ifStatus` is rejected with `422`. The reader's auto mark-as-reading sends `{ status: "reading", ifStatus: "inbox" }` so it cannot revert an article archived meanwhile (#44).

**Reading progress is monotonic**: if `readingProgress` is present and not greater than the stored value (and not `0`), the whole update is ignored and the existing article is returned, so the reading anchor fields are dropped with it and always describe the furthest point reached. `readingProgress: 0` (reset) also clears `readingAnchorBlock`/`readingAnchorOffset`. The anchor fields are only accepted alongside `readingProgress`: a body with `readingAnchorBlock` or `readingAnchorOffset` but no `readingProgress` is rejected with `422`, so the anchor cannot drift from the saved progress.

**Response**: `200` with updated article.
**Errors**: `404`, `422`.

#### `DELETE /api/articles/[id]`

Delete an article and all its highlights (cascade).

**Response**: `200` with `{ deleted: true }`.
**Errors**: `404`.

### Highlights

#### `POST /api/highlights`

Create a highlight on an article.

**Request body**:

```typescript
{
  articleId: number;              // required
  text: string;                   // required
  note?: string;
  color?: "yellow";                // default: "yellow" (only yellow currently supported)
  positionData?: string;          // JSON-serialized anchor data
  tagIds?: number[];              // link to existing tags
}
```

**Response**: `201` with created highlight (including tags).
**Errors**: `422`, `404` (article not found).

#### `GET /api/highlights`

List highlights with filtering.

**Query params**:

- `articleId` — filter by article
- `tagId` — filter by tag
- `color` — filter by color
- `sort` — `createdAt` (default), `updatedAt`
- `order` — `desc` (default), `asc`
- `limit` — default 50, max 200
- `offset` — default 0

**Response**: `200` with `{ highlights: Highlight[], total: number }`.

#### `PATCH /api/highlights/[id]`

Update highlight note, color, or tags.

**Request body** (all optional):

```typescript
{
  note?: string;
  color?: "yellow";               // only yellow currently supported
  tagIds?: number[];              // replaces all current tags
}
```

**Response**: `200` with updated highlight.
**Errors**: `404`, `422`.

#### `DELETE /api/highlights/[id]`

Delete a highlight (cascade removes tag associations).

**Response**: `200` with `{ deleted: true }`.
**Errors**: `404`.

#### `POST /api/highlights/bulk-delete`

Delete multiple highlights by ID. Missing IDs are silently skipped.

**Request body**:

```typescript
{
  ids: number[];                  // 1-100 positive ints
}
```

**Response**: `200` with `{ deleted: number }` (count actually deleted).
**Errors**: `422`.

#### `POST /api/highlights/bulk-tag`

Add or replace tags on multiple highlights. Missing highlight IDs are silently skipped; duplicate tag IDs are deduped.

**Request body**:

```typescript
{
  ids: number[];                  // 1-100 positive ints
  tagIds: number[];
  mode?: "add" | "replace";       // default: "add"
}
```

**Response**: `200` with `{ updated: number }` (count of existing highlights processed).
**Errors**: `422`.

### Sources

#### `GET /api/sources`

List all sources that are not soft-deleted. A fresh database already holds the `web_save` singleton.

**Response**: `200` with `{ sources: Source[] }`.

#### `POST /api/sources`

Add a new source (typically an RSS feed).

**Request body**:

```typescript
{
  type: "rss_feed" | "browser_extension" | "remarkable" | "manual" | "newsletter";
  name: string;                   // required
  feedUrl?: string;               // required if type is rss_feed
  iconUrl?: string;
  category?: string;
  pollInterval?: number;          // minutes, default 30
}
```

The singleton types (`SINGLETON_SOURCE_TYPES` in `src/types/index.ts`: `web_save`, `upload`, `readwise`) are rejected with `422`: the app creates them on demand (`getOrCreateSingletonSource`), and the `sources_singleton_type_idx` partial unique index allows one row per singleton type. `newsletter` is rejected too (`422`): newsletter senders are created only by the newsletter poller, and a newsletter source could never be deleted afterwards.

**Feed restore.** For `type: "rss_feed"`, if a soft-deleted `rss_feed` source has exactly the same `feed_url` (the most recent `deleted_at` if several), that row is restored instead of inserting a new one: `deleted_at` is cleared, `name`, `icon_url`, `category` and `poll_interval` are overwritten with the request's values (an omitted `iconUrl`/`category` clears it), and `etag`, `last_modified` and `last_polled` are kept. A live source with the same `feed_url` does not block creation (duplicates are allowed).

**Response**: `201` with `{ source: Source }`, or `200` with `{ source: Source, restored: true }` for a restored feed (`CreateSourceResponse`).
**Errors**: `422` (validation, singleton or newsletter type).

#### `DELETE /api/sources/[id]`

Soft-delete a source: `deleted_at` is set and the row stays. Its articles keep pointing at it (the reader still shows its name and icon). A soft-deleted source is hidden from `GET /api/sources` and the sidebar feed list, skipped by the feed poller, and is a `404` for `POST /api/feeds/poll` and `PATCH /api/newsletters/[id]` (`getSourceOrThrow`).

Singleton and newsletter sources (`UNDELETABLE_SOURCE_TYPES`) can't be deleted: `422` with `Built-in sources can't be deleted` (singleton) or `Newsletter senders can't be deleted; block them instead` (newsletter, whatever its pending/approved/blocked state), and the row is unchanged.

**Response**: `200` with `{ deleted: true }`.
**Errors**: `404` (unknown or already soft-deleted), `422` (undeletable type).

### Tags

#### `GET /api/tags`

List all tags with usage counts.

**Response**: `200` with `{ tags: (Tag & { highlightCount: number })[] }`.

#### `POST /api/tags`

Create a new tag.

**Request body**:

```typescript
{
  name: string;                   // required, unique
  color?: string;                 // hex color
}
```

**Response**: `201` with created tag.
**Errors**: `422`, `409` (duplicate name).

### Search

#### `GET /api/search`

Full-text search across articles and highlights using FTS5.

**Query params**:

- `q` — search query (required, min 1 char)
- `type` — `all` (default), `articles`, `highlights`
- `limit` — default 20, max 100
- `offset` — default 0

**Response**: `200` with `{ articles: Article[], highlights: (Highlight & { articleTitle: string })[], total: number }`.
**Errors**: `422` (missing/empty query).

## Edge Cases

1. **Duplicate article URLs**: Return `409 Conflict` with existing article ID.
2. **Cascade deletes**: Deleting an article removes all its highlights and FTS entries via triggers.
3. **Source deletion**: Articles remain, `source_id` set to `null` (FK `SET NULL`).
4. **Tag deletion**: `highlight_tags` entries cascade-deleted, highlights remain.
5. **Empty FTS query**: Return `422`, don't run empty MATCH.
6. **FTS special characters**: All user input goes through `escapeFts5Query()`.
7. **Reading progress**: Clamped to 0-1 range in validation. Monotonic — server rejects values lower than the current progress (never decreases).
8. **Article status transitions**: Archiving an article auto-sets `readAt` on first archive (skipped if the client supplies `readAt` explicitly, or if `readAt` is already set).
9. **Word count**: Computed from `contentText` if not provided and `contentText` exists.
10. **Pagination**: `offset` + `limit` pattern. Total count returned for UI pagination.
11. **`pending_review` isolation**: newsletter articles from unknown senders carry status `pending_review` (DB-only value); the articles API never returns them and never accepts the value as input — approval flows through `/api/newsletters`.
