# PRODUCT.md

## Product Name

**Gleanary** — A self-hosted, single-user read-it-later and highlight management system.

---

## Target User

A single technical user (the owner/developer) who:

- Reads a high volume of long-form articles, newsletters, and RSS feeds
- Wants to retain and revisit key ideas through highlights and spaced repetition
- Builds up written theses or arguments by collecting evidence from reading
- Values data ownership and self-hosting over SaaS convenience
- Is comfortable running a VPS, editing `.env` files, and deploying Docker containers

This is explicitly a **personal tool**, not a product designed for multiple users or public deployment.

---

## Core Problem It Solves

Commercial read-it-later tools (Readwise, Instapaper, Pocket) scatter reading data across third-party servers, charge ongoing subscriptions, and offer limited customization. This tool replicates the core loop — save → read → highlight → review → synthesize — in a fully self-hosted environment where the owner controls the data and the feature set.

---

## Goals

- **Own your reading data**: all articles, highlights, and annotations live in a single SQLite file that can be backed up with `cp`.
- **Close the reading-to-writing loop**: highlights feed into spaced repetition review and a thesis tracker, so reading produces durable, usable knowledge.
- **Frictionless saving**: articles can be saved from browser extension, RSS feeds, mobile share sheet, email, or direct URL — the path of least resistance matters.
- **Clean reading experience**: the reader view prioritizes typography and focus, not engagement metrics.
- **AI-augmented but not AI-dependent**: Claude API enhances (summarize, tag, explain, suggest) but the tool works without it.

---

## Non-Goals

- **Multi-user / team use**: no user accounts, no shared libraries, no per-user permissions. Single-user only.
- **Social features**: no sharing, comments, public profiles, or discovery feeds.
- **Mobile native app**: the mobile surface is a PWA + iOS Shortcut. No App Store / Play Store distribution.
- **Competing with general note-taking tools** (Notion, Obsidian): the scope is reading and highlight synthesis only. No arbitrary note hierarchies.
- **Offline-first / local-first PWA**: the app requires server connectivity. The "local-first" property refers to data ownership (SQLite on your VPS), not offline capability.
- **Multi-platform AI**: only Anthropic Claude is supported. No OpenAI, Gemini, or local model integration.
- **Monetization**: this is a personal project with no commercial intent.

---

## Key Features

_Derived from the codebase as it exists today. Nothing here is aspirational._

### Saving & Ingestion

- **Browser extension** (Chrome/Firefox, Manifest V3) — one-click save with optional HTML capture; Alt+Shift+S keyboard shortcut
- **RSS feed engine** — automatic polling (per-feed schedule, default every minute), ETag/Last-Modified deduplication, manual poll API
- **Mobile save** — `/save` page with `?url=` pre-fill, PWA manifest with Android share target, iOS Shortcut instructions
- **Newsletter ingestion** — IMAP polling (every 5 min), HTML/plain-text parsing, allowlist-based sender approval, Message-ID deduplication
- **Direct URL** — paste a URL into the app and fetch/parse on demand
- **Readwise import** — one-time or incremental sync from Readwise Reader API, deduplication by `externalId`/URL, tag mapping, SSE progress streaming [?] — unclear if this is a one-time migration tool or ongoing sync

### Article Parsing

- Dual-path: Jina Reader API (primary) with Defuddle + jsdom fallback
- SPA shell detection to avoid storing empty mount points
- DOMPurify HTML sanitization on ingest
- SSRF protection, 60-second timeout, 5 MB response size cap

### Reader View

- Clean typography: Georgia/Charter serif, 18–20 px body, max-width 680 px, centered
- Dark mode via system preference (`prefers-color-scheme`); appearance can also be set in settings (Automatic / Light / Dark)
- Text selection → inline highlight (auto on release; edit mode with draggable boundary handles)
- Highlight merging when selections overlap, with 5-second undo toast
- Double-click a paragraph to highlight the entire block
- Reading progress tracked and persisted (monotonic — never decreases)

### Highlight Library

- Browse and search highlights across all articles
- Filter by source, tag, date range, color
- Bulk tagging (add-to or replace modes) and bulk delete
- Tag management with cascade delete
- Sort by creation date, last update, or article

### Daily Review (Spaced Repetition)

- Simplified SM-2 algorithm: "Got it" doubles interval, "Review again" resets to 1 day
- Card-based UI with progress indicator and randomized ordering
- "Link to thesis" action directly from a review card

### AI Features _(requires `ANTHROPIC_API_KEY`)_

- **Summarize** — full article summary, cached in DB after first generation
- **Auto-tag** — suggest tags from existing vocabulary
- **Explain** — explain or analyze a highlighted passage in context
- AI responses cached; article content truncated to ~100 K chars before sending

### Text-to-Speech / Immersion Reading _(requires `INWORLD_API_KEY`)_

- Inworld TTS with streaming audio via SSE
- Word-by-word text highlighting synchronized to audio playback
- Gapless paragraph buffering via Web Audio API
- Playback controls: play/pause, skip ±15 s, speed 0.5×–1.5×
- Keyboard shortcuts: P (play/pause), arrows (skip), `,`/`.` (speed)
- Auto-language detection (English/French) with per-language default voices
- Disk-based audio cache (`/data/tts-cache/`) with LRU eviction (configurable, default 5 GB)
- Resume from last position across sessions
- Hidden automatically when `INWORLD_API_KEY` is not set

### Thesis Tracker

- Create and manage theses (structured arguments/claims) with a status workflow: `nascent → developing → researched → ready → used`
- Link highlights to theses with roles: supporting / opposing / context
- Auto-advancement: `nascent → developing` when a claim is written or a first highlight is linked; `developing → researched` when a first research entry is added
- AI-powered thesis suggestions from unlinked highlights
- AI-powered highlight suggestions for an existing thesis
- Full-text search across thesis fields
- Research entries per thesis (manual or AI-generated)

### Search

- SQLite FTS5 full-text search across articles (title, content, author, site name) and highlights (text, note) and theses (title, claim, counterarguments, implications, notes)
- Automatic sync via DB triggers — no manual indexing step

### Settings & Administration

- `/settings` admin page, password-protected
- API keys stored encrypted in DB (AES-256-GCM), not in environment at runtime [?] — relationship between env `ANTHROPIC_API_KEY` and DB-stored key is unclear from code alone
- Appearance mode preference (Automatic / Light / Dark) persisted in DB
- Security audit log table

---

## Constraints

| Constraint              | Value                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| Runtime                 | Node.js (Next.js App Router + API Routes)                                                           |
| Language                | TypeScript (strict mode)                                                                            |
| Database                | SQLite via better-sqlite3 + Drizzle ORM                                                             |
| Search                  | SQLite FTS5 (no external search engine)                                                             |
| Styling                 | Tailwind CSS + shadcn/ui                                                                            |
| AI provider             | Anthropic Claude (claude-sonnet or equivalent) only                                                 |
| TTS provider            | Inworld TTS API only                                                                                |
| Article fetch           | Jina Reader API (primary) + Defuddle/jsdom (fallback)                                               |
| Deployment target       | Single VPS (OVHcloud), Docker + Caddy                                                               |
| Users                   | Single user — no auth layer in the app (network-level protection via Caddy basic auth or Tailscale) |
| Data portability        | Single SQLite file — backup = `cp`                                                                  |
| Scheduling              | node-cron inside the Next.js process (no separate worker)                                           |
| Browser extension       | Chrome/Firefox, Manifest V3, vanilla JS (no bundler)                                                |
| Mobile                  | PWA + iOS Shortcut — no native app                                                                  |
| Infrastructure-as-Code  | OpenTofu (OVHcloud provider)                                                                        |
| Minimum viable hardware | 1 vCPU, 2 GB RAM, 40 GB NVMe                                                                        |

---

## Out-of-Bounds Decisions

_Things that must not change without an explicit Architecture Decision Record (ADR) and human approval._

1. **Single-user model** — adding multi-user support would require auth, per-user data isolation, and significant schema changes. This is a fundamental constraint, not an oversight.
2. **SQLite as the only database** — switching to Postgres or MySQL would break the FTS5 triggers, the backup story, and the single-deployable-unit model.
3. **No client-side secrets** — `ANTHROPIC_API_KEY` and all third-party credentials must remain server-side only. They must never appear in browser-visible code or responses.
4. **DOMPurify sanitization before any `dangerouslySetInnerHTML`** — non-negotiable for XSS prevention. Every HTML render path must pass through `sanitizeArticleHtml()`.
5. **Drizzle ORM for all DB access** — raw SQL template literals are banned in API routes. FTS5 queries must use `escapeFts5Query()`.
6. **`validateUrl()` before every server-side fetch** — SSRF protection. No exceptions for any URL that originates outside the app.
7. **Zod validation as the first operation in every API route** — input validation is not optional, not deferred to the service layer.
8. **Structured logging via pino (`logger`)** — `console.log` is banned in `src/`. Secrets must never appear in log statements.
9. **Single deployable unit** — the Next.js app, the cron scheduler, and the database all run in one process/container. Splitting them requires an explicit architectural decision.
10. **No pure white (`#FFF`) or pure black (`#000`) in the reader view** — the reading experience uses warm off-white and deep gray. This is a deliberate accessibility and comfort decision.
