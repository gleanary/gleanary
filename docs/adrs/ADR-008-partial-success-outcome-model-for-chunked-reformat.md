# ADR 008: Partial-success outcome model for chunked reformat

**Status**: Accepted
**Date**: 2026-05-21
**Related**: `docs/adrs/ADR-007-mistral-for-reformat.md` (Mistral provider for reformat), `docs/modules/content-pipeline.md` Phase 4 (Parallel chunking for long articles).

## Context

`docs/modules/content-pipeline.md` Phase 4 introduces parallel chunking for `POST /api/ai/clean` on inputs over 35k chars. Each chunk independently goes through Mistral → validate → (on failure) Haiku fallback → validate. This creates a per-chunk failure surface that does not exist in §3's single-call path.

The single-call path is binary: a reformat either succeeds and `content_html` is replaced, or fails (validation, both providers, or hard error) and `content_html` is untouched. There is no "partial" state to design around.

The chunked path can produce any combination across N chunks: some succeed on Mistral, some succeed only after Haiku rescue, some fail both providers. The article-level outcome is a function of those N per-chunk outcomes, and the function we pick has direct user-facing and operational consequences.

This ADR settles the outcome function.

## Decision

**Partial success is the article-level outcome rule.** As long as at least one chunk reformats successfully (with or without Haiku fallback), the article is updated. Chunks where both providers failed have their original sanitized HTML substituted into the final assembly. The reader view surfaces an outcome banner when any chunks were skipped. Structured logs emit one event per chunk capturing provider, status, and validation-failure reason.

The outcome map:

| Chunks reformatted | Chunks fallback-rescued | Chunks skipped | Article outcome                                      | Banner                                                |
| ------------------ | ----------------------- | -------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| N                  | 0                       | 0              | `content_html` updated                               | none                                                  |
| ≥ 1                | ≥ 1                     | 0              | `content_html` updated                               | none (fallback is internal)                           |
| ≥ 1                | any                     | ≥ 1            | `content_html` updated, skipped chunks keep original | "Reformatted with AI (X/N sections; M kept original)" |
| 0                  | 0                       | N              | `content_html` untouched                             | "Reformat failed" (matches §3 failure UX)             |

## Rationale

The original chunk content is already DOMPurify-sanitized at ingestion. Substituting it on per-chunk failure preserves readability — the only thing lost on a failed chunk is the reformatting itself, not the content. Users keep a fully readable article either way.

All-or-nothing would discard up to N−1 successful reformats because chunk N drifted. The cases where chunking helps most (long articles, where any single-call attempt currently fails outright due to the 50k truncation) are exactly where partial success is most valuable: the user goes from "reformat is unavailable" to "most of the article is reformatted." Throwing that away on the first chunk-level failure inverts the purpose of building chunking in the first place.

The pattern also mirrors the existing per-article fallback (Mistral fails → Haiku → give up) at a finer grain. Per-article logic already knows how to handle "primary failed, fallback rescued" without surfacing it to the user. Per-chunk logic inherits that pattern; the only new UI surface is the case where fallback also fails.

## Alternatives considered

**All-or-nothing.** Any single chunk failure abandons the whole reformat. _Rejected._ Discards N−1 successful reformats for one chunk's drift. Worst on exactly the long articles chunking exists to help. Equivalent to "we built chunking to handle long articles, but a single small-model wobble anywhere reverts that benefit."

**Retry-all-on-any-fail.** On any chunk failure, restart all N chunks from scratch. _Rejected._ Drift on chunk N is not correlated with chunks 1…N−1 — there is no reason to expect retried-identical chunks to do better than they did the first time. Multiplies cost without improving expected outcome. Pathological on long articles where partial-failure rates are highest.

**Silent best-effort.** Substitute original content on failed chunks but emit no UI signal. _Rejected._ Creates an invisible quality regression — the user cannot tell when output is mixed and cannot make informed decisions about whether to trust the reformatted version. Also undermines our ability to surface fallback-rate telemetry meaningfully if the UI surface is hidden: if "partial reformat" is invisible to users, it tends to also become invisible to maintainers.

**Per-chunk retry on Mistral before falling back to Haiku.** Retry the Mistral call once on validation failure before escalating to Haiku, on the theory that small-model drift may be non-deterministic. _Considered, deferred._ Strictly speaking this is orthogonal to the partial-success policy — it's a per-chunk pipeline optimization. If telemetry shows that retried-identical Mistral chunks recover a meaningful fraction of fallback cases, this can be added without revisiting this ADR. Tracked as a TECH_DEBT item.

## Consequences

**Positive**

- Reformat success rate on long articles goes up materially. The current "reformat unavailable for articles >50k chars" failure mode is replaced by graceful degradation. Long-article users are the most under-served population today; partial success serves them disproportionately well.
- Per-chunk failure isolation prevents single-chunk drift from corrupting the whole article. The blast radius of small-model wobble shrinks from "whole reformat" to "one section."
- Per-chunk telemetry falls out for free via `run_id` grouping. The fallback-rate observability item already in TECH_DEBT (currently planned per-article) becomes per-chunk and meaningfully more actionable.
- Establishes a partial-success pattern reusable for any future module that fans out N subtasks and recombines them. The deep research module under design has exactly this shape (many subagents, some may fail, surface mixed outcome). This ADR's reasoning carries over directly.

**Negative**

- UI surface area for the mixed-state banner. Adds a piece of reader-view chrome that did not exist before. Mitigated by only surfacing it when `skipped > 0` — internal fallback (Mistral failed but Haiku rescued) is not user-visible.
- Users have to understand "partial reformat" as a concept. The banner copy ("8/9 sections; 1 kept original") is the entire user-education surface; if users find that confusing, the copy is iterable independently of the policy.
- Telemetry queries on reformat success rate now have to distinguish full / partial / failed. The structured log event includes enough to disambiguate (`status` field per chunk), but any future Usage-view reformat-success metric needs a clear definition of what counts. We should not assume a single "success rate" number is unambiguous.
- Cost on partial-failure articles is slightly higher than all-or-nothing would be — we pay for the successful chunks even when some fail. On Ministral pricing this is negligible per article (cents) and dominated by the value of partial output; it would matter more on a more expensive provider.

**Neutral**

- Does not affect §3's single-call path. Articles under the 35k threshold continue to use single-call semantics with their existing binary outcome. No regression risk for the population that works fine today.
- Does not introduce schema changes. `ai_usage.run_id` already exists; the structured log event is fire-and-forget through the existing pino logger.
- The deferred SSE progress-streaming work (TECH_DEBT) is independent of this policy. Whether the user sees per-chunk progress mid-flight is orthogonal to whether the article ends up partially or fully reformatted.

## Revisit conditions

This ADR should be reconsidered if any of the following hold:

- The per-chunk skip rate in production exceeds 5% over a 7-day window. At that point the banner is appearing frequently enough to be noise rather than signal, and the underlying chunk reliability needs to improve before the policy is the right question.
- Users report confusion about the mixed-state banner that copy iteration cannot resolve.
- A future provider with sufficiently expensive output costs makes the "pay for successful chunks even on partial failure" trade-off materially worse. Ministral pricing does not.
- The deep research module ships with a meaningfully different fan-out outcome model. If two modules end up with divergent partial-failure semantics, we should reconcile them rather than let inconsistency calcify.
