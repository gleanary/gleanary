# Module 16: Content Templates

**Status**: Done
**Last verified against code**: 2026-04 (docs session)
**Schema tables**: `drafts`
**Unimplemented sections**: none
**Dependencies**: Module 13 (Thesis Tracker), Module 15 (Voice Profile), Module 7 (AI Features — Claude API client)

---

## Purpose

Turn a thesis into a publishable draft by combining voice identity (from Module 15) with channel-specific structure. Templates define _what_ you are writing into — length, structure, tone register — while the voice profile defines _how_ you write. Together they produce drafts that sound like the author and fit the channel.

This module owns: template definitions, the generation pipeline, and draft storage/editing.

---

## Design Decisions

### Source-first, not template-first

The user starts from a thesis — the thesis carries the claim, linked highlights with roles (supporting/opposing/context), and research entries. Picking a template is the _second_ choice, not the first. This matches how the app thinks: the knowledge comes first, the packaging second.

### Drafts are persisted and thesis-scoped

Every draft belongs to a thesis via a non-nullable foreign key. When a thesis is deleted, its drafts cascade-delete — a draft without its source thesis is lost work anyway.

### Built-in templates in v1, no user customization

Three templates ship: blog post, LinkedIn post, YouTube script. Book chapters are deferred — they raise voice-drift and section-level re-injection problems that need their own design pass. Templates are hardcoded TypeScript constants, not a DB table. User-editable templates can come later without breaking changes.

### Generate → review → edit manually

Same principle as Voice. One generation step produces a draft, the user hand-edits in a markdown editor. Regenerate overwrites the draft content (with confirmation). No iterative AI refinement loop. To get a different angle on the same thesis, the user creates a new draft.

### Context selection at generation time

The user selects which highlights and research entries feed the prompt for this specific draft. Default: everything is included. A short "Angle" text input lets the user steer — "lead with the contrarian take", "aim at executives", etc. This is what makes the same thesis spawn meaningfully different pieces across channels and over time.

### Sample selection happens here, not in Voice

Voice stores samples with a `channel_hint` field. Templates match each template's `channelHint` against those hints and picks 1–2 samples to include as voice exemplars in the system prompt. If no sample matches, it falls back to any 1–2 most recent samples. This is the point where the Voice ↔ Templates boundary connects.

### Publish marks the thesis as `used`

When a draft moves to `published` status, the parent thesis auto-advances to `used` (if not already). This closes the "nascent → developing → researched → ready → used" loop that already exists in the thesis state machine.

---

## Data Model

### New Table

#### `drafts`

```
id                 INTEGER PRIMARY KEY AUTOINCREMENT
user_id            INTEGER NOT NULL DEFAULT 1
thesis_id          INTEGER NOT NULL REFERENCES theses(id) ON DELETE CASCADE
template_id        TEXT NOT NULL              -- 'blog' | 'linkedin' | 'youtube'
title              TEXT NOT NULL              -- editable, seeded from thesis title on create
content            TEXT NOT NULL DEFAULT ''   -- markdown body
angle              TEXT                       -- optional user steer, persisted for regeneration
context_snapshot   TEXT                       -- JSON: { highlightIds: number[], researchIds: number[] }
status             TEXT NOT NULL DEFAULT 'draft'  -- 'draft' | 'published'
generated_at       TEXT                       -- last successful generation
last_edited_at     TEXT                       -- last manual edit
published_at       TEXT
created_at         TEXT NOT NULL DEFAULT (datetime('now'))
updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
```

`context_snapshot` stores what was fed to the prompt, so regeneration re-uses the same context by default (the user can override before regenerating). It also makes debugging and "what did I include in that draft" inspection trivial.

### No schema changes to existing tables

`theses.status` auto-advances to `used` on publish via application logic — no new columns needed. Voice tables are read-only from this module.

---

## Template Library

Templates are hardcoded in `src/lib/content-templates.ts`:

```typescript
export interface ContentTemplate {
  id: 'blog' | 'linkedin' | 'youtube';
  name: string;
  description: string; // shown on picker card
  targetLength: { min: number; max: number }; // words
  channelHint: string; // matches against voice_samples.channel_hint
  instructions: string; // structural prompt fragment
}
```

Each template's `instructions` covers: structural expectations (intro/body/close shape), length target, tone register adjustments specific to the channel, formatting cues (e.g., LinkedIn: short paragraphs; YouTube: spoken-word rhythm and stage directions). Instructions contain **no voice-level content** — rhythm, vocabulary, argument style all come from the voice profile.

### Initial templates

- **Blog post** (`blog`) — 800–2,000 words. Opening hook → claim → evidence buildup with H2 sections → close. `channelHint: "blog"`.
- **LinkedIn post** (`linkedin`) — 150–400 words. Single provocation or insight, short paragraphs, no H2s, close with a question or invitation. `channelHint: "linkedin, short-form, social"`.
- **YouTube script** (`youtube`) — 400–1,200 words. Spoken-word rhythm, natural contractions, speaker cues in brackets (e.g., `[pause]`, `[to camera]`), cold open, no H2s — section breaks as prose transitions. `channelHint: "youtube, script, spoken"`.

---

## Generation Pipeline

Located in `src/lib/content-generation.ts`. One function: `generateDraft(draftId, options): AsyncIterable<StreamEvent>`. Emits SSE-style events consumed by the route.

### Prompt assembly

**System prompt** is the concatenation of:

1. Voice profile markdown (from `voice_profile.profile`) — if missing, a fallback meta-instruction is included in the system prompt: "No voice profile available; follow template instructions only."
2. 1–2 voice samples where `channel_hint` contains the template's `channelHint` token. Fall back to any 1–2 most recent samples if no match. Formatted as `## Sample: {title}\n\n{content}`.
3. Template `instructions`.

**User prompt** is the thesis context:

- Thesis claim (always)
- Counterarguments and implications (if present on the thesis)
- Selected highlights grouped by role (supporting / opposing / context)
- Selected research entries (title + content)
- Optional angle steer, prefixed as: `Angle for this piece: {angle}`

### Streaming + persistence

Stream chunks are forwarded to the client via SSE. On stream completion, the full generated text is saved to `drafts.content`, `generated_at` is set, and `context_snapshot` is written. On stream error, the previous content is preserved (regeneration is transactional — all-or-nothing).

Model: Claude Sonnet. Token budget: ~8K input (profile + samples + context) + 8K output.

---

## API Contract

### `POST /api/drafts`

Create a new draft shell. Does **not** generate. Returns the draft row; client navigates to `/drafts/[id]` which triggers generation.

```typescript
// Request
{
  thesisId: number;
  templateId: 'blog' | 'linkedin' | 'youtube';
  angle?: string;
  includedHighlightIds: number[];
  includedResearchIds: number[];
}
// Response: 201 Created, { draft: Draft }
```

Validates that `thesisId` exists, `templateId` is known, all included highlight/research IDs belong to the thesis. Seeds `title` from the thesis title. Writes `context_snapshot`.

### `GET /api/drafts`

List drafts across all theses.

```
Query params:
  thesisId?: number
  templateId?: string
  status?: 'draft' | 'published'
  limit?: number (default 50)
```

Returns drafts joined with their parent thesis title.

### `GET /api/drafts/[id]`

Full draft with thesis context (highlights and research resolved from `context_snapshot`).

### `PATCH /api/drafts/[id]`

Update `title`, `content`, `angle`, `includedHighlightIds`, `includedResearchIds`, or `status`. Sets `last_edited_at` on content changes. On `status: 'published'` transition, sets `published_at` and advances the parent thesis to `used` status if not already there.

### `DELETE /api/drafts/[id]`

Soft delete not needed — hard delete the row.

### `POST /api/drafts/[id]/generate`

SSE stream. Runs the generation pipeline. Used for both initial generation (immediately after draft creation) and regeneration. Overwrites `content`, updates `generated_at`. For regeneration after manual edits, the client must include `force: true` in the request body — otherwise returns 409.

```typescript
// Request
{
  force?: boolean; // required when last_edited_at > generated_at
}
```

---

## Validation Schemas

```typescript
const createDraftSchema = z.object({
  thesisId: z.number().int().positive(),
  templateId: z.enum(['blog', 'linkedin', 'youtube']),
  angle: z.string().max(500).optional(),
  includedHighlightIds: z.array(z.number().int().positive()).max(100),
  includedResearchIds: z.array(z.number().int().positive()).max(50),
});

const updateDraftSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    content: z.string().max(50000).optional(),
    angle: z.string().max(500).nullable().optional(),
    includedHighlightIds: z.array(z.number().int().positive()).max(100).optional(),
    includedResearchIds: z.array(z.number().int().positive()).max(50).optional(),
    status: z.enum(['draft', 'published']).optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined));

const generateDraftSchema = z.object({
  force: z.boolean().optional().default(false),
});
```

---

## UI Design

### Thesis detail page — Drafts section

A new section below Research on the thesis detail page. Empty state: "Ready to publish this thesis? Start a draft." Populated state: a list of draft cards showing title, template badge, status, last-edited timestamp, click-through to editor.

### New Draft flow

**Step 1 — Template picker**: modal with three cards (blog / LinkedIn / YouTube). Each card shows name, description, length range. Clicking picks the template and advances.

**Step 2 — Context selection**: a panel showing:

- Thesis claim (read-only, always included)
- Linked highlights grouped by role, each with a checkbox (all checked by default)
- Research entries, each with a checkbox (all checked by default)
- An "Angle" textarea (optional, placeholder: "Lead with the contrarian take, aim at executives, etc.")

"Generate" button at the bottom. On click: `POST /api/drafts` → navigate to `/drafts/[id]`.

### Editor page (`/drafts/[id]`)

Two-column layout:

- **Left**: markdown editor, primary surface. Auto-saves on debounced change (1s idle). Streaming generation text fills the editor live on first load; editor is read-only during streaming.
- **Right**: collapsible side panel with:
  - Parent thesis link + template name
  - Metadata: "Generated N hours ago", "Last edited N minutes ago"
  - _Regenerate_ button (confirmation modal if `last_edited_at > generated_at`)
  - _Copy markdown_ / _Copy as HTML_ buttons
  - Status toggle: Draft ↔ Published
  - _Delete_ button (destructive, confirmation)

### Cross-thesis `/drafts` page

Top-level page listing all drafts across all theses. Filters: template, status. Sidebar gains a "Drafts" nav item between Theses and Chat.

---

## Edge Cases

1. **Thesis has no highlights or research** — generation allowed; the prompt will rely on the claim alone. UI shows an inline note: "This thesis has limited supporting content. Add highlights for a stronger draft."
2. **No voice profile exists** — generation works with template instructions only. UI shows an inline warning on the context selection panel: "No voice profile. The draft will follow the template but won't match your voice. [Set up voice →]".
3. **No matching voice samples** — fall back to 1–2 most recent samples silently. This is common for users who have a profile but haven't tagged samples by channel.
4. **Regenerate after manual edits** — backend requires `force: true`; UI shows confirmation modal: "This will overwrite your edits. Continue?"
5. **Thesis deleted while draft editor is open** — next fetch returns 404; editor shows "This draft's thesis was deleted" state with a link back to `/drafts`. Cascade delete has already removed the row.
6. **Draft saved while regeneration is streaming** — editor is read-only during stream; no race possible. If the user navigates away mid-stream, the stream aborts server-side and `content` reverts to the pre-generation value.
7. **Anthropic API unavailable** — generation returns 503 with a clear message. The empty draft row remains; the user can retry.
8. **Angle field over 500 chars** — Zod rejects at 422. UI enforces the limit with a counter.
9. **Published draft edited again** — allowed; status stays `published` until user explicitly reverts. `last_edited_at` updates normally. Thesis status is not rolled back.
10. **Context snapshot references deleted highlight** — generation skips deleted items silently. The snapshot remains for historical record; the editor shows resolved items with a "(deleted)" label on any missing reference.

---

## Security

- **Input validation**: Zod on every route, Drizzle ORM for all queries.
- **No HTML rendering**: draft content is markdown, rendered via the same safe markdown pipeline used in chat messages. No `dangerouslySetInnerHTML` in this module.
- **Voice samples in system prompt**: user-owned content, no injection surface beyond what already exists in AI features.
- **Copy-as-HTML**: client-side markdown → HTML conversion using the existing sanitizer before clipboard write.

---

## Build Plan

Seven phases, nine sessions. Each session is scoped to fit within a single Claude Code session window. Mandatory pre-commit steps from `CLAUDE.md` apply to every session.

### Phase 1 — Foundation

**Session 1.1 — Schema, types, validators, template library**
→ Model: **Sonnet**, effort: **medium**
Why: Well-defined and mechanical. Template `instructions` prose needs care but doesn't require heavy reasoning. Low risk; follows existing schema patterns exactly.

Covers: `drafts` table in `src/db/schema.ts`, migration, types in `src/types/index.ts`, Zod schemas in `src/lib/validators.ts`, `src/lib/content-templates.ts` with the three built-in templates and their instruction prose.

---

### Phase 2 — Generation pipeline

**Session 2.1 — Content generation library**
→ Model: **Opus**, effort: **high**
Why: This is the core value of the module. Prompt quality determines whether the output is usable. Sample selection logic, graceful degradation when voice profile or samples are missing, and streaming error handling all have subtle tradeoffs. Worth the strongest model.

Covers: `src/lib/content-generation.ts` — prompt assembly (voice profile + sample selection by `channel_hint` + template instructions + thesis context), Anthropic SSE streaming, atomic persistence on stream completion, revert on stream error. Unit tests for prompt assembly and sample selection.

---

### Phase 3 — API routes

**Session 3.1 — Draft CRUD routes**
→ Model: **Sonnet**, effort: **medium**
Why: Follows the established pattern for theses and highlights — Zod → Drizzle → handleApiError. Low novelty, high volume of boilerplate.

Covers: `POST /api/drafts`, `GET /api/drafts`, `GET /api/drafts/[id]`, `PATCH /api/drafts/[id]`, `DELETE /api/drafts/[id]`. Integration tests.

**Session 3.2 — Generate endpoint + thesis auto-advance**
→ Model: **Sonnet**, effort: **medium**
Why: SSE streaming is already established in the chat module — reuse that pattern. The thesis auto-advance is a simple cross-module write that can be contained in the PATCH route. Not hard, but touches cross-module logic so deserves its own session for test focus.

Covers: `POST /api/drafts/[id]/generate` (SSE), force-flag gating for regeneration after manual edits, thesis status auto-advance to `used` on publish. Integration tests including the force-flag branch.

---

### Phase 4 — Thesis page integration

**Session 4.1 — Drafts section, template picker, context selection**
→ Model: **Opus**, effort: **high**
Why: This is the entry point the user will interact with most. Multiple UI pieces in one flow (section, picker modal, context panel with checkboxes, angle input) with real UX choices — spacing, loading states, empty states, validation feedback. Quality here determines whether the feature gets used. The context selection UI in particular has to feel effortless.

Covers: Drafts section on thesis detail page, template picker modal, context selection panel with per-highlight/research checkboxes, angle textarea, submit → `POST /api/drafts` → navigate to editor. Component tests for the picker and selection logic.

---

### Phase 5 — Editor — **shipped**

**Session 5.1 — Editor page, streaming, auto-save, side panel** ✅
→ Model: **Opus**, effort: **high**
Why: The editor is where the user spends most of their time. Streaming consumption into the editor, debounced auto-save without losing cursor position, read-only state during regeneration, abort handling on navigation — many edge cases, all user-visible. Side panel interactions (regenerate with confirm, export, status toggle) are simpler but live in the same file so keep in one session for coherence.

Covers: `/drafts/[id]` page, markdown editor component (plain `<textarea>` + Preview toggle via `marked` + `sanitizeArticleHtml`), SSE consumption via `useDraftGeneration` hook (StrictMode-safe auto-start, streaming autoscroll, 409 `needs-force` force-confirm dialog shared with the regenerate path, inline retry strip for other errors), per-field debounced PATCH auto-save with merged `error > saving > saved > idle` indicator, read-only lock during stream, side panel with metadata and actions (Preview toggle, Regenerate, Copy markdown, Copy as HTML sanitized, status Publish/Revert, Delete). E2E stubbed with `test.fixme` placeholders in `e2e/draft-flow.spec.ts` for Phase 7.

---

### Phase 6 — Cross-thesis page

**Session 6.1 — `/drafts` list page + sidebar nav**
→ Model: **Sonnet**, effort: **low-to-medium**
Why: Mirrors the existing `/theses` and `/chat` list patterns almost exactly. Very mechanical. No novel UX.

Covers: `/drafts` page with filters (template, status), draft cards linking to the editor, sidebar nav item added between Theses and Chat.

---

### Phase 7 — Tests and docs

**Session 7.1 — E2E happy path, docs reconciliation**
→ Model: **Sonnet**, effort: **medium**
Why: E2E writing is patterned work following existing Playwright specs. Docs reconciliation is routine (`SESSION: docs` in `CLAUDE.md`). No hard reasoning needed.

Covers: E2E spec for the full flow (thesis detail → new draft → template pick → context select → generate → edit → publish → verify thesis advanced to `used`). Update `docs/architecture.md` §5, Module Registry in `CLAUDE.md`, `CHANGELOG.md`, `README.md` features list.

---

## Files

| File                                          | Action                                                 |
| --------------------------------------------- | ------------------------------------------------------ |
| `docs/modules/content-templates.md`           | Create — this spec                                     |
| `src/db/schema.ts`                            | Modify — add `drafts` table                            |
| `src/types/index.ts`                          | Extend — Draft, NewDraft, ContentTemplate, DraftStatus |
| `src/lib/validators.ts`                       | Extend — draft Zod schemas                             |
| `src/lib/content-templates.ts`                | Create — built-in template definitions                 |
| `src/lib/content-generation.ts`               | Create — prompt assembly + streaming generation        |
| `src/app/api/drafts/route.ts`                 | Create — POST + GET                                    |
| `src/app/api/drafts/[id]/route.ts`            | Create — GET + PATCH + DELETE                          |
| `src/app/api/drafts/[id]/generate/route.ts`   | Create — POST (SSE)                                    |
| `src/app/drafts/page.tsx`                     | Create — cross-thesis list                             |
| `src/app/drafts/[id]/page.tsx`                | Create — editor                                        |
| `src/app/theses/[id]/page.tsx`                | Modify — add Drafts section                            |
| `src/components/drafts/drafts-section.tsx`    | Create — thesis-page section                           |
| `src/components/drafts/template-picker.tsx`   | Create — picker modal                                  |
| `src/components/drafts/context-selection.tsx` | Create — highlight/research/angle selection            |
| `src/components/drafts/draft-editor.tsx`      | Create — markdown editor + streaming consumer          |
| `src/components/drafts/draft-side-panel.tsx`  | Create — metadata + actions                            |
| `src/components/drafts/draft-list.tsx`        | Create — cross-thesis list component                   |
| `src/components/layout/sidebar.tsx`           | Modify — add Drafts nav item                           |
| `CHANGELOG.md`                                | Update                                                 |
| `drizzle/`                                    | New migration                                          |
| `__tests__/unit/content-generation.test.ts`   | Create                                                 |
| `__tests__/integration/drafts.test.ts`        | Create — mock Claude stream via `setupHandlers(...)`   |
| `e2e/draft-flow.spec.ts`                      | Create — full happy path                               |
