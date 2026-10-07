# System Architecture — Gleanary

## 1. Project Vision

A self-hosted, single-user read-it-later and highlight management system. Ingest articles via browser extension and RSS feeds, read them in a clean reader view with inline highlighting, manage all highlights in a searchable library, and resurface them via spaced repetition.

## 2. Design Principles

- **Single deployable unit** — one Next.js app, one SQLite file, one process
- **Single-user, no auth** — protected at the network level (Tailscale, Cloudflare Tunnel, or basic HTTP auth via reverse proxy)
- **Local-first data** — SQLite file is the entire database; backup = copy the file
- **Claude Code buildable** — every module has clear contracts, types, and test expectations
- **Incremental** — each module is independently useful; no big bang launch required

## 3. High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        VPS                              │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Next.js Application                  │  │
│  │                                                   │  │
│  │  ┌─────────────┐  ┌────────────┐  ┌───────────┐  │  │
│  │  │  App Router  │  │  API Routes│  │  Cron Jobs │  │  │
│  │  │  (Frontend)  │  │  /api/*    │  │ (node-cron)│  │  │
│  │  └──────┬───────┘  └─────┬──────┘  └─────┬──────┘  │  │
│  │         │                │               │         │  │
│  │         └────────┬───────┴───────┬───────┘         │  │
│  │                  │               │                 │  │
│  │           ┌──────▼──────┐ ┌──────▼──────┐          │  │
│  │           │  Drizzle ORM│ │ Claude API  │          │  │
│  │           └──────┬──────┘ └─────────────┘          │  │
│  │                  │                                 │  │
│  │           ┌──────▼──────┐                          │  │
│  │           │   SQLite    │                          │  │
│  │           │  (better-   │                          │  │
│  │           │  sqlite3)   │                          │  │
│  │           └─────────────┘                          │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌─────────────────┐                                    │
│  │ Reverse Proxy   │  (Caddy / nginx / Cloudflare)      │
│  │ + Access Control│                                    │
│  └─────────────────┘                                    │
└─────────────────────────────────────────────────────────┘

        ▲                           ▲
        │ HTTPS                     │ HTTPS
        │                           │
┌───────┴────────┐          ┌───────┴────────┐
│ Browser        │          │ Browser        │
│ (Reader UI)    │          │ Extension      │
└────────────────┘          │ (Clipper)      │
                            └────────────────┘

External input:
  - reMarkable highlights → ingested via existing script calling POST /api/highlights
```

## 4. Tech Stack

| Layer                    | Choice                              | Rationale                                                                        |
| ------------------------ | ----------------------------------- | -------------------------------------------------------------------------------- |
| Framework                | **Next.js 14+ (App Router)**        | Full-stack TS, SSR for reader view, API routes for extension/ingestion           |
| Database                 | **SQLite via better-sqlite3**       | Single-user, zero-ops, file-based backup, sync writes are fine                   |
| ORM                      | **Drizzle ORM**                     | Type-safe, lightweight, excellent SQLite support, easy migration to PG later     |
| Styling                  | **Tailwind CSS + shadcn/ui**        | Claude Code generates these fluently; consistent, responsive                     |
| Article parsing          | **@mozilla/readability + linkedom** | Server-side article extraction, same approach as Readwise Reader                 |
| RSS parsing              | **rss-parser**                      | Mature, handles Atom/RSS2/JSON Feed                                              |
| Full-text search         | **SQLite FTS5**                     | Built-in, no extra service, excellent for single-user scale                      |
| AI features              | **Anthropic Claude API**            | Summarization, auto-tagging, Q&A over highlights                                 |
| Scheduling               | **node-cron** (in-process)          | Feed polling, daily review generation — no external scheduler needed             |
| Browser extension        | **Manifest V3 (Chrome)**            | Minimal: grab URL + send to API, optional Readability client-side                |
| Deployment               | **Docker (single container)**       | Next.js standalone build + SQLite volume mount                                   |
| IaC                      | **OpenTofu**                        | OVH Public Cloud (OpenStack provider) — provisions the VPS                       |
| Server bootstrap         | **cloud-init**                      | Installs Docker, Caddy, creates dirs, writes configs on first boot               |
| Reverse proxy            | **Caddy**                           | Auto-HTTPS via Let's Encrypt, TLS only — auth is built into the app              |
| Access control           | **Basic auth via Caddy**            | Upgrade to Tailscale post-MVP for zero-trust                                     |
| CI/CD                    | **GitHub Actions**                  | Lint + typecheck + test → build Docker → push GHCR → deploy via SSH              |
| Error tracking           | **Sentry** (free tier)              | Auto-instrumented via @sentry/nextjs; errors, perf traces, Web Vitals            |
| Logging                  | **Better Stack** (free tier)        | Structured JSON logs via pino, shipped via Docker log driver or HTTP             |
| Uptime                   | **Uptime Robot** (free tier)        | HTTP health check every 5min, email/webhook alerts                               |
| Unit + integration tests | **Vitest**                          | Fast, native ESM, compatible with Next.js                                        |
| E2E tests                | **Playwright**                      | Chromium only in CI, critical paths only                                         |
| API mocking              | **MSW (Mock Service Worker)**       | Mock external URLs, RSS feeds, Claude API in tests                               |
| HTML sanitization        | **isomorphic-dompurify**            | XSS prevention on ingested article HTML                                          |
| Input validation         | **Zod**                             | Schema validation on all API route inputs                                        |
| Mistral AI API           | PDF OCR + article reformatting      | Page-based pricing for OCR; chat completion for HTML cleanup with Haiku fallback |

## 5. Data Model

### Core Entities

```
┌──────────────────┐       ┌──────────────────────┐       ┌────────────────┐
│     sources       │       │      articles         │       │   highlights    │
├──────────────────┤       ├──────────────────────┤       ├────────────────┤
│ id               │       │ id                   │       │ id             │
│ type (enum)      │──┐    │ source_id (FK)        │──┐    │ article_id (FK)│
│ name             │  │    │ external_id           │  │    │ thesis_id (FK) │
│ feed_url         │  │    │ url                   │  │    │ external_id    │
│ icon_url         │  └───▶│ title                 │  └───▶│ text           │
│ category         │       │ author                │       │ note           │
│ poll_interval    │       │ content_html          │       │ color          │
│ last_polled      │       │ content_text          │       │ position_data  │
│ etag             │       │ excerpt               │       │ anchor_status  │
│ last_modified    │       │ site_name             │       │ created_at     │
│ sender_address   │       │ image_url             │       │ updated_at     │
│ is_blocked       │       │ word_count            │       │ last_reviewed  │
│ last_received_at │       │ page_count            │       │ review_count   │
│ created_at       │       │ reading_progress      │       │ review_interval│
└──────────────────┘       │ status (enum)         │       └────────────────┘
                           │ is_favorite           │       ┌────────────────┐
  sources.type enum:       │ ai_summary            │       │ highlight_tags  │
  - rss_feed               │ ai_tags               │       ├────────────────┤
  - browser_extension      │ ai_index              │       │ highlight_id   │
  - remarkable             │ content_original_html │       │ tag_id         │
  - manual                 │ original_file_path    │       └────────────────┘
  - newsletter             │ content_markdown      │
  - readwise               │ ai_cleaned_at         │       ┌──────────────┐
  - upload                 │ extraction_tier (enum)│       │    tags       │
                           │ content_hash          │
                           │ tts_paragraph         │       ├──────────────┤
                           │ tts_time_offset       │       │ id           │
                           │ published_at          │       │ name         │
                           │ saved_at              │       │ color        │
                           │ read_at               │       │ created_at   │
                           │ created_at            │       └──────────────┘
                           │ updated_at            │
                           └──────────────────────┘

  extraction_tier enum:
  - pdfjs    (legacy — Phase 1 in-process extraction, no longer produced for new uploads)
  - jina     (legacy — Phase 1 Jina Reader fallback, no longer produced for new uploads)
  - mistral  (Mistral OCR — produced at import time as of Phase 3)
  - failed   (Mistral OCR failed or key missing; retryable from the reader)

  article.status enum:
  - inbox              (new, unread)
  - reading            (started but not finished)
  - archived           (finished/dismissed; stamped readAt on first archive)
  - pending_review     (newsletter from unknown sender)

  highlight.anchor_status enum:
  - anchored   (text-quote anchor resolves to a range in current content; default)
  - orphaned   (anchor no longer resolves after content change; highlight kept in
                the library, not rendered in the reader)
  Note: position_data stores a v2 TextQuoteAnchor ({ v, exact, prefix, suffix,
        start, end }); legacy v1 child-index anchors are accepted transitionally
        and upgraded by the backfill. See docs/modules/highlight-anchoring.md.

  highlight.color: enum-locked to ['yellow'] in src/db/schema.ts — a color
        picker is future work; the API accepts only 'yellow' today.

  FK on-delete behaviors (Drizzle `references(..., { onDelete })`):
  - articles.source_id → sources.id: SET NULL (articles survive source removal)
  - highlights.article_id → articles.id: CASCADE
  - highlights.thesis_id → theses.id: SET NULL
  - highlight_tags.highlight_id / .tag_id: CASCADE (both sides)
  - thesis_highlights.thesis_id / .highlight_id: CASCADE (both sides)
  - thesis_research.thesis_id → theses.id: CASCADE
  - drafts.thesis_id → theses.id: CASCADE
  - voice_samples.profile_id → voice_profile.id: CASCADE
  - chat_messages.session_id → chat_sessions.id: CASCADE

  Migration: 0011_redundant_sersi.sql adds content_original_html, content_markdown, ai_cleaned_at.
  Migration: 0016_special_silver_surfer.sql adds original_file_path, page_count, extraction_tier
             to articles; adds 'upload' to sources.type (TypeScript-only, no DB CHECK constraint).
  Migration: 0017_common_the_spike.sql adds content_hash (unique) to articles for cross-flow dedup.
  Migration: 0018_damp_champions.sql renames extraction_tier value 'claude' → 'mistral';
             adds pages_processed column to ai_usage.
  Migration: 0019_collapse_read_into_archived.sql collapses the former 'read' status into 'archived'.
  Migration: 0020_burly_mesmero.sql adds anchor_status (default 'anchored') to highlights
             for the text-quote anchoring model (Module 20).
  Migration: 0021_equal_sheva_callister.sql adds a UNIQUE index on
             highlight_tags(highlight_id, tag_id) (deduping existing rows first) and
             hot-path secondary indexes: articles(status, saved_at, source_id),
             highlights(article_id, last_reviewed, review_interval),
             highlight_tags(tag_id), chat_messages(session_id),
             voice_samples(profile_id), thesis_research(thesis_id).
  Backfill existing rows: npx tsx scripts/backfill-content-markdown.ts
  Backfill highlight anchors (run only after the dual v1/v2 reader ships — Module 20 session 2):
             npx tsx scripts/backfill-highlight-anchors.ts
```

### Thesis Tables

```
┌──────────────────┐       ┌──────────────────────┐       ┌──────────────────┐
│     theses        │       │  thesis_highlights    │       │ thesis_research   │
├──────────────────┤       ├──────────────────────┤       ├──────────────────┤
│ id               │──┐    │ id                   │       │ id               │
│ user_id          │  │    │ thesis_id (FK)        │──┐    │ thesis_id (FK)   │
│ title            │  └───▶│ highlight_id (FK)     │  └───▶│ title            │
│ claim            │       │ role (enum)           │       │ content          │
│ counterarguments │       │ note                  │       │ source (enum)    │
│ implications     │       │ added_at              │       │ created_at       │
│ status (enum)    │       └──────────────────────┘       └──────────────────┘
│ notes            │
│ created_at       │         role enum:                    source enum:
│ updated_at       │         - supporting                  - deep_research
└──────────────────┘         - opposing                    - manual
                             - context                     - ai_analysis
  status enum:
  - nascent
  - developing
  - researched
  - ready
  - used
```

### Settings and Audit Tables

```
┌──────────────────┐       ┌──────────────────────┐
│     settings      │       │      audit_log        │
├──────────────────┤       ├──────────────────────┤
│ id               │       │ id                   │
│ user_id          │       │ user_id              │
│ key              │       │ action (enum)        │
│ value            │       │ key                  │
│ is_encrypted     │       │ timestamp            │
│ updated_at       │       │ ip_address           │
└──────────────────┘       └──────────────────────┘

  action enum:
  - setting_updated
  - setting_deleted
  - api_key_tested
  - api_key_changed
```

### Chat Tables

```
┌──────────────────────┐       ┌──────────────────────┐
│    chat_sessions      │       │    chat_messages       │
├──────────────────────┤       ├──────────────────────┤
│ id                   │──┐    │ id                   │
│ user_id              │  └───▶│ session_id (FK)       │
│ title                │       │ role (enum)           │
│ scope                │       │ content              │
│ model                │       │ citations (JSON)      │
│ created_at           │       │ context_tokens (opt)  │
│ updated_at           │       │ bookmarked_at (opt)   │
└──────────────────────┘       │ created_at           │
                               └──────────────────────┘
                                 role enum:
  scope values:                  - user
  - all                          - assistant
  - article:{id}
  - thesis:{id}
  - tag:{name}
  - recent:{days}
```

### Voice Tables

```
┌──────────────────┐       ┌──────────────────────┐
│   voice_profile   │       │    voice_samples       │
├──────────────────┤       ├──────────────────────┤
│ id               │──┐    │ id                   │
│ user_id          │  └───▶│ profile_id (FK)       │
│ profile          │       │ title                │
│ extracted_at     │       │ content              │
│ sample_count     │       │ word_count           │
│ manual_edits_at  │       │ channel_hint         │
│ created_at       │       │ created_at           │
│ updated_at       │       └──────────────────────┘
└──────────────────┘

  voice_profile is a singleton (unique index on user_id).
  sample_count stores how many samples were used in last extraction.
  Migration: 0012_futuristic_kree.sql
```

### Drafts Table

```
┌──────────────────┐
│      drafts       │
├──────────────────┤
│ id               │
│ user_id          │
│ thesis_id (FK)   │──▶ theses.id (cascade delete)
│ template_id (enum│
│ title            │
│ content          │
│ angle            │
│ context_snapshot │  JSON: { highlightIds: number[], researchIds: number[] }
│ model            │  Claude model ID used for generation (default: claude-sonnet-4-6)
│ status (enum)    │
│ generated_at     │
│ last_edited_at   │
│ published_at     │
│ created_at       │
│ updated_at       │
└──────────────────┘

  template_id enum:       status enum:      model values:
  - blog                  - draft           - claude-haiku-4-5-20251001
  - linkedin              - published       - claude-sonnet-4-6 (default)
  - youtube                                 - claude-opus-4-7

  Migrations: 0013_moaning_ezekiel_stane.sql, 0014_careless_nemesis.sql
```

### AI Usage Table

```
┌──────────────────┐
│     ai_usage      │
├──────────────────┤
│ id               │
│ user_id          │  always 1 (single-user)
│ feature (enum)   │  closed enum — see AiUsageFeature in src/types/index.ts (includes 'ai_clean_pdf' added Session 6)
│ model            │  full model ID e.g. 'claude-sonnet-4-6'
│ status (enum)    │  success | error
│ error_kind       │  rate_limit | timeout | api_error | network | null
│ input_tokens     │
│ output_tokens    │
│ cache_read_tokens│
│ cache_write_tokens│
│ web_search_count │  always 0 until SDK exposes server_tool_use
│ pages_processed  │  set for page-based providers (Mistral OCR); null for token-based models
│ run_id           │  UUID v4; groups multi-call operations (research)
│ resource_type    │  loose ref: article | thesis | thesis_research | draft | chat_session | highlight
│ resource_id      │  loose ref — not a FK (record may be deleted)
│ duration_ms      │
│ created_at       │
└──────────────────┘

  Indexes: ai_usage_created_idx (created_at), ai_usage_feature_idx (feature), ai_usage_run_idx (run_id)
  No cost column — computed from tokens × rate card at read time (src/lib/pricing.ts).
    Token-based models: input/output/cache tokens × MODEL_PRICING.
    Page-based models (Mistral OCR): pages_processed × PAGE_BASED_PRICING.
  Migration: 0015_little_fenris.sql; pages_processed added in 0018_damp_champions.sql.
```

### FTS5 Virtual Table

```sql
CREATE VIRTUAL TABLE articles_fts USING fts5(
  title, content_text, ai_index, author, site_name,
  content='articles', content_rowid='id'
);

CREATE VIRTUAL TABLE highlights_fts USING fts5(
  text, note,
  content='highlights', content_rowid='id'
);

CREATE VIRTUAL TABLE theses_fts USING fts5(
  title, claim, counterarguments, implications, notes,
  content='theses', content_rowid='id'
);

CREATE VIRTUAL TABLE chat_messages_fts USING fts5(
  content,
  content='chat_messages', content_rowid='id'
);

CREATE VIRTUAL TABLE drafts_fts USING fts5(
  title, content,
  content='drafts', content_rowid='id'
);
```

FTS tables and their sync triggers are owned solely by `initFts()` in `src/db/fts.ts`,
which runs at first DB access and self-heals (it rebuilds `articles_fts` whenever its
column set drifts from the expected shape). They are not part of the drizzle migration
chain, and `scripts/migrate.mjs` deliberately does not touch FTS.

### Spaced Repetition Fields (on highlights)

Using a simplified SM-2 algorithm:

- `last_reviewed` — timestamp of last review
- `review_count` — number of times reviewed
- `review_interval` — current interval in days (starts at 1, grows with successful reviews)
- Next review = `last_reviewed + review_interval days`

## 6. Module Breakdown

### Module 1: Data Layer + API

**Scope**: Drizzle schema, migrations, CRUD API routes for all entities.

**API surface** (64 route files under `src/app/api/`). This is an index, not the contract — per-route request/response shapes live in the module spec listed for each group, which is the source of truth:

| Route group                                                                                                                     | Purpose                                                | Contract (docs/modules/)                                                        |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `/api/articles` + `[id]`, `[id]/original`, `[id]/images/[name]`, `[id]/reanchor-highlights`, `parse`                            | Article CRUD, original view, PDF images, reanchor      | `data-layer.md`, `article-parser.md`, `pdf-import.md`, `highlight-anchoring.md` |
| `/api/highlights` + `[id]`, `bulk-delete`, `bulk-tag`                                                                           | Highlight CRUD + bulk ops                              | `data-layer.md`, `highlight-library.md`                                         |
| `/api/sources` + `[id]`, `/api/tags` + `[id]`                                                                                   | Source and tag CRUD                                    | `data-layer.md`                                                                 |
| `/api/review`                                                                                                                   | Daily review queue + actions                           | `daily-review.md`                                                               |
| `/api/feeds/poll`                                                                                                               | Manual RSS poll trigger                                | `rss-engine.md`                                                                 |
| `/api/ai/summarize`, `tag`, `explain`, `clean`, `revert`, `index`, `index/backfill`                                             | AI features (summaries, tagging, cleanup, indexing)    | `ai-features.md`, `content-pipeline.md`, `knowledge-chat.md`                    |
| `/api/chat` + `[id]`, `[id]/file`, `lint`                                                                                       | Knowledge chat sessions + draft lint                   | `knowledge-chat.md`                                                             |
| `/api/theses` + `[id]`, `[id]/highlights(/[highlightId])`, `[id]/research(/[researchId])`, `[id]/suggest-highlights`, `suggest` | Thesis tracker                                         | `thesis-tracker.md`                                                             |
| `/api/drafts` + `[id]`, `[id]/generate`                                                                                         | Content template drafts                                | `content-templates.md`                                                          |
| `/api/tts/[articleId]`, `cache`, `voices`                                                                                       | Text-to-speech synthesis + cache                       | `text-to-speech-immersion-reading.md`                                           |
| `/api/usage/summary`, `breakdown`, `budget`, `estimate`, `top-calls`, `runs/[runId]`                                            | AI usage tracking                                      | `ai-usage.md`                                                                   |
| `/api/voice/profile`, `profile/extract`, `samples` + `[id]`                                                                     | Voice profile                                          | `voice-profile.md`                                                              |
| `/api/newsletters` + `[id]`, `poll`                                                                                             | Newsletter sender approval + IMAP poll                 | `newsletter-ingestion.md`                                                       |
| `/api/settings` + `audit`, `test`, `test-imap`                                                                                  | Settings CRUD, audit log, key/IMAP tests               | `auth.md` (settings storage), feature specs for individual keys                 |
| `/api/auth/login`, `logout`                                                                                                     | Session auth                                           | `auth.md`                                                                       |
| `/api/upload`                                                                                                                   | PDF upload                                             | `pdf-import.md`                                                                 |
| `/api/import/readwise`                                                                                                          | Readwise CSV import                                    | `content-pipeline.md`, ADR-002                                                  |
| `/api/search`                                                                                                                   | Global FTS5 search (articles/highlights/theses/drafts) | `global-search.md`                                                              |
| `/api/health`                                                                                                                   | Health check                                           | —                                                                               |

### Module 2: Article Parser

**Scope**: Given a URL (or raw HTML), extract clean readable content.

**Flow**:

1. Fetch URL (server-side, with appropriate User-Agent)
2. Run through `@mozilla/readability` with `linkedom` as DOM implementation
3. Extract: title, author, content (HTML + text), excerpt, site_name, image_url
4. Compute word_count from text
5. Store in articles table

### Module 3: RSS Feed Engine

**Scope**: Poll RSS feeds, detect new entries, create articles.

**Flow**:

1. `node-cron` triggers polling every N minutes (configurable per feed, default 30min)
2. For each feed: parse with `rss-parser`, compare GUIDs against stored articles
3. New entries → run through Article Parser → store as articles with status=inbox
4. Track `last_polled` and handle ETags/Last-Modified for efficiency

**Feed management UI**: add/remove feeds, organize by category, set poll frequency.

### Module 4: Reader View

**Scope**: Clean article reading experience with inline highlighting.

**Design direction**:

- **Typography**: serif font (Georgia, Charter, or Libre Baskerville), 18-20px body text, max-width 680px, line-height 1.7
- **Color scheme**: system preference auto-switch (light/dark) via `prefers-color-scheme` media query. Light: warm off-white (#FAFAF7) background, dark: deep gray (#1A1A1A) background. No pure white or pure black.
- **Layout**: centered single column, generous margins, no sidebar visible while reading (collapse sidebar to icon)
- **Inspiration**: Readwise Reader / Medium reading experience

**Key features**:

- Rendered article HTML with typography optimized for reading (serif font, comfortable line length, good spacing)
- Text selection → highlight creation (with color picker and optional note)
- Highlight persistence using character offset or range serialization
- Reading progress tracking (scroll position → percentage)
- Keyboard navigation (j/k for next/prev article, h to highlight selection)
- Status transitions (mark as read, archive, favorite)

**Highlight anchoring strategy**:
Store highlights as a v2 **text-quote + text-position** anchor (`position_data` = `{ v, exact, prefix, suffix, start, end }`) — the durable quote plus its surrounding context and char offsets into the article's root text stream, so highlights survive content reformatting. Resolution is exact-primary (position fast path → fuzzy quote match via `approx-string-match` → orphan). Legacy v1 child-index anchors (`{ startContainerPath, … }`) are accepted transitionally and upgraded by a backfill. See docs/modules/highlight-anchoring.md (Module 20). This is the most complex UI piece.

### Module 5: Highlight Library

**Scope**: Browse, search, filter, and manage all highlights across all sources.

**Features**:

- Grid/list view of all highlights with source article context
- Filter by: source, tag, date range, article
- Full-text search (via FTS5)
- Bulk tagging, bulk delete
- Sort by: date created, last reviewed, article

### Module 6: Daily Review (Spaced Repetition)

**Scope**: Surface highlights for review using spaced repetition.

**Flow**:

1. Query highlights where `last_reviewed + review_interval <= today`
2. Present in a card-style UI (show highlight, reveal source article on click)
3. User rates: "Got it" (increase interval: ×2) or "Review again" (reset interval to 1)
4. Session complete when all due highlights reviewed
5. Optional: configure max highlights per day (default 15)

### Module 7: AI Features

**Scope**: Claude API integration for summarization and auto-tagging.

**Features**:

- Article summarization (on-demand or automatic for new articles)
- Auto-tagging (suggest tags based on content, using existing tag vocabulary)
- Highlight-level: "explain this" or "why is this important" via Claude API
- All features are async — fire and update article/highlight when complete

**Implementation**: Simple wrapper around Anthropic SDK, system prompts stored as constants, results cached in DB fields (ai_summary, ai_tags).

### Module 8: Browser Extension

**Scope**: Chrome extension (Manifest V3) to save pages.

**Features**:

- Click extension icon → save current page
- Sends URL to `POST /api/articles` (backend does the parsing)
- Optional: run Readability client-side and send cleaned HTML (faster, works for paywalled content if user is logged in)
- Minimal UI: popup showing "Saved!" with link to reader
- Configure API endpoint URL in extension options

### Module 9: reMarkable Integration

**Scope**: Adapt existing script to push highlights into the system.

**Flow**:

1. Existing script extracts highlights from reMarkable PDFs/EPUBs
2. POST to `/api/highlights` with article metadata
3. If article doesn't exist, create a stub article (title from filename, source=remarkable)
4. Tags derived from reMarkable document metadata if available

## 7. Frontend Structure (Next.js App Router)

19 pages under `src/app/` (feed management lives inside Settings — there is no `feeds/page.tsx`):

```
app/
├── layout.tsx                  — shell: sidebar + main content area
├── page.tsx                    — dashboard / inbox (articles with status=inbox)
├── inbox/page.tsx              — inbox list
├── library/page.tsx            — highlight library
├── reader/[id]/page.tsx        — reader view for a single article
├── review/page.tsx             — daily review session
├── search/page.tsx             — global search results
├── settings/page.tsx           — configuration (feeds, AI, auth, newsletters, TTS…)
├── login/page.tsx              — password login
├── save/page.tsx               — mobile save (manual URL / ?url= param)
├── newsletters/page.tsx        — newsletter sender approval queue
├── chat/page.tsx               — knowledge chat home
├── chat/new/page.tsx           — new chat session
├── chat/[id]/page.tsx          — chat session
├── drafts/page.tsx             — content template drafts list
├── drafts/[id]/page.tsx        — draft editor
├── theses/page.tsx             — thesis tracker list
├── theses/new/page.tsx         — new thesis
├── theses/[id]/page.tsx        — thesis detail
└── theses/suggest/page.tsx     — AI thesis suggestions
```

**Layout**: responsive sidebar (collapsible on mobile) with sections:

- Inbox (unread count badge)
- Reading
- Favorites
- Feeds (expandable by category)
- Highlights
- Daily Review (due count badge)

## 8. Infrastructure & Deployment (IaC)

### 8.1 Overview

The entire infrastructure is defined as code across three layers:

```
┌─────────────────────────────────────────────────────────────┐
│                     IaC Layers                              │
│                                                             │
│  ┌─────────────────┐  Provisions VPS, firewall, SSH key,   │
│  │  OpenTofu        │  DNS record, volume                   │
│  │  (infra/)        │  OVH/OpenStack provider               │
│  └────────┬─────────┘                                       │
│           │ outputs: server IP, volume ID                   │
│  ┌────────▼─────────┐  Bootstraps server on first boot:    │
│  │  cloud-init       │  installs Docker, Caddy, creates     │
│  │  (infra/          │  dirs, pulls images, starts services  │
│  │   cloud-init.yml) │                                      │
│  └────────┬─────────┘                                       │
│           │                                                 │
│  ┌────────▼─────────┐  Defines the running application:    │
│  │  Docker Compose   │  app container + Caddy reverse proxy  │
│  │  (docker/         │  + backup cron                        │
│  │   compose.yml)    │                                      │
│  └──────────────────┘                                       │
└─────────────────────────────────────────────────────────────┘
```

### 8.2 Hosting Target

**OVHcloud VPS** — Starter or Essential tier:

- 1-2 vCPU, 2-4 GB RAM, 40-80 GB NVMe
- ~€3.50-6/month
- Data center: Gravelines (GRA), Strasbourg (SBG), or Roubaix (RBX) — all in France
- Unmetered bandwidth

OVH Public Cloud is OpenStack-based, so provisioning uses the OpenStack provider only. The official `ovh/ovh` provider is not needed (no OVH-API-only resources are managed), which avoids keeping OVH API credentials around.

**Note**: OVH VPS comes with local storage (no separate volume service like Hetzner). Data persistence relies on backups (automated + Litestream) and the fact that VPS local disk survives reboots. For extra safety, an OVH Object Storage bucket (~€0.01/GB/month) can store SQLite backups.

### 8.3 Repository Structure

```
infra/
├── main.tf                  — server, firewall, volume, SSH key, DNS
├── variables.tf             — configurable inputs
├── outputs.tf               — IP, volume ID, server ID
├── terraform.tfvars.example — template for secrets
├── cloud-init.yml           — server bootstrap template
└── .terraform.lock.hcl

docker/
├── Dockerfile               — Next.js standalone build
├── compose.yml              — app + caddy + backup cron
├── Caddyfile                — reverse proxy + HTTPS + basic auth
└── .env.example             — runtime secrets template
```

### 8.4 OpenTofu Configuration

OVH Public Cloud is OpenStack-based. The OpenStack provider manages everything (instance, SSH key, networking/security groups), authenticated with a Public Cloud OpenStack user.

```hcl
# infra/main.tf

terraform {
  required_providers {
    openstack = {
      source  = "terraform-provider-openstack/openstack"
      version = "~> 3.0"
    }
  }
}

provider "openstack" {
  auth_url    = "https://auth.cloud.ovh.net/v3"
  domain_name = "Default"
  tenant_id   = var.ovh_project_id
  user_name   = var.openstack_username
  password    = var.openstack_password
  region      = var.region
}

# --- SSH Key ---
resource "openstack_compute_keypair_v2" "default" {
  name       = "gleanary"
  public_key = var.ssh_public_key
}

# --- Security Group (Firewall) ---
resource "openstack_networking_secgroup_v2" "default" {
  name        = "gleanary"
  description = "Gleanary security group"
}

resource "openstack_networking_secgroup_rule_v2" "ssh" {
  direction         = "ingress"
  ethertype         = "IPv4"
  protocol          = "tcp"
  port_range_min    = 22
  port_range_max    = 22
  remote_ip_prefix  = var.allowed_ssh_cidr
  security_group_id = openstack_networking_secgroup_v2.default.id
}

resource "openstack_networking_secgroup_rule_v2" "https" {
  direction         = "ingress"
  ethertype         = "IPv4"
  protocol          = "tcp"
  port_range_min    = 443
  port_range_max    = 443
  remote_ip_prefix  = "0.0.0.0/0"
  security_group_id = openstack_networking_secgroup_v2.default.id
}

resource "openstack_networking_secgroup_rule_v2" "http" {
  direction         = "ingress"
  ethertype         = "IPv4"
  protocol          = "tcp"
  port_range_min    = 80
  port_range_max    = 80
  remote_ip_prefix  = "0.0.0.0/0"
  security_group_id = openstack_networking_secgroup_v2.default.id
}

# --- VPS Instance ---
resource "openstack_compute_instance_v2" "app" {
  name            = "gleanary"
  image_name      = "Ubuntu 24.04"
  flavor_name     = var.flavor_name  # "d2-2" (2 vCPU, 4GB) or "d2-4"
  region          = var.region
  key_pair        = openstack_compute_keypair_v2.default.name
  security_groups = [openstack_networking_secgroup_v2.default.name]

  user_data = templatefile("cloud-init.yml", {
    domain            = var.domain
    basic_auth_hash   = var.basic_auth_hash
    anthropic_api_key = var.anthropic_api_key
  })

  network {
    name = "Ext-Net"  # OVH public network
  }
}
```

The live `infra/main.tf` adds `lifecycle { ignore_changes = [...] }` to the keypair (`name`) and the instance (`name`, `key_pair`, `image_name`, `user_data`): each of these forces replacement, and replacing the instance wipes the SQLite DB on its local disk. `cloud-init.yml` therefore only matters at first boot; rotate runtime secrets in the server's env file over SSH, and re-bootstrap deliberately with `tofu apply -replace=openstack_compute_instance_v2.app`.

```hcl
# infra/variables.tf

variable "ovh_project_id" {
  type = string
  # Public Cloud project ID from OVH manager
}

# OpenStack credentials
variable "openstack_username" {
  type      = string
  sensitive = true
}

variable "openstack_password" {
  type      = string
  sensitive = true
}

variable "ssh_public_key" {
  type = string
}

variable "allowed_ssh_cidr" {
  type    = string
  default = "0.0.0.0/0"  # restrict to your IP in tfvars
}

variable "flavor_name" {
  type    = string
  default = "d2-2"  # 2 vCPU, 4GB RAM — OVH Discovery range
}

variable "region" {
  type    = string
  default = "GRA11"  # Gravelines, France
}

variable "domain" {
  type = string
}

variable "basic_auth_hash" {
  type      = string
  sensitive = true
}

variable "anthropic_api_key" {
  type      = string
  sensitive = true
}
```

```hcl
# infra/outputs.tf

output "server_ip" {
  value = openstack_compute_instance_v2.app.access_ip_v4
}

output "ssh_command" {
  value = "ssh ubuntu@${openstack_compute_instance_v2.app.access_ip_v4}"
}
```

**OVH API credentials**: generate at https://api.ovh.com/createToken/ with `GET/POST/PUT/DELETE /cloud/project/*` rights. OpenStack credentials are created in the OVH Manager under Public Cloud → Project → Users & Roles.

### 8.5 Cloud-Init (Server Bootstrap)

```yaml
# infra/cloud-init.yml

#cloud-config
package_update: true
package_upgrade: true

packages:
  - docker.io
  - docker-compose-v2
  - fail2ban
  - unattended-upgrades
  - sqlite3 # useful for manual DB inspection

# Enable Docker
runcmd:
  - systemctl enable --now docker

  # Create app directories (on local disk)
  - mkdir -p /opt/gleanary/data/db
  - mkdir -p /opt/gleanary/data/backups
  - mkdir -p /opt/gleanary/data/caddy

  # Write environment file
  - |
    cat > /opt/gleanary/.env << 'EOF'
    ANTHROPIC_API_KEY=${anthropic_api_key}
    DATABASE_URL=file:/data/db/gleanary.db
    DOMAIN=${domain}
    BASIC_AUTH_HASH=${basic_auth_hash}
    EOF

  # Write Caddyfile
  - |
    cat > /opt/gleanary/Caddyfile << 'EOF'
    ${domain} {
      basicauth * {
        reader ${basic_auth_hash}
      }
      reverse_proxy app:3000
    }
    EOF

  # Write docker-compose.yml
  - |
    cat > /opt/gleanary/compose.yml << 'EOF'
    services:
      app:
        image: ghcr.io/${github_user}/gleanary:latest
        # Or build locally: build: .
        restart: unless-stopped
        volumes:
          - /opt/gleanary/data/db:/data/db
        environment:
          - DATABASE_URL=file:/data/db/gleanary.db
          - ANTHROPIC_API_KEY=${anthropic_api_key}
        networks:
          - internal

      caddy:
        image: caddy:2-alpine
        restart: unless-stopped
        ports:
          - "80:80"
          - "443:443"
        volumes:
          - /opt/gleanary/Caddyfile:/etc/caddy/Caddyfile:ro
          - /opt/gleanary/data/caddy:/data
        networks:
          - internal

    networks:
      internal:
    EOF

  # Daily backup cron: SQLite safe copy + keep last 7 days
  - |
    cat > /etc/cron.daily/gleanary-backup << 'CRON'
    #!/bin/bash
    BACKUP_DIR=/opt/gleanary/data/backups
    DB_PATH=/opt/gleanary/data/db/gleanary.db
    sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/gleanary-$(date +%Y%m%d-%H%M).db'"
    find "$BACKUP_DIR" -name "*.db" -mtime +7 -delete
    CRON
    chmod +x /etc/cron.daily/gleanary-backup

  # Start the stack (will pull images on first run)
  # Commented out until first image is pushed:
  # cd /opt/gleanary && docker compose up -d

# Security hardening
ssh_pwauth: false
```

### 8.6 Docker Configuration

```dockerfile
# docker/Dockerfile

FROM node:20-alpine AS base

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# SQLite data directory
RUN mkdir -p /data/db && chown nextjs:nodejs /data/db
VOLUME /data

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
```

### 8.7 Deployment Workflow

```
First time:
  1. cd infra/
  2. cp terraform.tfvars.example terraform.tfvars  (fill in OVH + OpenStack credentials)
  3. tofu init
  4. tofu plan
  5. tofu apply
  → Server is provisioned, firewalled, Docker installed
  6. Copy server IP from output → update DNS A record for your domain
  7. Wait for DNS propagation (~5-15 min)

App updates (CI/CD — automatic):
  1. Push to main
  2. GH Action builds Docker image → pushes to GHCR
  3. SSH into server → docker compose pull && docker compose up -d

App updates (manual):
  1. ssh ubuntu@<server-ip>
  2. cd /opt/gleanary
  3. docker compose pull && docker compose up -d

Backup restore:
  1. scp server:/opt/gleanary/data/backups/gleanary-YYYYMMDD.db ./
  2. scp ./gleanary-YYYYMMDD.db server:/opt/gleanary/data/db/gleanary.db
  3. docker compose restart app
```

### 8.8 Optional Infra Enhancements (Post-MVP)

| Enhancement                         | Purpose                                        | Effort                                                     |
| ----------------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| **Tailscale** instead of basic auth | Zero-trust access, no exposed ports            | 1h — install via cloud-init, remove port 443 from firewall |
| **Litestream** → OVH Object Storage | Continuous SQLite replication, off-site backup | 2h — add sidecar container, create S3-compatible bucket    |
| **Watchtower**                      | Auto-pull new images                           | 30min — add container to compose                           |
| **OVH automated snapshots**         | VPS-level backup                               | 15min — enable in OVH manager, ~€1/month                   |

## 9. CI/CD (GitHub Actions)

### 9.1 Pipeline Design

The CI/CD pipeline is intentionally simple — fast feedback, automated deploy, no bureaucratic gates. Quality is enforced at development time by Claude Code's workflow, not by CI blocking merges.

Two workflows:

```
PR / push (any branch → main)          Push/merge to main
            │                                 │
            ▼                                 ▼
┌────────────────────────────┐    CI (same four parallel jobs)
│ CI: 4 parallel jobs         │                │ on success (workflow_run)
│ lint · typecheck ·          │                ▼
│ test(+coverage) · e2e       │    ┌───────────────────────────┐
└──────────┬─────────────────┘    │ Deploy (deploy.yml)        │
           │                      │ gated: DEPLOY_ENABLED=true │
           ▼                      │ Docker build → GHCR push → │
      ✅ PR status                │ Sentry maps → SSH deploy   │
                                  └───────────────────────────┘
```

The four CI jobs run in parallel (E2E does not wait for the others); deploy is a **separate workflow** triggered by CI completing successfully on `main`, not a job in the same run.

### 9.2 Workflow Files

**`.github/workflows/` is the source of truth** — the YAML is deliberately not mirrored here (it drifted every time). What follows is the design intent; read the workflow files for the exact steps and action versions.

**`ci.yml`** — runs on every PR and push to `main`, with per-ref concurrency cancellation. Four independent jobs, all in parallel (no `needs` chaining — total wall-clock is the slowest job, not the sum):

- **`lint`**, **`typecheck`** — `npm run lint` / `npm run typecheck`.
- **`test`** — `npm run test:coverage`: all Vitest unit + integration tests with v8 coverage; baseline thresholds in `vitest.config.ts` fail the job on regression, and the coverage report is uploaded as a workflow artifact.
- **`e2e`** — production build (`npm run build`) served by `next start`, then the full Playwright suite. Two load-bearing details:
  - **Real-auth mode**: the Playwright config derives `SETTINGS_AUTH_HASH` from `E2E_AUTH_PASSWORD` (plus a fixed `SETTINGS_ENCRYPTION_KEY`) for the spawned server, so the whole suite runs against the built-in auth gate, including the login journey.
  - Playwright browsers are cached (`actions/cache` keyed on `package-lock.json`); the HTML report and traces upload as artifacts whenever the run isn't cancelled.

**`deploy.yml`** — a separate, owner-specific workflow triggered by `workflow_run` when CI completes successfully on `main`. Gated on the repository variable `DEPLOY_ENABLED == 'true'` so forks and the public repo skip it entirely. Steps: Docker build → push to GHCR → Sentry source-map upload (`continue-on-error`, never blocks a deploy) → SSH to the server as `ubuntu` → `docker compose pull && up -d`.

### 9.3 Required GitHub Secrets & Variables

| Name                | Kind     | Source / purpose                                       |
| ------------------- | -------- | ------------------------------------------------------ |
| `SERVER_IP`         | secret   | `tofu output server_ip`                                |
| `SSH_PRIVATE_KEY`   | secret   | Private key matching the public key in OpenTofu config |
| `SENTRY_AUTH_TOKEN` | secret   | Sentry source-map upload                               |
| `SENTRY_ORG`        | secret   | Sentry source-map upload                               |
| `DEPLOY_ENABLED`    | variable | `'true'` enables deploy.yml (unset on forks)           |

`GITHUB_TOKEN` is provided automatically and has `packages:write` for GHCR. The E2E env values (`E2E_AUTH_PASSWORD`, `SETTINGS_ENCRYPTION_KEY`) are non-secret CI-only fixtures defined inline in `ci.yml`.

### 9.4 Package Scripts

See `package.json` for the authoritative list. The CI-relevant ones: `lint` (ESLint + Prettier check), `typecheck`, `test` (Vitest unit + integration), `test:coverage` (same, plus v8 coverage with enforced thresholds), `build`. `predev`/`prestart` run `scripts/migrate.mjs` automatically before the dev/prod server starts.

## 10. Observability

### 10.1 Strategy

Three SaaS free tiers cover all observability needs without adding any containers to the VPS:

```
┌──────────────────────────────────────────────────────────┐
│                  Observability Stack                      │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │   Sentry      │  │ Better Stack │  │ Uptime Robot │   │
│  │              │  │              │  │              │   │
│  │ • Errors     │  │ • Structured │  │ • HTTP ping  │   │
│  │ • Exceptions │  │   logs       │  │   every 5min │   │
│  │ • Perf traces│  │ • Log search │  │ • Alerting   │   │
│  │ • Web Vitals │  │ • Dashboards │  │   (email,    │   │
│  │              │  │ • Alerting   │  │    webhook)  │   │
│  │ Free: 5K     │  │              │  │              │   │
│  │ events/mo    │  │ Free: 1GB    │  │ Free: 50     │   │
│  │              │  │ logs/mo      │  │ monitors     │   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │
│         │                 │                 │            │
└─────────┼─────────────────┼─────────────────┼────────────┘
          │                 │                 │
          ▼                 ▼                 ▼
    ┌─────────────────────────────────────────────┐
    │              Next.js App                     │
    │                                             │
    │  @sentry/nextjs     pino + Better Stack     │
    │  (auto-instruments   HTTP drain             │
    │   API routes,                               │
    │   React errors,       GET /api/health       │
    │   web vitals)         (for Uptime Robot)    │
    └─────────────────────────────────────────────┘
```

### 10.2 Sentry (Error Tracking + Performance)

**Free tier**: 5,000 events/month — more than enough for single-user.

**What it captures**:

- Unhandled exceptions (server + client)
- API route performance traces
- Web Vitals (LCP, FID, CLS) from the reader view
- Release tracking (tied to Git SHA via CI)

**Integration**:

```bash
npx @sentry/wizard@latest -i nextjs
```

This auto-instruments API routes, React error boundaries, and client-side performance. Zero manual instrumentation needed for baseline coverage.

**Environment variables** (added to `.env` and Docker Compose):

```
SENTRY_DSN=https://xxx@o123.ingest.sentry.io/456
SENTRY_AUTH_TOKEN=sntrys_xxx  # for source maps upload in CI
```

**CI integration** — source map upload is included in the deploy job (see Section 9.2) so Sentry can show readable stack traces.

### 10.3 Better Stack (Structured Logging)

**Free tier**: 1 GB logs/month, 3-day retention — perfect for debugging.

**What it captures**:

- All application logs (structured JSON via pino)
- Request/response metadata
- Feed polling events, AI API calls, highlight operations
- Slow query warnings

**Integration**:

```typescript
// lib/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined, // JSON in production
  base: {
    env: process.env.NODE_ENV,
    service: 'gleanary',
  },
});

// Usage in API routes:
// logger.info({ articleId, url }, 'Article saved');
// logger.error({ err, feedId }, 'Feed polling failed');
```

**Log shipping** — two options, both zero-dependency:

Option A — **Docker log driver** (simplest, no app changes):

```yaml
# In compose.yml, add to the app service:
services:
  app:
    logging:
      driver: 'syslog'
      options:
        syslog-address: 'tcp+tls://in-v2.logs.betterstack.com:6514'
        syslog-format: 'rfc5424'
        tag: 'gleanary'
    environment:
      - BETTERSTACK_SOURCE_TOKEN=${BETTERSTACK_SOURCE_TOKEN}
```

Option B — **HTTP drain from pino** (more control):

```typescript
// pino transport that POSTs to Better Stack
import { pino } from 'pino';

const transport = pino.transport({
  target: '@logtail/pino',
  options: { sourceToken: process.env.BETTERSTACK_SOURCE_TOKEN },
});

export const logger = pino(transport);
```

### 10.4 Uptime Robot (Availability Monitoring)

**Free tier**: 50 monitors, 5-minute intervals.

**Setup**:

1. Create a health check endpoint in the app
2. Point Uptime Robot at it
3. Configure alert contacts (email, webhook, Telegram)

```typescript
// app/api/health/route.ts
import { db } from '@/lib/db';

export async function GET() {
  try {
    // Verify DB is accessible
    const result = db.prepare('SELECT 1').get();

    return Response.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      db: result ? 'connected' : 'error',
    });
  } catch (error) {
    return Response.json({ status: 'error', message: 'Database unavailable' }, { status: 503 });
  }
}
```

**Monitors to create**:

- `https://yourdomain.com/api/health` — HTTP 200 check every 5 min
- Optional: keyword check that response contains `"status":"ok"`

### 10.5 Application-Level Metrics (Lightweight)

For deeper insight without adding Prometheus, log key metrics as structured events that Better Stack can aggregate:

```typescript
// Patterns to instrument:
logger.info({ event: 'feed_polled', feedId, newArticles: 3, durationMs: 450 });
logger.info({ event: 'article_parsed', articleId, wordCount: 2300, durationMs: 120 });
logger.info({ event: 'ai_summarize', articleId, tokenCount: 850, durationMs: 3200 });
logger.info({ event: 'highlight_created', articleId, highlightId });
logger.info({ event: 'review_completed', highlightsReviewed: 12, sessionDurationMs: 180000 });
logger.warn({ event: 'feed_error', feedId, error: err.message, retryIn: 3600 });
```

Better Stack's free tier lets you search and filter these, and set alerts on patterns (e.g., alert if `feed_error` count > 10 in 1 hour).

### 10.6 Environment Variables Summary

```bash
# Observability — add to .env and compose.yml
SENTRY_DSN=https://xxx@o123.ingest.sentry.io/456
BETTERSTACK_SOURCE_TOKEN=xxx
# Uptime Robot is external, no app config needed
```

## 11. Testing Strategy

### 11.1 Testing Pyramid

```
         ╱ ╲
        ╱ E2E╲         Playwright — one spec per journey
       ╱  (few)╲        Critical user journeys only
      ╱─────────╲
     ╱Integration╲     Vitest — API routes with
    ╱  (moderate)  ╲    real SQLite
   ╱────────────────╲
  ╱      Unit        ╲  Vitest — pure logic, zero I/O
 ╱    (many, fast)    ╲  (components via jsdom)
╱──────────────────────╲
```

Approximate scale as of 2026-07: ~870 unit + ~690 integration `it()` blocks (115 files, all green in one `npm run test` run) and 44 E2E tests across 11 journey specs. The shape matters more than the counts — unit ≫ integration ≫ E2E.

### 11.2 Tooling

| Tool                          | Purpose                                | Runs in CI         |
| ----------------------------- | -------------------------------------- | ------------------ |
| **Vitest**                    | Unit + integration tests               | Yes, every push    |
| **Playwright**                | E2E browser tests                      | Yes, every push/PR |
| **SQLite in-memory**          | Test database for integration tests    | —                  |
| **MSW (Mock Service Worker)** | Mock Anthropic API, external feed URLs | —                  |

### 11.3 Unit Tests — Pure Logic

These are fast (<5s total), no I/O, no DB. Claude Code writes these first (TDD).

| Module                       | What to test                                | Examples                                                                                                                  |
| ---------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Spaced repetition engine** | Interval calculation, edge cases            | New highlight → interval=1; "Got it" 3x → interval=8; "Review again" → reset to 1; never exceed max interval              |
| **Highlight anchoring**      | Serialization/deserialization of DOM ranges | Round-trip: create range → serialize → deserialize → same range; handle edge cases (empty text, nested elements, unicode) |
| **Feed poller**              | Dedup, conditional headers, error handling  | Same URL → skip; ETag/Last-Modified forwarding; parse error → continue                                                    |
| **Feed scheduler**           | Next poll time calculation, start/stop      | Default 30min; cron job lifecycle; concurrent poll prevention                                                             |
| **Article parser**           | Content extraction, word count, metadata    | Given raw HTML → extract title, author, content, word count; handle missing fields gracefully                             |
| **Search query building**    | FTS5 query escaping                         | Escape special chars; handle quoted phrases; empty/whitespace input                                                       |
| **URL validator**            | SSRF prevention                             | Block private IPs, internal hosts; allow valid public URLs; reject non-HTTP protocols                                     |
| **Sanitize**                 | XSS prevention via DOMPurify                | Strip forbidden tags/attrs; allow safe HTML; block javascript: URIs                                                       |
| **API error handler**        | Error type → HTTP status mapping            | ValidationError → 422; NotFoundError → 404; no info leakage on 500s                                                       |
| **Text utils**               | Word count, reading time, date formatting   | Edge cases: empty strings, unicode, large texts                                                                           |
| **AI library**               | Content truncation, tag response parsing    | Truncate at 100K chars; parse JSON arrays from Claude; deduplicate tags                                                   |
| **Browser extension**        | API client, URL validation                  | Save article flow; health check; reject chrome:// URLs; 5MB HTML limit                                                    |
| **Validators**               | Zod schema validation logic                 | parseIdParam, partialWithAtLeastOne, all route schemas                                                                    |
| **Reader view**              | Component logic helpers                     | Viewport clamping, block ancestor finding, progress tracking                                                              |

```typescript
// Example: spaced repetition unit tests
// __tests__/unit/spaced-repetition.test.ts

import { describe, it, expect } from 'vitest';
import { calculateNextReview } from '@/lib/spaced-repetition';

describe('calculateNextReview', () => {
  it('starts with interval of 1 day for new highlights', () => {
    const result = calculateNextReview({ reviewCount: 0, currentInterval: 0 }, 'got_it');
    expect(result.interval).toBe(1);
    expect(result.reviewCount).toBe(1);
  });

  it('doubles interval on successful review', () => {
    const result = calculateNextReview({ reviewCount: 3, currentInterval: 4 }, 'got_it');
    expect(result.interval).toBe(8);
  });

  it('resets interval on "review again"', () => {
    const result = calculateNextReview({ reviewCount: 5, currentInterval: 16 }, 'review_again');
    expect(result.interval).toBe(1);
    expect(result.reviewCount).toBe(0);
  });

  it('caps interval at max days', () => {
    const result = calculateNextReview({ reviewCount: 10, currentInterval: 180 }, 'got_it');
    expect(result.interval).toBeLessThanOrEqual(365);
  });
});
```

### 11.4 Integration Tests — API Routes + DB

These test API routes against a real SQLite database (in-memory or temp file). Slower (~15-30s total) but catch schema mismatches, query bugs, and middleware issues.

**Setup pattern**:

```typescript
// __tests__/integration/setup.ts
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '@/db/schema';

export function createTestDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  return { db, sqlite };
}
```

**What to test per module**:

| Module                  | Test file                     | Tests                                                                                                                                            |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Articles API**        | `articles.test.ts`            | CRUD, filter/pagination, cascade deletes, status transitions, reading progress                                                                   |
| **Highlights API**      | `highlights.test.ts`          | Create with tags, update note/color/tags, delete with cascade                                                                                    |
| **Highlight Library**   | `highlight-library.test.ts`   | Enhanced GET with context, bulk-delete, bulk-tag (add/replace modes), date range filters                                                         |
| **Sources API**         | `sources.test.ts`             | CRUD, RSS feed sources, cascade behavior on delete                                                                                               |
| **Tags API**            | `tags.test.ts`                | CRUD, update name/color, delete with cascade, duplicate name 409                                                                                 |
| **Global Search**       | `global-search.test.ts`       | Grouped FTS5 search across articles/highlights/theses/drafts, type/status/source/date filters, palette mode, pagination, drafts_fts trigger sync |
| **Article Parser**      | `article-parser.test.ts`      | POST /api/articles/parse → fetch + parse + store; duplicate URL 409; HTML fallback                                                               |
| **Feed Polling**        | `feed-poll.test.ts`           | POST /api/feeds/poll → creates articles; dedup; ETag/Last-Modified; error handling                                                               |
| **Review**              | `review.test.ts`              | GET due highlights; POST review actions; spaced repetition interval updates                                                                      |
| **AI Features**         | `ai.test.ts`                  | Summarize (cached), auto-tag (create + link), explain; all via MSW-mocked Claude API                                                             |
| **Highlight Anchoring** | `highlight-anchoring.test.ts` | Position data round-trips through DB; cross-element ranges; persistence                                                                          |

```typescript
// Example: article API integration test
// __tests__/integration/articles.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './setup';

describe('POST /api/articles', () => {
  let db: ReturnType<typeof createTestDb>['db'];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it('creates an article from a URL', async () => {
    // Mock the URL fetch via MSW
    const res = await apiCall('POST', '/api/articles', {
      url: 'https://example.com/article',
    });

    expect(res.status).toBe(201);
    const article = await res.json();
    expect(article.title).toBeDefined();
    expect(article.content_html).toBeDefined();
    expect(article.word_count).toBeGreaterThan(0);
    expect(article.status).toBe('inbox');
  });

  it('deduplicates by URL', async () => {
    await apiCall('POST', '/api/articles', { url: 'https://example.com/article' });
    const res = await apiCall('POST', '/api/articles', { url: 'https://example.com/article' });

    expect(res.status).toBe(409); // Conflict
  });

  it('returns 422 for unreachable URLs', async () => {
    const res = await apiCall('POST', '/api/articles', {
      url: 'https://nonexistent.invalid/page',
    });

    expect(res.status).toBe(422);
  });
});
```

### 11.5 E2E Tests — Critical User Journeys

Playwright tests run in a real browser against the running app. Only test the paths that would be painful to break and hard to catch otherwise. These run in CI on every pull request and push to `main` (gating deploy), against the production build served by `next start`; locally they run against the dev server. (The Docker standalone artifact itself is still only exercised at deploy — see TECH_DEBT.md.)

**Critical paths covered** (one spec per journey, 11 today; `auth.setup.ts` is a shared setup project, not a journey):

| #   | Journey                 | Test file                             | What it validates                                                                                         |
| --- | ----------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | **Save and read**       | `save-and-read.spec.ts`               | Save article via API → appears in inbox → open reader → status updates → highlight creation + persistence |
| 2   | **Highlights**          | `highlights.spec.ts`                  | Text selection → highlight creation, double-click paragraph, select mode, keyboard shortcut, persistence  |
| 3   | **Search**              | `search.spec.ts`                      | FTS5 search for highlights and articles, combined type=all search, result display                         |
| 4   | **Global Search**       | `global-search.spec.ts`               | Cmd/Ctrl+K palette → query → arrow nav → Enter to result; "See all" → /search page tabs with counts       |
| 5   | **Daily review**        | `review.spec.ts`                      | Card reveal/action flow, "Got it"/"Review again", spaced repetition interval mechanics                    |
| 6   | **Authentication**      | `auth.spec.ts`                        | Unauthenticated redirect to login, wrong/correct password, API blocked without credentials, sign-out      |
| 7   | **Draft flow**          | `draft-flow.spec.ts`                  | Content template draft: create → stream → edit title → publish → thesis marked used → delete              |
| 8   | **Mobile save**         | `mobile-save.spec.ts`                 | `/save` page: manual URL paste (parse API stubbed), auto-save via `?url=` param, duplicate message        |
| 9   | **PDF import**          | `pdf-import.spec.ts`                  | Upload → inbox shows page count → reader toggles original/extracted view → text selectable                |
| 10  | **Highlight anchoring** | `highlight-survives-reformat.spec.ts` | Reanchor route corrects a drifted anchor after content reformat; highlight still renders in reader        |
| 11  | **Selection handles**   | `selection-handles.spec.ts`           | Edit-mode selection handles appear/disappear, survive clicks, drag to change selection, stay interactive  |

```typescript
// Example: E2E save and highlight flow
// e2e/save-and-highlight.spec.ts

import { test, expect } from '@playwright/test';

test('save article and create highlight', async ({ page, request }) => {
  // 1. Save an article via API (simulates browser extension)
  const res = await request.post('/api/articles', {
    data: { url: 'https://example.com/test-article' },
  });
  const article = await res.json();

  // 2. Navigate to reader view
  await page.goto(`/reader/${article.id}`);
  await expect(page.locator('article')).toBeVisible();

  // 3. Select text and create highlight
  await page.evaluate(() => {
    const range = document.createRange();
    const textNode = document.querySelector('article p')!.firstChild!;
    range.setStart(textNode, 0);
    range.setEnd(textNode, 20);
    window.getSelection()!.addRange(range);
  });
  await page.locator('[data-testid="highlight-button"]').click();

  // 4. Verify highlight persists
  await page.reload();
  await expect(page.locator('mark.highlight')).toBeVisible();
});
```

### 11.6 External Service Mocking

All external dependencies are mocked in tests — no real network calls. This is enforced, not conventional: a shared MSW server (`__tests__/mocks/server.ts`) runs for **every vitest file** via `setupFiles` (`__tests__/mocks/msw-setup.ts`) with `onUnhandledRequest: 'error'`, so any request without an explicit handler is rejected instead of silently hitting the real network. The server has **no default handlers** — a canned catch-all response would let a test that forgets its mock pass green on nonsense. A guard test (`__tests__/mocks/msw-tripwire.test.ts`) asserts the tripwire stays armed.

| Dependency                           | Mock approach                                |
| ------------------------------------ | -------------------------------------------- |
| **External URLs** (article fetching) | MSW intercepts fetch, returns fixture HTML   |
| **RSS feeds**                        | MSW returns fixture XML                      |
| **Anthropic Claude API**             | MSW returns fixture responses                |
| **Sentry**                           | Disabled in test env (`SENTRY_DSN` not set)  |
| **Better Stack**                     | Disabled in test env (pino writes to stdout) |

```typescript
// In the test file — handlers are per-file and explicit, registered on the
// shared server via setupHandlers() (never call setupServer yourself; never
// register handlers in beforeAll — the global afterEach resets them).
import { http, HttpResponse } from 'msw';
import { server, setupHandlers } from '../mocks/server';

setupHandlers(
  http.get('https://example.com/test-article', () => HttpResponse.html(fixtureArticleHtml)),
  http.post('https://api.anthropic.com/v1/messages', () =>
    HttpResponse.json({ content: [{ type: 'text', text: 'This article discusses...' }] }),
  ),
);

// Per-test overrides go through server.use(...) inside the it() body.
```

### 11.7 Test Organization

```
__tests__/
├── unit/
│   ├── ai.test.ts
│   ├── api-error-handler.test.ts
│   ├── article-parser.test.ts
│   ├── browser-extension.test.ts
│   ├── clamp-to-viewport.test.ts
│   ├── feed-poller.test.ts
│   ├── feed-scheduler.test.ts
│   ├── find-block-ancestor.test.ts
│   ├── highlight-anchoring.test.ts
│   ├── reader-view.test.ts
│   ├── sanitize.test.ts
│   ├── search.test.ts
│   ├── spaced-repetition.test.ts
│   ├── text-utils.test.ts
│   ├── url-validator.test.ts
│   └── validators.test.ts
├── integration/
│   ├── setup.ts                    — test DB factory
│   ├── ai.test.ts
│   ├── article-parser.test.ts
│   ├── articles.test.ts
│   ├── feed-poll.test.ts
│   ├── highlight-anchoring.test.ts
│   ├── highlight-library.test.ts
│   ├── highlights.test.ts
│   ├── review.test.ts
│   ├── search.test.ts
│   ├── sources.test.ts
│   └── tags.test.ts
├── mocks/
│   ├── server.ts                   — shared MSW server + setupHandlers() (no default handlers)
│   ├── msw-setup.ts                — global MSW lifecycle (vitest setupFiles, onUnhandledRequest: 'error')
│   ├── msw-tripwire.test.ts        — guard test for the tripwire
│   └── fixtures/
│       ├── article.html
│       ├── minimal-article.html
│       ├── rich-article.html
│       ├── feed.xml
│       ├── rss-feeds.ts
│       └── claude-response.json
└── e2e/
    ├── auth.setup.ts
    ├── auth.spec.ts
    ├── draft-flow.spec.ts
    ├── global-search.spec.ts
    ├── highlight-survives-reformat.spec.ts
    ├── highlights.spec.ts
    ├── mobile-save.spec.ts
    ├── pdf-import.spec.ts
    ├── review.spec.ts
    ├── save-and-read.spec.ts
    ├── search.spec.ts
    └── selection-handles.spec.ts
```

### 11.8 CI Integration

The CI pipeline (see §9.2) runs four parallel jobs on every push/PR: `lint`, `typecheck`, `test` (all Vitest unit + integration tests, with coverage — see §11.9), and `e2e` (`npm run build`, then `npx playwright test` against the production build served by `next start`, in real-auth mode — one spec per critical journey, see §11.5).

E2E runs on PRs too, so a broken critical journey fails CI before merge; the Playwright HTML report and traces are uploaded as workflow artifacts for debugging. Deploy is a separate workflow triggered on CI success on `main` (§9.2).

### 11.9 Coverage

Coverage is collected and **enforced** in CI: the `test` job runs `npm run test:coverage` (`@vitest/coverage-v8`, scoped to `src/**/*.ts` — `.tsx` UI components are excluded from the gate), and baseline thresholds in `vitest.config.ts` fail the build on regression:

| Metric     | Threshold | Baseline (2026-07-15) |
| ---------- | --------- | --------------------- |
| Statements | 78%       | 78.7%                 |
| Branches   | 70%       | 70.6%                 |
| Functions  | 78%       | 78.9%                 |
| Lines      | 80%       | 80.6%                 |

Thresholds sit just below the measured baseline; raise them as coverage improves. The HTML report is uploaded as a CI artifact and can be generated locally with `npm run test:coverage`. E2E has no coverage target — it is measured by journey count (§11.5), not line coverage.

## 12. Documentation & Quality Discipline

### 12.1 Philosophy

Quality and documentation are enforced **at development time via Claude Code's workflow**, not via CI gates. CI runs lint + typecheck + tests as a safety net, but the real discipline lives in the `CLAUDE.md` instructions that Claude Code follows for every module.

### 12.2 Claude Code Workflow Per Module

Every time Claude Code works on a module, it follows this sequence:

```
1. READ    — Read existing CLAUDE.md, architecture.md, and module's current state
2. PLAN    — Write/update docs/modules/<module>.md with approach and API contract
3. TEST    — Write failing tests for the module's public API
4. BUILD   — Implement until tests pass
5. REFACTOR — Clean up: extract shared utilities, remove duplication, ensure naming consistency
6. DOCUMENT — Update:
              • CHANGELOG.md with what changed
              • README.md if setup steps changed
              • JSDoc on all exported functions
              • ADR if a non-obvious technical decision was made
7. VERIFY  — Run full lint + typecheck + test suite
```

This is codified in `CLAUDE.md` so Claude Code executes it autonomously.

### 12.3 Documentation Structure

```
docs/
├── architecture.md           — this document (system-level)
├── adrs/                     — Architecture Decision Records (ADR-001…)
├── modules/                  — per-module design specs (one per module;
│                               see the Module Registry in CLAUDE.md)
└── sessions/                 — session workflow definitions

CLAUDE.md                     — Claude Code operating instructions
CHANGELOG.md                  — updated every module iteration
README.md                     — setup, dev, deploy quickstart
```

(There is no `docs/runbooks/` — operational steps live in README.md and §8.7.)

### 12.4 ADR Format

```markdown
# ADR-NNN: Title

**Status**: Accepted | Superseded by ADR-XXX
**Date**: YYYY-MM-DD
**Context**: What is the problem or decision we're facing?
**Decision**: What did we decide?
**Consequences**: What are the tradeoffs? What do we gain and lose?
```

Claude Code creates an ADR whenever it makes a choice that isn't obvious from the architecture doc — library selection, data format decisions, algorithm choices, etc.

### 12.5 Refactoring Discipline

At the end of each phase (not each module), Claude Code performs a dedicated refactoring pass:

- **Phase boundary checklist**:
  - Extract any duplicated code into `lib/` utilities
  - Ensure consistent error handling patterns across all API routes
  - Review and consolidate types in `types/` — no inline type definitions in routes
  - Check for unused dependencies (`npx depcheck`)
  - Verify all environment variables are documented in `.env.example`
  - Run `npm audit` and update vulnerable dependencies
  - Review TODO/FIXME comments — resolve or convert to GitHub issues

- **Tech debt tracking**: Claude Code maintains a `TECH_DEBT.md` file listing known shortcuts and their planned resolution. Each entry has a severity (low/medium/high) and which phase it should be addressed in.

### 12.6 Code Quality Standards

Enforced by tooling, configured once, Claude Code respects them automatically:

```jsonc
// Configured in project setup:
{
  "eslint": "next/core-web-vitals + strict TypeScript rules",
  "prettier": "consistent formatting, no debates",
  "typescript": "strict mode, no any, no implicit returns",
  "vitest": "unit + integration tests, coverage target 80% on business logic",
}
```

No pre-commit hooks — Claude Code runs these as part of its workflow. CI catches anything that slips through.

## 13. Build Order (Recommended)

The modules should be built in this order to maximize incremental usability:

```
Phase 0 — Infrastructure (Day 1)
  ├── OpenTofu setup + provision VPS
  ├── GitHub repo + CI/CD pipeline
  ├── Sentry + Better Stack + Uptime Robot accounts
  └── Docker Compose verified end-to-end

Phase 1 — Foundation (Week 1)
  ├── Project scaffold (SESSION: scaffold)
  ├── Module 1: Data Layer + API
  ├── Module 2: Article Parser
  ├── Refactoring pass #1
  └── Security audit #1 (input validation, SSRF, SQL injection)

Phase 2 — Core Reading (Week 2)
  ├── Module 3: RSS Feed Engine
  ├── Module 4: Reader View (basic, without highlighting)
  ├── Refactoring pass #2
  └── Security audit #2 (XSS critical — reader view renders external HTML)

Phase 3 — Highlighting (Week 3)
  ├── Module 4: Reader View (add highlighting)
  ├── Module 5: Highlight Library
  ├── Module 8: Browser Extension
  ├── Refactoring pass #3
  └── Security audit #3 (full audit — extension, headers, secrets)

Phase 4 — Intelligence (Week 4)
  ├── Module 6: Daily Review
  ├── Module 7: AI Features
  ├── Module 9: reMarkable Integration
  ├── Refactoring pass #4 (final cleanup)
  └── Security audit #4 (final — full audit, dependency audit, all 7 checks)
```

After Phase 2 you already have a functional RSS reader.
After Phase 3 you have a full Readwise Reader alternative.
After Phase 4 you have the complete system.

## 14. Key Technical Decisions & Tradeoffs

| Decision                            | Tradeoff                                   | Migration path                                                             |
| ----------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| SQLite over PostgreSQL              | No concurrent writers, no pgvector         | Drizzle makes PG migration straightforward                                 |
| In-process cron over job queue      | No retry/dead-letter for feed polling      | Add BullMQ + Redis if needed                                               |
| Server-side article fetching        | Can't access paywalled content             | Extension can send pre-rendered HTML                                       |
| Character offset for highlights     | Fragile if article HTML changes            | Article content is immutable after save                                    |
| No auth                             | Must protect at network level              | Add NextAuth if ever multi-user                                            |
| OpenTofu + cloud-init over Ansible  | No config drift management post-bootstrap  | Add Ansible if server config grows complex                                 |
| OVH local disk for data             | Data lost if VPS is deleted (not rebooted) | Daily backups to external storage; add Litestream to S3/OVH Object Storage |
| SaaS observability over self-hosted | Vendor dependency, free tier limits        | Migrate to Grafana stack if limits hit                                     |
| Claude Code workflow over CI gates  | No hard block on bad docs/quality          | CI still catches lint/type/test failures                                   |

## 15. Non-Functional Requirements

- **Performance**: SQLite + FTS5 handles thousands of articles and highlights with sub-ms queries at single-user scale
- **Storage**: ~50KB per article (HTML + text), ~500 bytes per highlight. 10,000 articles ≈ 500MB. SQLite handles this easily
- **Availability**: `restart: unless-stopped` in Docker. No HA needed for single-user
- **Backup**: Automated daily via cron (SQLite `.backup` command, retains 7 days on disk). Data lives on VPS local disk — recommend enabling OVH automated VPS snapshots and/or adding Litestream for continuous replication to OVH Object Storage or S3
- **Reproducibility**: Full infra is IaC — `tofu apply` recreates the server from scratch. Restore DB from latest backup after rebuild
- **Observability**: Sentry for errors/perf, Better Stack for logs, Uptime Robot for availability. All SaaS, zero infra overhead. ~5K errors/mo + 1GB logs/mo + 50 monitors free

## 16. Security

### 16.1 Threat Model

This is a single-user app exposed on the internet, but it has a real attack surface because it **fetches and renders arbitrary HTML from the internet**.

```
Attack Surface:

1. NETWORK            2. APPLICATION         3. DATA
   Exposed ports         XSS via reader         SQL injection (FTS5)
   SSH brute force       SSRF via fetcher       Secrets leakage
   TLS config            Input validation       Backup exposure
                         Dependency vulns

4. BROWSER EXTENSION
   Content script permissions
   API endpoint exposure
```

### 16.2 XSS Prevention (Critical — #1 Risk)

The reader view renders external HTML. Even after Readability extraction, malicious content could include scripts, event handlers, or CSS attacks.

**Defense: server-side sanitization with DOMPurify on ingestion**

```typescript
// src/lib/sanitize.ts
import DOMPurify from 'isomorphic-dompurify';

const ALLOWED_TAGS = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'br',
  'hr',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'a',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'img',
  'figure',
  'figcaption',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'span',
  'div',
  'section',
  'article',
  'sup',
  'sub',
  'mark',
];

const ALLOWED_ATTR = [
  'href',
  'src',
  'alt',
  'title',
  'class',
  'width',
  'height',
  'loading',
  'data-highlight-id', // for highlight anchoring
];

export function sanitizeArticleHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input'],
    FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'style'],
  });
}
```

**Sanitization pipeline**:

1. Fetch raw HTML from URL
2. Extract with `@mozilla/readability`
3. **Sanitize with DOMPurify** (strips scripts, event handlers, dangerous CSS)
4. Store sanitized HTML in database
5. Render with `dangerouslySetInnerHTML` — safe because content was sanitized on ingestion

**Content Security Policy** — set via Caddy headers:

```
Content-Security-Policy: default-src 'self'; img-src 'self' https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://*.sentry.io; frame-src 'none'; object-src 'none'; worker-src 'self' blob:
```

`script-src` requires `'unsafe-inline'`: the Next.js App Router hydrates through dynamic inline scripts that cannot be hash-allowlisted, and any hash/nonce in the directive makes browsers ignore `'unsafe-inline'` (hash-pinning broke hydration app-wide). Re-tightening via a per-request nonce is tracked in `TECH_DEBT.md`.

### 16.3 SSRF Prevention

The article fetcher requests URLs provided by the user. Without protection, this could probe internal networks.

```typescript
// src/lib/url-validator.ts
import { URL } from 'url';
import dns from 'dns/promises';

const BLOCKED_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
const PRIVATE_PREFIXES = [
  '10.',
  '172.16.',
  '172.17.',
  '172.18.',
  '172.19.',
  '172.2',
  '172.3',
  '192.168.',
  '169.254.',
];

export async function validateUrl(urlString: string): Promise<URL> {
  const url = new URL(urlString);

  // Only allow http/https
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP/HTTPS URLs are allowed');
  }

  // Block known internal hosts
  if (BLOCKED_HOSTS.includes(url.hostname)) {
    throw new Error('Internal URLs are not allowed');
  }

  // Resolve DNS and check for private IPs
  const addresses = await dns.resolve4(url.hostname).catch(() => []);
  for (const addr of addresses) {
    if (PRIVATE_PREFIXES.some((p) => addr.startsWith(p))) {
      throw new Error('URL resolves to private network');
    }
  }

  return url;
}
```

**Additional measures**: 10s fetch timeout, 5MB max response, limit to 3 redirects.

### 16.4 Input Validation

All API inputs validated with **Zod schemas** as the first step in every route:

```typescript
const CreateArticleSchema = z.object({
  url: z.string().url().max(2048),
  html: z.string().max(5_000_000).optional(),
});

const CreateHighlightSchema = z.object({
  articleId: z.string().uuid(),
  text: z.string().min(1).max(10_000),
  note: z.string().max(10_000).optional(),
  color: z.enum(['yellow', 'green', 'blue', 'pink']).default('yellow'),
  positionData: z.object({
    startOffset: z.number().int().min(0),
    endOffset: z.number().int().min(0),
    startContainerPath: z.string(),
    endContainerPath: z.string(),
  }),
});
```

### 16.5 SQL Injection Prevention

**Primary defense: Drizzle ORM** — all queries are parameterized, no string concatenation.

**FTS5 queries** are the exception — user input touches SQL syntax. Always escape:

```typescript
export function escapeFts5Query(query: string): string {
  return query
    .replace(/"/g, '""')
    .replace(/[*():^]/g, ' ')
    .trim();
}
```

### 16.6 Dependency Security

- **`npm audit`** runs during refactoring passes
- **Dependabot** enabled on GitHub repo for automated security PRs
- **Lock file committed**: deterministic installs via `package-lock.json`

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: 'npm'
    directory: '/'
    schedule:
      interval: 'weekly'
    open-pull-requests-limit: 10
```

### 16.7 Network Security (Summary)

| Layer                   | Protection                                                                 |
| ----------------------- | -------------------------------------------------------------------------- |
| **Firewall**            | Only ports 22 (SSH, restricted IP), 80, 443                                |
| **SSH**                 | Key-only auth, `ssh_pwauth: false`                                         |
| **HTTPS**               | Caddy auto-provisions Let's Encrypt, TLS 1.2+                              |
| **Basic auth**          | All routes behind Caddy basic auth (bcrypt hash)                           |
| **fail2ban**            | Protects against SSH brute force                                           |
| **Unattended upgrades** | Automatic Ubuntu security patches                                          |
| **Security headers**    | CSP, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy |

### 16.8 Secrets Management

| Secret              | Stored in                                                    | Never in               |
| ------------------- | ------------------------------------------------------------ | ---------------------- |
| OVH API credentials | `terraform.tfvars` (gitignored)                              | Git, logs              |
| Anthropic API key   | `.env` on server + GitHub Secrets                            | Git, logs, client-side |
| Basic auth password | Caddy bcrypt hash in `terraform.tfvars`                      | Git, plaintext         |
| SSH private key     | Local machine + GitHub Secrets                               | Git, logs              |
| Sentry DSN          | `.env` (can be client-side, it's an identifier not a secret) | —                      |

**Rules**: `.env` and `terraform.tfvars` in `.gitignore`. `.env.example` committed with placeholders. No secrets in Docker images — passed via env vars at runtime.

### 16.9 Browser Extension Security

- **Manifest V3**: modern security model, no remote code execution
- **Minimal permissions**: `activeTab` + `storage` + host permission for your domain only
- **No `<all_urls>`**: extension only activates on user click
- **Self-contained**: no `eval()`, no remote script loading

### 16.10 Security Rules for Claude Code

Codified in `CLAUDE.md`:

1. **Never `dangerouslySetInnerHTML` on unsanitized content** — always DOMPurify first
2. **Never build SQL from string concatenation** — always Drizzle ORM
3. **Always validate URLs before fetching** — use `validateUrl()`
4. **Always validate API input with Zod** — first line of every route
5. **Never log secrets** — no API keys, passwords, or tokens in log output
6. **Never store secrets in code** — environment variables only
7. **Escape FTS5 queries** — use `escapeFts5Query()` for all user search input

---

## §17 Project Structure

```
src/
├── app/                        # Next.js App Router — 19 pages (see §7)
│   ├── layout.tsx
│   ├── page.tsx                # + inbox/, library/, reader/[id]/, review/,
│   │                           #   search/, settings/, login/, save/,
│   │                           #   newsletters/, chat{,/new,/[id]}/,
│   │                           #   drafts{,/[id]}/, theses{,/new,/[id],/suggest}/
│   └── api/                    # 64 route files (see §6 for the full index)
│       ├── articles/           # CRUD + parse, original, images, reanchor
│       ├── highlights/         # CRUD + bulk-delete + bulk-tag
│       ├── sources/ tags/ review/ feeds/ search/ health/
│       ├── ai/                 # summarize, tag, explain, clean, revert, index
│       ├── chat/ theses/ drafts/ tts/ usage/ voice/
│       └── newsletters/ settings/ auth/ upload/ import/
├── components/                 # React components
│   ├── ui/                     # shadcn/ui components
│   └── ...                     # Feature components
├── db/
│   ├── schema.ts               # Drizzle schema (single source of truth)
│   ├── index.ts                # DB connection
│   └── migrations/             # Generated by drizzle-kit
├── lib/                        # Shared utilities
│   ├── logger.ts               # pino logger
│   ├── errors.ts               # Custom error classes
│   ├── api-error-handler.ts    # Error → HTTP status mapping
│   ├── validators.ts           # Zod schemas for all routes
│   ├── article-parser.ts       # Readability + DOMPurify
│   ├── article-api.ts          # Article data fetching helpers
│   ├── feed-poller.ts          # RSS feed polling logic
│   ├── feed-scheduler.ts       # Feed poll scheduling
│   ├── fetch-utils.ts          # safeFetch, safeFetchText
│   ├── spaced-repetition.ts    # SM-2 review algorithm
│   ├── highlight-anchoring.ts  # Text offset → DOM range
│   ├── highlight-utils.ts      # Highlight DB helpers
│   ├── db-helpers.ts           # getArticleOrThrow, etc.
│   ├── search.ts               # FTS5 query escaping
│   ├── sanitize.ts             # DOMPurify HTML sanitization
│   ├── url-validator.ts        # SSRF prevention
│   ├── text-utils.ts           # wordCount, readingTime, formatDate
│   ├── clamp-to-viewport.ts    # UI viewport clamping
│   ├── constants.ts            # App-wide constants
│   ├── ai.ts                   # Anthropic SDK wrapper
│   └── utils.ts                # cn() shadcn utility
├── types/                      # All shared TypeScript types
│   └── index.ts
└── config/                     # App configuration
    └── index.ts

__tests__/
├── unit/                       # Pure logic, no I/O
├── integration/                # API routes + real SQLite
│   └── setup.ts                # Test DB factory
├── mocks/
│   ├── server.ts               # Shared MSW server + setupHandlers()
│   ├── msw-setup.ts            # Global MSW lifecycle (vitest setupFiles)
│   └── fixtures/               # HTML, XML, JSON fixtures
└── e2e/                        # Playwright (critical paths only)

docs/
├── architecture.md             # System architecture (source of truth)
├── adrs/                       # Architecture Decision Records
├── modules/                    # Per-module design specs
└── sessions/                   # Session workflow definitions

infra/                          # OpenTofu + cloud-init
docker/                         # Dockerfile + compose.yml + Caddyfile
.github/workflows/              # CI/CD
```

### Client/server placement rule for `src/lib`

`src/lib` is a flat directory holding three kinds of module. Placement is enforced by structure, not just bundler failure:

- **Server-only** — any module that touches the DB (`@/db`), `node:*` APIs (`fs`, `crypto`, `dns`), `next/server`, bcrypt, or a provider SDK (Anthropic, Mistral, Inworld, IMAP). These **must** carry `import 'server-only';` as their first line so an accidental client import fails the production build with a clear error instead of leaking server code into the client bundle. Examples: `settings.ts`, `auth.ts`, `settings-crypto.ts`, `pdf-storage.ts`, `mistral-ocr.ts`, `tts-cache.ts`, `ai.ts`, the pollers, and the `@/db` helpers.
- **Client** — modules with a `'use client'` directive or React hooks (e.g. `use-pdf-upload.ts`, `markdown-renderer.ts`). Never add `server-only` here.
- **Pure / isomorphic** — dependency-free constants, types, and predicates safe to import from either side (e.g. `settings-schema.ts`, `validators.ts`, `article-api.ts`, `draft-autosave.ts`). Keep these free of server imports so pure consumers (like the Zod validation layer) do not transitively weld to the server stack. When a server module needs to expose a pure constant to isomorphic code, extract it into a dependency-free module and re-export for back-compat (as `settings.ts` does with `settings-schema.ts`).

> Note: `server-only` throws under plain node (vitest), so `vitest.config.ts` aliases it to the package's empty stub for the test environment.
