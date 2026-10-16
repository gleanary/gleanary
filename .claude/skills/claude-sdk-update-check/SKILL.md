---
name: claude-sdk-update-check
description: Check whether Gleanary's Anthropic integration is current across three axes — the `@anthropic-ai/sdk` package, the Claude models/pricing it calls, and the API features it relies on (prompt caching, the PDF document API, web search) — and work out exactly what it would take to catch up. Use this whenever the user asks about Anthropic SDK updates, a new SDK version, whether to bump `@anthropic-ai/sdk`, new Claude models, model deprecations or retirements, whether the model IDs / `MODEL_PRICING` rate card are current, Claude API pricing changes, or new API features/beta headers — even if they don't name a version. Also trigger it proactively if the user shares an Anthropic release note or model announcement and asks "should I update?". Do NOT use it for how-to coding questions about using the SDK (writing a streaming call, building a wrapper) or for non-Anthropic providers (Mistral OCR, OpenRouter, Kimi) — those have their own paths.
---

# Claude SDK update check

## Why this exists

Gleanary's Anthropic integration goes stale in three independent ways, each with its own
failure mode and none of which announces itself:

1. **The `@anthropic-ai/sdk` package** — a pre-1.0 library, so minor bumps can carry breaking
   changes. The `Usage` type shape in particular is load-bearing: Gleanary reads token counts
   (input/output, cache read/write, web-search count) off it to populate `ai_usage`. A renamed
   or newly-exposed field changes what Gleanary records.
2. **The models and their pricing** — new model IDs appear, old ones get deprecation and
   retirement dates, and per-token prices change. Gleanary hardcodes model IDs in several places
   and keeps a `MODEL_PRICING` rate card that is computed at read time. When a model Gleanary
   uses retires, calls start failing; when the rate card omits a model now in use, cost tracking
   silently misreports.
3. **The API features Gleanary leans on** — prompt caching, the PDF document API, and web search
   (server tool use). Beta headers graduate, response shapes shift, billing rules change.

The output the user wants is not "a new SDK/model exists." It is: _what changed, what it costs,
what breaks, what's on a retirement clock, and what I have to do_ — ranked so they can act.

## What to check, and where

Use the assistant's `web_fetch` / `web_search` tools for docs (the bash sandbox can't reach
`*.claude.com`), but the SDK package and its changelog are reachable from bash via npm and
`raw.githubusercontent.com` / `api.github.com`, which is faster and authoritative. Prefer those
for the SDK axis.

**Axis 1 — SDK package**

- `npm view @anthropic-ai/sdk version dist-tags` — the current published version (and any
  `beta`/`alpha` tags). Compare to the version pinned in `package.json`.
- `https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/CHANGELOG.md` —
  per-release notes. Read every entry between Gleanary's pinned version and latest. Watch for:
  `Bug Fixes`/`Features` touching the `Usage` type, streaming, tool input parsing, refusal
  handling, and any `api:` entry that adds/removes models. Entries like "remove retired models
  from API and SDKs" or "add support for claude-… " are the high-signal ones.
- For a major/minor jump, also check `MIGRATION.md` in the same repo and the GitHub Releases page.

**Axis 2 — Models & pricing** (docs served from `platform.claude.com/docs`; if a path 404s,
`web_search` the page title — docs get reorganized)

- Models overview — `https://platform.claude.com/docs/en/about-claude/models/overview`. The
  current lineup, model IDs, context/output limits, and which model is the current default.
- Pricing — `https://platform.claude.com/docs/en/about-claude/pricing`. Per-MTok input/output
  and the cache-write/cache-hit multipliers. This is the source for `MODEL_PRICING`.
- Model deprecations — `https://platform.claude.com/docs/en/about-claude/model-deprecations`.
  The lifecycle table with deprecation and **retirement** dates. Cross-check every model id
  Gleanary references (see baseline) against this; a retirement date is a hard deadline.
- API release notes — `https://platform.claude.com/docs/en/release-notes/overview`. The
  narrative of what shipped, including billing-rule changes (e.g. refusals no longer billed).

**Axis 3 — API features Gleanary depends on**

- From the release notes and the relevant capability docs, check prompt caching, PDF/document
  support, and web search / server tool use for header changes, beta→GA transitions, and
  response/usage-shape changes. Specifically re-check whether the SDK `Usage` type now exposes a
  server-tool / web-search request count (it historically did not — see baseline TECH_DEBT item).

If a source is unreachable or ambiguous, say so plainly rather than guessing. A confident wrong
price or a missed retirement date is far worse than "the deprecations page didn't load — check
it directly."

## How to run the check

1. Pull Axis 1 (npm + CHANGELOG), then Axes 2–3 from docs.
2. Diff each against the **Current integration baseline**. For models, the critical diff is two
   directions: models Gleanary uses that are now deprecated/retiring (deadlines), and current
   models missing from `MODEL_PRICING` / the selectors (silent misreporting or unavailable
   options).
3. Triage new SDK features and new models against what Gleanary actually does — a single-user
   reading app using Anthropic for prompt-cached calls, the PDF document API, and web search.
   Most enterprise/agent-platform features (Managed Agents, self-hosted sandboxes) are irrelevant;
   say so rather than padding the report.
4. Produce the report in the format below.
5. Update the baseline (see Maintenance).

## Current integration baseline

> Keep this section current. It is the reference the diff is measured against. After any
> confirmed check, update it (see Maintenance) so the skill ratchets forward instead of drifting.

- **Last verified:** 2026-07-21

**Axis 1 — SDK package**

- **Pinned in `package.json`:** `@anthropic-ai/sdk` at `^0.112.4` (Dependabot bumps
  0.105→0.111 and 0.111→0.112.4, both triaged and merged).
- **Latest on npm at verification:** `0.112.4` — Gleanary is **current**.
- **Changelog 0.106→0.112.4 evaluated**: `system.message` streaming-event support
  (0.106.0, passive — no code change needed, see Axis 3) and `claude-sonnet-5` model support
  (0.108.0, see Axis 2). Everything else was Managed Agents / MCP tunnels / Vault — irrelevant
  to Gleanary.
- **Usage-type fields consumed** (into `ai_usage`): input tokens, output tokens, cache read,
  cache write, web-search count, pages processed. Wired in `src/lib/ai-usage.ts`
  (`trackAiCall`, `extractUsageFromError`) and the `callClaude` / `callClaudeStreaming` wrappers
  in `src/lib/ai.ts`.
- **SDK is in `serverExternalPackages`** (Next config) to stop Turbopack rebundling it.
- **`usage.server_tool_use.web_search_requests`** — **fixed**: both call sites
  (`src/lib/ai.ts:472` and `:617`) now read
  `usage.server_tool_use?.web_search_requests ?? 0`. Former TECH_DEBT item closed.
- **`usage.output_tokens_details`** added in 0.100.0 — thinking-token breakdown. Currently
  unused by Gleanary.

**Axis 2 — Models & pricing**

- **Single source of truth now exists:** `ALL_CLAUDE_MODELS` in `src/lib/models.ts` — one entry
  per model (id, apiId, pricing, context window, selector membership); `pricing.ts` derives
  `CLAUDE_PRICING` from it and the chat/draft selectors are derived too. Remaining hardcoded
  spots: schema defaults `claude-sonnet-4-6` on `chat_sessions.model` (`src/db/schema.ts:259`)
  and `drafts.model` (`:322`), `DEFAULT_CHAT_MODEL` / `DEFAULT_DRAFT_MODEL` /
  `DEFAULT_FEATURE_MODEL` / `UTILITY_MODEL` constants in `models.ts`. `src/lib/ai.ts` (`MODEL`,
  the default for `callClaude` / `callClaudeWithMeta`) and `src/lib/voice-extraction.ts` take
  `DEFAULT_FEATURE_MODEL`. **Always grep `src/` for literal `claude-` ids too** (`git grep -nE
"claude-[a-z0-9.-]+" -- src`): until 2026-10 both of those files hardcoded
  `claude-sonnet-4-20250514`, which this check missed; it was retired 2026-06-15 and broke
  summarize/tag/explain/thesis suggest/concept index/voice extraction with a 404 in production.
  `__tests__/unit/models.test.ts` now guards that `DEFAULT_FEATURE_MODEL` is an active entry.
- **Rate card** (via `ALL_CLAUDE_MODELS`) covers **Haiku 4.5, Sonnet 4.6, Opus 4.8** (active,
  in selectors) + **Opus 4.7, Opus 4.6, Sonnet 4** (historical, pricing only). All prices
  re-verified correct 2026-07-21. Cost is computed at read time.
- **Known gaps at verification:**
  - **`claude-sonnet-5`** missing — Active, released Jun 2026, retirement not sooner than
    2027-06-30, 1M context / 128k output. Intro pricing $2/$10 MTok through **2026-08-31**, then
    $3/$15 (same as Sonnet 4.6); cache multipliers standard (0.1x read, 1.25x 5-min write).
    Caveats if adopting: (a) read-time `computeCost` means one static rate misprices either the
    intro or standard period — enter standard $3/$15; (b) new tokenizer produces ~30% more
    tokens for the same text, so post-intro it is effectively ~30% dearer than Sonnet 4.6 per
    document; (c) `temperature`/`top_p`/`top_k` return 400 on it (Gleanary sets none — safe).
  - **`claude-fable-5`** missing — $10/$50 MTok. Out of scope unless deep-research tier changes.
  - **No retirement risk** on any model Gleanary uses (**wrong at the time**: the hardcoded
    Sonnet 4 id above was missed). Nearest "not sooner than" dates:
    Haiku 4.5 2026-10-15, Sonnet 4.6 2027-02-17, Opus 4.8 2027-05-28. Opus 4.1 retires
    2026-08-05 but Gleanary does not reference it.

**Axis 3 — API features used**

- **Prompt caching** — relied on; cache read/write tokens tracked. Pricing unchanged.
- **PDF document API** — `callClaudeWithDocument()` no longer exists in `src/lib/ai.ts`;
  re-locate the document-block call site (if any) on the next check.
- **Web search / server tool use** — used; `ai_usage.webSearchCount` is now correctly read from
  `usage.server_tool_use?.web_search_requests` at both call sites. $10 per 1,000 searches,
  unchanged.
- **`system.message` streaming events / mid-conversation system messages** — the SDK-0.106.0
  event type belongs to the "mid-conversation system messages" API feature (send
  `role: "system"` turns mid-`messages` to change instructions while preserving prompt-cache
  hits; GA July 2026 on Fable 5, Mythos 5, and Opus 4.8 only — **not** Sonnet 4.6/Sonnet 5).
  Gleanary's `client.messages.stream()` + `on('text')` needs no change; on 0.112.4 the SDK
  parses these events natively. Only relevant if knowledge chat ever wants mid-session
  instruction changes without busting the cache.

- **Why the native SDK is retained at all:** specifically for prompt caching, the PDF document
  API, and web search tooling. Commodity text generation is routed through OpenRouter, and OCR
  through Mistral — so this skill's scope is _only_ the Anthropic-native surface.

## Report format

Lead with a one-line verdict, then detail. Rank every action item by severity — this is how the
user triages, so do not present items at equal weight:

- **Blocking** — wrong or imminently breaking: a model in use is retiring (give the date), a
  model in use is missing from `MODEL_PRICING`, or an SDK `Usage` field changed. Fix before
  trusting the pipeline / before the deadline.
- **Judgment call** — a real decision with a tradeoff: adopt a newly-released model as a tier
  option, bump the SDK minor, change the pinning strategy. Present options and a lean, not a
  mandate.
- **Optional** — safe to defer: new betas, new tools, capabilities Gleanary doesn't use.

Structure:

```
## Verdict
<one line per axis where something changed; "current" axes get one word>

## What changed
- SDK package: <pinned> vs <latest> — <notable changelog entries, or "no change">
- Models: <new models> / <deprecations & retirement dates for models in use>
- Pricing: <changes vs MODEL_PRICING>
- API features: <caching / PDF / web search changes; web_search_count field status>

## Action items
**Blocking**
- ...
**Judgment call**
- ...
**Optional**
- ...

## Files to touch
<map each action item to the specific file/symbol from the baseline>
```

If all three axes are current (package on latest, no new/retiring models affecting Gleanary, no
pricing or feature change), say so in one line per axis and stop — don't manufacture work.

## Standing decisions

These recur on every check; decide once and record here rather than re-litigating.

**SDK version pinning.** Caret (currently `^0.112.4`). Because the SDK is pre-1.0, a minor
can break the `Usage` shape or method signatures Gleanary depends on.

- **Decision (2026-07-21):** keep the caret; minors arrive via Dependabot PRs, which get
  triaged through `/babysit-deps` (changelog read, CI, adoptable features filed as issues —
  the 0.112 bumps → Sonnet 5 model option is the working example). No change needed here on future checks.

**Single source of truth for model IDs + pricing.**

- **Decision (2026-07-21): resolved in the repo.** `ALL_CLAUDE_MODELS` in `src/lib/models.ts`
  is the registry: one entry drives selectors and the rate card. Adopting a model = one entry
  there; the only extra touches are the `DEFAULT_*` constants and the two schema defaults, and
  only when the default model changes (schema change → migration + `architecture.md` §5).

## Maintenance

After a confirmed check, update **Current integration baseline** so the next run diffs against
reality, not history:

- Bump **Last verified** to today.
- Update **Latest on npm** and, if Gleanary bumped, the **Pinned in `package.json`** line.
- Refresh the **Known stale signals** list — remove what's been actioned, add newly-released
  models and any new retirement dates for models Gleanary uses.
- If an SDK `Usage` field or an API feature changed, update the relevant Axis 1/3 line.

If the user applies the changes in Gleanary, the source of truth shifts to the repo:
`src/db/schema.ts` → `CHANGELOG.md` → module specs → `docs/architecture.md`. This baseline is a
convenience snapshot, not authority — when they conflict, the repo wins.

## Relationship to the other watch skills

This is the Anthropic-native sibling of `mistral-ocr-update-check`. Keep them separate: one
provider per skill keeps each baseline concrete and each trigger sharp. If deep-research lands on
Kimi K2 via OpenRouter, a third sibling with its own baseline is the right move rather than
widening this one.
