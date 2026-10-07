# AI Usage Tracking & Pricing

**Status**: Done
**Last verified against code**: 2026-04 (module-build session)
**Schema tables**: `ai_usage` (new), `settings` (reuses existing, adds `monthly_budget_usd`)
**Unimplemented sections**: none

---

## Purpose

Track every Anthropic API call made by the app in one place, so that:

1. Users can see estimated cost **before** committing to expensive operations (e.g. deep research).
2. Users can see monthly spend across all AI features (sidebar footer + settings panel).
3. When research lands on top of this module, per-run cost attribution is possible.

**Scope**: Anthropic API only. Inworld TTS and Jina Reader are out of scope for v1 — they're flat-cost-per-call and not what drives spend. Can be added later as additional providers if needed.

**Non-goals**: cost enforcement (no refusing calls over budget), rate limiting, per-call billing/accounting records. This module is observability, not policy.

---

## Ground rules

- **Store raw usage, compute cost at read time.** Token and search counts are immutable facts; prices change. The rate card lives in `src/lib/pricing.ts` and is the only thing that moves when Anthropic updates pricing. Historical costs reprice automatically.
- **Instrument at the `callClaude` layer.** Every AI feature already goes through this function. One wrapper = every feature tracked. No per-feature bookkeeping in callers.
- **Log failed calls.** Anthropic bills for input tokens on some errors (rate limits especially), and we want the attempt logged regardless. Row is written in `finally`.
- **No historical backfill.** Table starts empty. Counter starts at $0.
- **Closed enum for `feature`.** Adding a new AI feature requires a schema migration to extend the enum. This is an intentional speed bump — it forces "did I remember to tag this call?" at spec time.

---

## Schema

New table `ai_usage`, migration `0014`.

```ts
export const aiUsage = sqliteTable(
  'ai_usage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),

    feature: text('feature', {
      enum: [
        // Research (granular phases, grouped by runId)
        'research_plan',
        'research_subagent',
        'research_synthesis',
        // Chat
        'chat',
        'chat_keyword_expansion',
        'chat_title_generation',
        // Drafts
        'draft_generation',
        // Article AI
        'summarize',
        'tag',
        'explain',
        'ai_index',
        'ai_clean',
        // Voice
        'voice_extraction',
        // Lint
        'lint_connections',
        'lint_contradictions',
        'lint_gaps',
        // Thesis
        'thesis_suggest',
        'highlight_suggest',
      ],
    }).notNull(),

    model: text('model').notNull(), // full model ID e.g. 'claude-opus-4-7'
    status: text('status', { enum: ['success', 'error'] }).notNull(),
    errorKind: text('error_kind'), // 'rate_limit' | 'timeout' | 'api_error' | 'network' | null

    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    webSearchCount: integer('web_search_count').notNull().default(0),

    // Grouping for multi-call operations (research runs). Nullable; UUID v4.
    runId: text('run_id'),

    // Loose reference — not a FK (source row may be deleted; we want the cost record regardless).
    resourceType: text('resource_type'), // 'article' | 'thesis' | 'thesis_research' | 'draft' | 'chat_session' | 'highlight' | null
    resourceId: integer('resource_id'),

    durationMs: integer('duration_ms').notNull().default(0),

    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index('ai_usage_created_idx').on(table.createdAt),
    index('ai_usage_feature_idx').on(table.feature),
    index('ai_usage_run_idx').on(table.runId),
  ],
);
```

### Schema decisions

- **`runId` (text, nullable).** Groups multiple API calls from a single logical operation. Required design for research: one research run makes 5–10 `callClaude` calls (plan + subagents + synthesis), all share a `runId`. The UI aggregates by `runId` to show "Research on Thesis X cost $0.73". Also future-proof for any other multi-call agent loop.
- **`resourceId` is not a FK.** Intentional: if you delete a thesis, the cost record survives. This is the one place in the schema where dangling references are accepted by design.
- **No `costUsd` column.** Computed from tokens × rate card at read time. If pricing-change immutability becomes a concern, add a versioned rate card (`src/lib/pricing-history.ts`) + a `pricedAt` column later. Not needed for v1.
- **Indexes.** `created_at` for every date-range query; `feature` for breakdowns; `run_id` for per-run aggregation (critical for research drill-down). No index on `user_id` — always 1.
- **Row volume.** At ~100 AI calls/day, ~36K rows/year. No pruning needed for SQLite at this scale.

---

## Pricing module — `src/lib/pricing.ts`

Pure functions, no DB, no network. Trivially unit-testable.

```ts
// Prices per million tokens, in USD. Source: https://platform.claude.com/docs/en/about-claude/pricing
// Verified April 2026. Update when Anthropic changes rates.
export const MODEL_PRICING = {
  'claude-opus-4-7': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
} as const;

// $10 per 1,000 web searches = $0.01 per search
export const WEB_SEARCH_COST_USD = 0.01;

export type ModelId = keyof typeof MODEL_PRICING;

export interface UsageRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearchCount: number;
}

/** Compute cost in USD for a single usage row. Returns 0 and logs a warning if model is unknown. */
export function computeCost(row: UsageRow): number;

/** Sum cost across many rows. */
export function aggregateCost(rows: UsageRow[]): number;

export interface CostEstimate {
  minUsd: number;
  maxUsd: number;
  estimatedDurationSec: { min: number; max: number };
}

/** Estimate cost for a planned call given ceilings. Used by the research pre-flight modal. */
export function estimateCost(params: {
  model: ModelId;
  maxInputTokens: number;
  minOutputTokens: number;
  maxOutputTokens: number;
  maxWebSearches: number;
  subagents?: {
    model: ModelId;
    count: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxWebSearches: number;
  };
}): CostEstimate;
```

### Pricing decisions

- **Unknown model → cost 0 + warning.** If Anthropic ships a new model before the rate card is updated, we log a warning but still write the usage row with correct token counts. Cost back-fills automatically once `MODEL_PRICING` is updated.
- **Deprecated models stay in the table.** Removing old model IDs silently zeroes out their historical cost. Keep all known model IDs forever.
- **`estimateCost` takes ceilings, not guesses.** The research modal presets use `max_tokens` and `max_uses` that are hard-enforced in the API call. The returned `[minUsd, maxUsd]` is an actual bound: minimum = "plan + 1 search + small synthesis"; maximum = "every cap hit."

---

## Usage tracking — `src/lib/ai-usage.ts`

```ts
export interface TrackingContext {
  feature: AiUsageFeature;
  runId?: string;
  resourceType?: AiUsageResourceType;
  resourceId?: number;
}

export interface UsageData {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearchCount: number;
}

/**
 * Wraps a Claude SDK call. Writes a row to ai_usage on both success and failure.
 * Does NOT transform the response — callers receive exactly what `run` returns.
 *
 * On throw:
 *   - Status is 'error'
 *   - errorKind is classified from the error (rate_limit / timeout / api_error / network)
 *   - Token counts are 0 unless the thrown error carries usage data (some Anthropic rate-limit errors do)
 *   - The error is rethrown after the row is written
 */
export async function trackAiCall<T>(
  ctx: TrackingContext,
  run: () => Promise<{ result: T; usage: UsageData }>,
): Promise<T>;

/** Generate a run ID for grouping a multi-call operation (e.g. a research run). */
export function newRunId(): string; // UUID v4
```

### Wiring into `callClaude`

`callClaude` in `src/lib/ai.ts` accepts an optional `TrackingContext` and wraps its SDK call in `trackAiCall`. The `run` callback:

1. Invokes the Anthropic SDK.
2. Extracts `usage.input_tokens`, `usage.output_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens`.
3. Extracts `usage.server_tool_use?.web_search_requests ?? 0`.
4. Returns `{ result, usage }`.

Every existing call site passes a `TrackingContext`. Examples:

| Feature site               | `feature`                | Resource                                     | Notes                           |
| -------------------------- | ------------------------ | -------------------------------------------- | ------------------------------- |
| `summarizeArticle(id)`     | `summarize`              | `{ type: 'article', id }`                    |                                 |
| `autoTagArticle(id)`       | `tag`                    | `{ type: 'article', id }`                    |                                 |
| `explainHighlight(id)`     | `explain`                | `{ type: 'highlight', id }`                  |                                 |
| `generateArticleIndex(id)` | `ai_index`               | `{ type: 'article', id }`                    |                                 |
| `cleanArticleHtml(id)`     | `ai_clean`               | `{ type: 'article', id }`                    |                                 |
| `generateDraft(draftId)`   | `draft_generation`       | `{ type: 'draft', id: draftId }`             |                                 |
| Chat keyword expansion     | `chat_keyword_expansion` | `{ type: 'chat_session', id: sessionId }`    |                                 |
| Chat main answer           | `chat`                   | `{ type: 'chat_session', id: sessionId }`    |                                 |
| Chat title generation      | `chat_title_generation`  | `{ type: 'chat_session', id: sessionId }`    |                                 |
| Lint connections check     | `lint_connections`       | none                                         | Global check                    |
| Lint contradictions check  | `lint_contradictions`    | none                                         |                                 |
| Lint gaps check            | `lint_gaps`              | none                                         |                                 |
| Voice profile extraction   | `voice_extraction`       | none                                         | User-scoped; always user 1      |
| Thesis suggestions         | `thesis_suggest`         | none                                         | Operates on unlinked highlights |
| Highlight suggestions      | `highlight_suggest`      | `{ type: 'thesis', id: thesisId }`           |                                 |
| Research plan              | `research_plan`          | `{ type: 'thesis', id: thesisId }` + `runId` | Opus                            |
| Research subagent          | `research_subagent`      | `{ type: 'thesis', id: thesisId }` + `runId` | Sonnet × N                      |
| Research synthesis         | `research_synthesis`     | `{ type: 'thesis', id: thesisId }` + `runId` | Opus                            |

### Research run flow

The research module (future work) owns the `runId` lifecycle:

1. On research kickoff: `const runId = newRunId()`.
2. Every `callClaude` inside the run receives the same `runId`.
3. When the research completes and a `thesis_research` row is inserted, update all usage rows with matching `runId` to set `resourceType = 'thesis_research'`, `resourceId = <new id>`. This lets the Settings → Usage view link directly to the saved artifact.
4. If the research fails partway through, usage rows still exist, `resourceType` stays `'thesis'`, and they show up as "Failed research on Thesis X — $0.12" in the top-calls view.

---

## API routes

All routes live under `src/app/api/usage/`. All wrap in Zod + `handleApiError` per project conventions.

### `GET /api/usage/summary`

Query: `?range=current_month|last_30_days|last_7_days` (default `current_month`).

Response:

```ts
{
  range: {
    start: string;
    end: string;
  } // ISO 8601
  totalUsd: number;
  totalCalls: number;
  failedCalls: number;
  monthlyBudgetUsd: number | null;
  budgetUsedPct: number | null; // null when no budget set
}
```

The sidebar footer calls this on mount + after any tracked streaming action completes. No polling.

### `GET /api/usage/breakdown`

Query: `?range=...&groupBy=feature|model|day`.

Response:

```ts
{
  range: {
    start: string;
    end: string;
  }
  groupBy: 'feature' | 'model' | 'day';
  groups: Array<{
    key: string; // feature name, model id, or YYYY-MM-DD
    calls: number;
    successCalls: number;
    failedCalls: number;
    inputTokens: number;
    outputTokens: number;
    webSearchCount: number;
    costUsd: number;
  }>;
}
```

### `GET /api/usage/top-calls`

Query: `?range=...&limit=10` (max 50).

Response:

```ts
{
  range: {
    start: string;
    end: string;
  }
  calls: Array<{
    id: number;
    feature: string;
    model: string;
    status: 'success' | 'error';
    runId: string | null;
    resourceType: string | null;
    resourceId: number | null;
    costUsd: number;
    durationMs: number;
    createdAt: string;
  }>;
}
```

For rows with a `runId`, results are **collapsed to one row per run** — total cost, total duration, feature label = "research" (special case). Research runs render with an expand chevron in the UI that fetches the phase breakdown via `/api/usage/runs/:runId`.

### `GET /api/usage/runs/:runId`

Response:

```ts
{
  runId: string;
  totalCostUsd: number;
  totalDurationMs: number;
  resourceType: string | null;
  resourceId: number | null;
  phases: Array<{
    id: number;
    feature: string; // 'research_plan' | 'research_subagent' | 'research_synthesis'
    model: string;
    status: 'success' | 'error';
    costUsd: number;
    durationMs: number;
    createdAt: string;
  }>;
}
```

### `GET /api/usage/estimate`

Query params correspond to `estimateCost`'s input shape. Returns `CostEstimate`. Exposed as a route (rather than client-side computation) so that rate-card changes don't require redeploying client code.

### `GET /api/usage/budget` and `PATCH /api/usage/budget`

Thin wrapper over a new setting `monthly_budget_usd` in the existing `settings` table. Add `'monthly_budget_usd'` to `SETTING_KEYS` in `src/types/index.ts`.

PATCH body:

```ts
{
  monthlyBudgetUsd: number | null;
} // null = remove budget
```

---

## UI

### Sidebar footer

New component `src/components/sidebar/usage-footer.tsx`, rendered above existing nav items.

```
─────────────────
AI usage
$4.82 / $20.00
████████░░░░░░░░  24%
─────────────────
```

Behavior:

- **Refetch triggers**: on mount, and after any tracked streaming AI action completes (chat message, draft generation, research run, lint, voice extraction, any backfill). No polling. No optimistic updates.
- **No budget set**: show `$4.82 this month` with no bar.
- **Over budget**: bar turns amber (not red — this is awareness, not alarm). Tooltip: "Monthly budget exceeded. Adjust in Settings."
- Click → `/settings/usage`.

The refetch-on-stream-complete signal needs a light pub-sub: a small `usage-events.ts` module exports an `emitUsageChanged()` function that streaming actions call on completion. The sidebar footer subscribes. Implementation detail — standard React event bus or a Zustand/Jotai atom, whatever fits your existing patterns.

### Settings → Usage tab

New tab alongside General / Integrations / Voice in the settings sidebar. Four sections in order:

1. **Header card** — current month total, failed-call count, `$X / $Y` budget with bar. Range selector (current month / last 30 days / last 7 days) affects all sections below.
2. **By feature** — table sorted by cost desc: feature name, calls, total tokens, cost. _Research_ rolls up all three `research_*` features into one line with a chevron; expanding reveals the phase breakdown.
3. **By model** — same shape, grouped by model. Surfaces "Am I paying Opus tax on things Haiku could do?"
4. **Daily trend** — 30-day line chart. Simple SVG, no new charting dependency.
5. **Top calls** — top 10 most expensive operations in the range. Research runs shown collapsed with expand affordance (calls `/api/usage/runs/:runId` on expand). Each row links to the underlying resource when possible:
   - `article` → `/reader/:id`
   - `thesis` → `/theses/:id`
   - `thesis_research` → `/theses/:id#research-:id`
   - `draft` → `/drafts/:id`
   - `chat_session` → `/chat/:id`
   - `highlight` → `/library` with highlight ID hash

Budget configuration lives in **General** settings (it's a preference), not the Usage tab (which is a data view).

---

## Edge cases

- **Clock / date boundaries.** "Current month" uses server-side `datetime('now')` in UTC. For a Paris-based single user this is slightly off at the month boundary (post-midnight Paris, pre-midnight UTC calls land in previous month). Acceptable for v1; store UTC and shift at read time later if it becomes irritating.
- **Failed calls without usage data.** Some SDK errors don't carry `usage`. Write the row with zero tokens, `status: 'error'`, `errorKind` classified, `durationMs` from wall clock. Better than losing the record.
- **Rate-card drift / repricing.** When Anthropic updates prices, edit `src/lib/pricing.ts` and redeploy. Historical costs reprice on next read. To freeze history, add versioned pricing + a `pricedAt` column — deferred to v2.
- **Research run partially persisted.** If the server crashes mid-run, some `ai_usage` rows have the `runId` but no `thesis_research` row will ever be created. Those appear as orphan runs in top-calls. Solve by showing "Failed / incomplete run" label when `resourceType` is still `'thesis'` after the run is older than the max research duration (say 10 minutes).
- **Concurrent writes.** SQLite WAL handles this fine at single-user volumes. No locking concerns.
- **Caller forgets `TrackingContext`.** Make `trackAiCall` (or `callClaude`'s new signature) require the context at the type level. Lint can't catch a missing context, but the type system can.
- **Test environment.** Unit tests for `pricing.ts` don't need a DB. Integration tests for routes use the standard `createTestDb()` fixture. The `trackAiCall` wrapper must not write to the real `ai_usage` in unit tests — stub at the `ai-usage.ts` module boundary.

---

## Dependencies

- **Drizzle ORM** (existing) — schema + queries.
- **Zod** (existing) — route validation.
- **`crypto.randomUUID()`** (Node built-in) — `runId` generation.
- **No new npm packages.** The daily-trend chart uses inline SVG.

---

## Tests

### Unit (`__tests__/unit/`)

- `pricing.test.ts`
  - Per-model cost math (input, output, cache read, cache write)
  - Web search cost
  - Unknown model returns 0 + warning
  - `aggregateCost` across mixed-model rows
  - `estimateCost` min/max bounds with and without subagents
  - `estimateCost` zero searches → no search cost
- `ai-usage.test.ts`
  - `trackAiCall` writes a row on success with all usage fields populated
  - `trackAiCall` writes a row on throw with `status='error'` and classified `errorKind`
  - `trackAiCall` rethrows the original error after writing
  - `trackAiCall` with partial usage (some fields missing from SDK response)
  - `newRunId` returns distinct UUIDs

### Integration (`__tests__/integration/`)

- `usage-summary.test.ts` — summary across date ranges, with/without budget, with failed calls
- `usage-breakdown.test.ts` — each `groupBy` mode, empty ranges, single-feature data
- `usage-top-calls.test.ts` — run collapsing, limit clamping, links via resource fields
- `usage-runs.test.ts` — run detail endpoint, missing run → 404
- `usage-estimate.test.ts` — deterministic output for fixed params
- `usage-budget.test.ts` — GET default (null), PATCH roundtrip, PATCH validation (negative rejected)

### E2E

None. This is an observational module, not a critical user journey.

---

## Security checklist (SESSION: module-build §6)

- **XSS**: N/A — no HTML rendering from usage data.
- **SSRF**: N/A — no outbound fetches.
- **Input validation**: every route has Zod at line 1. Enums for `range`, `groupBy`; `limit` clamped to 50; budget PATCH rejects negative values.
- **SQL**: all via Drizzle.
- **Secrets**: none added.
- **Dependencies**: no new packages.

---

## Rollout order

1. Migration `0014_ai_usage`.
2. Schema + `ai_usage` types in `src/types/index.ts`, extend `SETTING_KEYS` with `monthly_budget_usd`.
3. `src/lib/pricing.ts` + unit tests (can be reviewed standalone).
4. `src/lib/ai-usage.ts` + unit tests.
5. Wire `trackAiCall` into `callClaude` in `src/lib/ai.ts`. Update every AI call site with its `TrackingContext`. This is the largest cross-cutting change in the module.
6. API routes + budget setting integration.
7. UI: `usage-events.ts` pub-sub, sidebar footer, settings Usage tab.
8. Ship. **Observe for one week before building research on top** — real data will inform research mode defaults (especially which model tier to use for standard vs deep).

Step 8 is the point of the whole module. Don't skip it.
