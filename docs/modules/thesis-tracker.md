# Module 13: Thesis Tracker

**Status**: Done
**Last verified against code**: 2026-04 (docs reconciliation)
**Schema tables**: `theses`, `thesis_highlights`, `thesis_research`, `highlights` (thesisId); FTS: `theses_fts`
**Unimplemented sections**: none

## Purpose

Introduce the "thesis" as the core intellectual primitive that bridges reading (highlights) and publishing (content drafts). A thesis is a claim with structured evidence, counterarguments, and implications — the atomic unit from which all content (LinkedIn posts, blog articles, newsletter editions, book chapters) is generated.

This module covers thesis CRUD, highlight-to-thesis linking, AI-assisted thesis suggestion, status workflow, and integration with daily review.

## Why This Matters

The gap between "I highlighted something interesting" and "I published a thoughtful piece about it" is where most knowledge workers lose momentum. Existing tools handle capture (Readwise) and publishing (LinkedIn, Ghost) but ignore the intellectual middle: forming arguments from accumulated reading. The thesis tracker fills this gap.

## Data Model

### New Tables

#### `theses`

```
id              INTEGER PRIMARY KEY AUTOINCREMENT
user_id         INTEGER NOT NULL DEFAULT 1
title           TEXT NOT NULL              -- short name, e.g. "AI kills careers not jobs"
claim           TEXT                       -- 1-3 sentences: what you believe
counterarguments TEXT                      -- what a smart skeptic would say
implications    TEXT                       -- so what? why does this matter?
status          TEXT NOT NULL DEFAULT 'nascent'
                -- enum: nascent | developing | researched | ready | used
notes           TEXT                       -- free-form working notes
created_at      TEXT NOT NULL DEFAULT (datetime('now'))
updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
```

#### `thesis_highlights` (join table)

```
id              INTEGER PRIMARY KEY AUTOINCREMENT
thesis_id       INTEGER NOT NULL REFERENCES theses(id) ON DELETE CASCADE
highlight_id    INTEGER NOT NULL REFERENCES highlights(id) ON DELETE CASCADE
role            TEXT NOT NULL DEFAULT 'supporting'
                -- enum: supporting | opposing | context
note            TEXT                       -- why this highlight is relevant to this thesis
added_at        TEXT NOT NULL DEFAULT (datetime('now'))
UNIQUE(thesis_id, highlight_id)
```

#### `thesis_research` (for future deep research results)

```
id              INTEGER PRIMARY KEY AUTOINCREMENT
thesis_id       INTEGER NOT NULL REFERENCES theses(id) ON DELETE CASCADE
title           TEXT NOT NULL
content         TEXT NOT NULL              -- markdown research output
source          TEXT                       -- 'deep_research' | 'manual' | 'ai_analysis'
created_at      TEXT NOT NULL DEFAULT (datetime('now'))
```

### Schema Changes to Existing Tables

#### `highlights` — add optional thesis link

Add column:

- `thesis_id` — INTEGER, nullable, REFERENCES theses(id) ON DELETE SET NULL. Quick-link for the most common case (one highlight, one thesis). The join table `thesis_highlights` handles many-to-many.

### FTS5

Add FTS5 virtual table for thesis search:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS theses_fts USING fts5(
  title, claim, counterarguments, implications, notes,
  content='theses', content_rowid='id'
);
```

With the same insert/update/delete trigger pattern as articles and highlights.

## API Contract

### Theses

#### `POST /api/theses`

Create a new thesis.

**Request body:**

```typescript
{
  title: string;                    // required, min 3 chars
  claim?: string;
  counterarguments?: string;
  implications?: string;
  notes?: string;
  status?: 'nascent' | 'developing' | 'researched' | 'ready' | 'used';
}
```

**Response:** `201` with created thesis.

#### `GET /api/theses`

List theses with filtering.

**Query params:**

- `status` — filter by status (comma-separated for multiple)
- `search` — FTS5 search across title, claim, counterarguments, implications, notes
- `sort` — `updatedAt` (default), `createdAt`, `title`, `status`
- `order` — `desc` (default), `asc`
- `limit` — default 50, max 200
- `offset` — default 0

**Response (200):**

```json
{
  "theses": [
    {
      "id": 1,
      "title": "AI pair programming reduces architectural thinking",
      "claim": "While AI coding assistants improve...",
      "status": "developing",
      "highlightCount": 5,
      "researchCount": 1,
      "draftCount": 0,
      "createdAt": "2026-03-01T00:00:00",
      "updatedAt": "2026-03-05T00:00:00"
    }
  ],
  "total": 12
}
```

#### `GET /api/theses/[id]`

Get a single thesis with all linked highlights and research.

**Response (200):**

```json
{
  "thesis": {
    "id": 1,
    "title": "...",
    "claim": "...",
    "counterarguments": "...",
    "implications": "...",
    "notes": "...",
    "status": "developing",
    "createdAt": "...",
    "updatedAt": "..."
  },
  "highlights": [
    {
      "id": 5,
      "text": "Teams using Copilot wrote 40% more tests...",
      "note": "From METR report",
      "role": "supporting",
      "linkNote": "Key statistic for the productivity claim",
      "article": {
        "id": 2,
        "title": "METR Report 2025",
        "siteName": "metr.org"
      }
    }
  ],
  "research": [
    {
      "id": 1,
      "title": "Impact of AI coding tools on architecture decisions",
      "source": "deep_research",
      "wordCount": 2400,
      "createdAt": "..."
    }
  ]
}
```

#### `PATCH /api/theses/[id]`

Update thesis fields.

**Request body (all optional):**

```typescript
{
  title?: string;
  claim?: string;
  counterarguments?: string;
  implications?: string;
  notes?: string;
  status?: 'nascent' | 'developing' | 'researched' | 'ready' | 'used';
}
```

**Response:** `200` with updated thesis.

**Side effects:**

- Updating a `nascent` thesis to add a `claim` auto-transitions status to `developing` (unless explicitly set)
- `updatedAt` always refreshed on any change

#### `DELETE /api/theses/[id]`

Delete a thesis. Cascade deletes `thesis_highlights` and `thesis_research` entries. Highlights and articles are preserved.

**Response:** `200` with `{ deleted: true }`.

### Thesis-Highlight Linking

#### `POST /api/theses/[id]/highlights`

Link one or more highlights to a thesis.

**Request body:**

```typescript
{
  highlightIds: number[];           // required, at least one
  role?: 'supporting' | 'opposing' | 'context';  // default: 'supporting'
  note?: string;                    // why these highlights are relevant
}
```

**Response:** `201` with created links.

**Side effects:**

- If thesis status is `nascent` and now has highlights, auto-transition to `developing`

#### `DELETE /api/theses/[thesisId]/highlights/[highlightId]`

Remove a highlight link from a thesis. The highlight itself is preserved.

**Response:** `200` with `{ deleted: true }`.

### Thesis-Research

#### `POST /api/theses/[id]/research`

Add research material to a thesis.

**Request body:**

```typescript
{
  title: string;
  content: string;                  // markdown
  source?: 'deep_research' | 'manual' | 'ai_analysis';
}
```

**Response:** `201` with created research entry.

#### `DELETE /api/theses/[thesisId]/research/[researchId]`

Remove a research entry.

**Response:** `200` with `{ deleted: true }`.

### AI Features

#### `POST /api/theses/suggest`

AI suggests new theses based on the user's unlinked highlights.

**Request body:**

```typescript
{
  limit?: number;                   // max suggestions (default: 5)
}
```

**Logic:**

1. Fetch the most recent 50 unlinked highlights (no thesis_id, not in thesis_highlights)
2. Fetch existing thesis titles (to avoid duplicates)
3. Send to Claude:
   - System prompt includes the user's existing theses to avoid duplicates
   - User prompt includes unlinked highlights with article context
   - Asks for specific, arguable claims — not topics
4. Return structured suggestions

**Response (200):**

```json
{
  "suggestions": [
    {
      "title": "Platform teams should own developer experience, not infrastructure",
      "claim": "The most effective platform teams measure success by developer productivity...",
      "relevantHighlightIds": [12, 34, 56],
      "confidence": 0.85
    }
  ]
}
```

The user can approve a suggestion (creates thesis + links highlights) or dismiss it.

#### `POST /api/theses/[id]/suggest-highlights`

AI suggests highlights that might be relevant to an existing thesis.

**Request body:**

```typescript
{
  limit?: number;                   // max suggestions (default: 10)
}
```

**Logic:**

1. Fetch the thesis (title, claim, existing evidence)
2. Fetch all highlights NOT already linked to this thesis
3. Ask Claude to rank candidates by relevance, indicating role (supporting/opposing/context) and reasoning
4. Return ranked suggestions

**Response (200):**

```json
{
  "suggestions": [
    {
      "highlightId": 42,
      "text": "The highlight text...",
      "articleTitle": "Source article",
      "suggestedRole": "supporting",
      "reason": "Provides empirical evidence for the productivity claim"
    }
  ]
}
```

## Daily Review Integration

Add a "Link to thesis" action to the review card. After reviewing a highlight ("Got it" / "Review again"), the user can optionally link it to a thesis.

**UI addition to review card:**

- Below the Got it / Review again buttons, a subtle "Link to thesis" link
- On click: expands a searchable dropdown of existing theses + "Create new thesis" option
- Selecting a thesis calls `POST /api/theses/[id]/highlights`
- Creating a new thesis opens a minimal form (title only), creates as `nascent`, links the highlight
- Collapsed by default to not clutter the review flow

**Implementation:**

- New reusable component: `src/components/theses/thesis-linker.tsx`
- Used in: review card, highlight popover (reader view)

## Highlight Creation Integration

When creating a highlight in the reader view, the popover includes a "Link to thesis" option:

- Same `ThesisLinker` component as daily review
- Sets the `thesis_id` quick-link field on the highlight
- For multiple thesis links, user goes to thesis detail page

## Status Workflow

```
nascent ──► developing ──► researched ──► ready ──► used
```

**Auto-advancement (suggestions, not enforced):**

- `nascent` → `developing`: when claim is populated OR first highlight linked
- `developing` → `researched`: when first research entry added
- `ready` → `used`: when a content draft references this thesis (future Module 14)

**Rules:**

- User can manually set any status at any time
- Auto-advancement only triggers if current status is the immediately preceding stage
- A thesis is NEVER closed — it can always receive new highlights and research
- Status can move forward and backward freely

## Edge Cases

1. **Deleting a thesis** — cascade deletes links in `thesis_highlights` and `thesis_research`. Highlights and articles preserved.
2. **Deleting a highlight linked to a thesis** — `thesis_highlights` row cascade-deleted. `highlights.thesis_id` FK is ON DELETE SET NULL.
3. **Duplicate thesis-highlight link** — UNIQUE constraint returns 409.
4. **Thesis with no highlights** — valid (status: `nascent`).
5. **Highlight linked to multiple theses** — supported via `thesis_highlights` join table. `highlights.thesis_id` is the primary quick-link thesis.
6. **AI suggestion returns irrelevant results** — user dismisses. No automatic actions.
7. **Large number of unlinked highlights** — AI suggestions capped at 50 most recent.
8. **FTS5 search** — uses `escapeFts5Query()` pattern.
9. **Status regression** — allowed. `ready` can move back to `developing`.
10. **No Anthropic API key** — "Suggest" buttons hidden. Manual thesis creation and linking works normally.

## Security

- **Input validation**: Zod schemas on all inputs
- **AI prompts**: only user's own highlights/theses sent to Claude API
- **No new secrets**: uses existing Anthropic API key
- **Authorization**: basic auth (Caddy layer), `user_id` defaults to 1

## Configuration

No new environment variables. Uses existing Anthropic API key for AI features. Suggest buttons hidden if key not configured.

## Files

| File                                                        | Action                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `docs/modules/thesis-tracker.md`                            | Create — this spec                                                   |
| `src/db/schema.ts`                                          | Modify — add 3 tables, add thesis_id to highlights                   |
| `src/db/fts.ts`                                             | Modify — add theses_fts + triggers                                   |
| `src/types/index.ts`                                        | Extend — Thesis, ThesisHighlight, ThesisResearch, ThesisStatus types |
| `src/lib/validators.ts`                                     | Extend — thesis Zod schemas                                          |
| `src/app/api/theses/route.ts`                               | Create — GET list + POST create                                      |
| `src/app/api/theses/[id]/route.ts`                          | Create — GET detail + PATCH + DELETE                                 |
| `src/app/api/theses/[id]/highlights/route.ts`               | Create — POST link                                                   |
| `src/app/api/theses/[id]/highlights/[highlightId]/route.ts` | Create — DELETE unlink                                               |
| `src/app/api/theses/[id]/research/route.ts`                 | Create — POST add                                                    |
| `src/app/api/theses/[id]/research/[researchId]/route.ts`    | Create — DELETE                                                      |
| `src/app/api/theses/suggest/route.ts`                       | Create — POST suggest theses                                         |
| `src/app/api/theses/[id]/suggest-highlights/route.ts`       | Create — POST suggest highlights                                     |
| `src/app/theses/page.tsx`                                   | Create — thesis list page                                            |
| `src/app/theses/[id]/page.tsx`                              | Create — thesis detail page                                          |
| `src/components/theses/thesis-card.tsx`                     | Create                                                               |
| `src/components/theses/thesis-detail.tsx`                   | Create                                                               |
| `src/components/theses/thesis-form.tsx`                     | Create                                                               |
| `src/components/theses/evidence-section.tsx`                | Create                                                               |
| `src/components/theses/highlight-browser.tsx`               | Create                                                               |
| `src/components/theses/status-track.tsx`                    | Create                                                               |
| `src/components/theses/thesis-linker.tsx`                   | Create — reusable dropdown (review + reader)                         |
| `src/components/review/review-card.tsx`                     | Modify — add ThesisLinker                                            |
| `src/components/reader/highlight-popover.tsx`               | Modify — add ThesisLinker                                            |
| `src/app/globals.css`                                       | Modify — thesis status colors                                        |
| `drizzle/`                                                  | New migration                                                        |
| `CHANGELOG.md`                                              | Update                                                               |
| `__tests__/unit/thesis-tracker.test.ts`                     | Create                                                               |
| `__tests__/integration/theses.test.ts`                      | Create                                                               |
| `__tests__/integration/thesis-ai.test.ts`                   | Create — mock Claude via `setupHandlers(...)` (shared MSW server)    |
