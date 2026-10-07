---
name: mistral-ocr-update-check
description: Check whether Mistral has shipped a new OCR model version and work out exactly what it would take to integrate it into Gleanary's PDF pipeline. Use this whenever the user asks about Mistral OCR updates, a new OCR version, OCR pricing changes, whether to update the OCR model, what `mistral-ocr-latest` currently resolves to, or mentions catching up on AI-provider/model currency for the PDF extraction path — even if they don't name a version. Also trigger it proactively if the user shares a Mistral OCR announcement and asks "should I update?". Do NOT use it for general Mistral chat-model questions, Anthropic/OpenRouter model updates, or unrelated OCR libraries.
---

# Mistral OCR update check

## Why this exists

Gleanary's PDF import pipeline depends on Mistral OCR, currently pinned to `mistral-ocr-4-0`.
Pinning prevents silent price or schema changes, but it means new OCR versions don't auto-adopt.
Relying on stumbling across a blog post is unreliable and tends to surface the news _after_ the
bill or quality story has moved on. This skill replaces that with a deliberate check against
canonical sources, and turns the result into a Gleanary-specific integration verdict rather than
a generic "there's a new version" headline.

The output the user wants is not "OCR N exists." It is: _what changed, what it costs, what
breaks, and what I have to do_ — ranked so they can act.

## What to check, and where

Mistral marketing posts are the _least_ reliable signal (you have to happen across them). The
docs and model card are authoritative and stable to look up. Use the assistant's `web_fetch`
and `web_search` tools for all of these — the bash sandbox cannot reach `mistral.ai`.

Check these, in order:

1. **Models overview** — `https://docs.mistral.ai/models/overview`. This lists the current OCR
   model and which dated string the `mistral-ocr-latest` alias points to _right now_. This is
   the ground truth for "what am I actually calling." If `latest` has moved to a version newer
   than the baseline below, that is the headline.
2. **The current OCR model card** — linked from the overview, e.g.
   `https://docs.mistral.ai/models/model-cards/ocr-<version>`. Gives the pinned dated id,
   pricing, and the capability list. Do not hardcode the version in the URL; follow the link
   from the overview so you always land on the current one.
3. **OCR pricing** — `https://mistral.ai/pricing/` (API section). Confirm the per-1,000-pages
   standard rate and the batch rate. Pricing is the single highest-impact field for Gleanary,
   so verify it from the pricing page rather than trusting a number paraphrased in an article.
4. **OCR capability / response-format docs** — the OCR section under
   `https://docs.mistral.ai/` (the OCR processor / annotations pages). This is where the
   response JSON shape lives (the `pages[]` array and its fields). Use it to detect renamed or
   added fields that could break Gleanary's parsing.
5. **Announcement post (optional, for the "why")** — search `mistral OCR <N> release` or fetch
   the relevant `https://mistral.ai/news/...` post. Use it only for benchmark context, migration
   notes, and the feature narrative. Treat its numbers as directional; the docs win on facts.

If a source is unreachable or ambiguous, say so plainly rather than guessing. A confident wrong
price is worse than "the pricing page didn't load — please check it directly."

## How to run the check

1. Fetch sources 1–3 (and 4 if a version bump is detected). Establish three facts: the current
   model behind `mistral-ocr-latest`, the standard per-page price, and whether the response
   schema changed.
2. Diff each against the **Current integration baseline** section below.
3. Triage any new capabilities against what Gleanary actually does (a single-user reading app
   that extracts clean text + tables + images from PDFs for reading and highlighting). Most
   enterprise/RAG features are irrelevant; a few may matter. Be honest about which is which.
4. Produce the report in the format below.
5. Update the baseline section (see **Maintenance**).

## Current integration baseline

> Keep this section current. It is the reference the diff is measured against. After any
> confirmed check, update it (see Maintenance) so the skill ratchets forward instead of drifting.

- **Last verified:** 2026-06-24
- **Model string in code:** `mistral-ocr-4-0` (pinned since commit d477c2a, Jun 2026)
- **Resolves to:** Mistral OCR 4 (released 2026-06-23)
- **Standard price assumed in code:** $4 / 1,000 pages = $0.004/page (OCR 4 rate). Stored in
  `PAGE_BASED_PRICING` in `src/lib/pricing.ts`, keyed by model id.
- **Call pattern:** synchronous on upload, **standard** API (not Batch), one request ≤ 1,000
  pages / ≤ 50 MB, PDF uploaded to the Files API via multipart.
- **Files that touch OCR:**
  - `src/lib/mistral-ocr.ts` — `callMistralOcr()`, request params, `MistralOcrPage` interface,
    `MISTRAL_IMAGE_MIN_SIZE = 100`
  - `src/lib/pdf-processor.ts` — orchestration, image/table side-effects, HTML pipeline
  - `src/lib/pricing.ts` — `PAGE_BASED_PRICING`
  - `src/lib/ai-usage.ts` — `recordPageBasedUsage()`; writes `ai_usage.pagesProcessed`
- **Request params currently sent:** `extract_header: true`, `extract_footer: true`,
  `table_format: 'html'`, `image_min_size: 100`.
- **Response fields currently consumed:** `pages[].markdown`, `pages[].images[]`,
  `pages[].tables[].html` (note: `.html`, not `.content` — a past bug), per-page header/footer
  fields, page `dimensions`. Everything flows markdown → `marked` → `postProcessHtml({ isPdfContext: true })`.
- **Known historical-data caveat:** older `ai_usage` rows recorded under `mistral-ocr-latest`
  were priced at whatever the alias resolved to at the time (OCR 1 → 3 → 4); historical cost is
  not retroactively recoverable. New rows are correct as long as `PAGE_BASED_PRICING` matches the
  current resolved version.

## Report format

Lead with a one-line verdict, then detail. Rank every action item by severity using these three
labels, because that is how the user triages — do not present items at equal weight:

- **Blocking** — something is now wrong or will break (e.g. price constant stale, response field
  renamed). Must fix before trusting the pipeline.
- **Judgment call** — a real decision with a tradeoff and no obviously-correct answer (e.g. pin
  vs. keep floating, adopt a new param). Present the options and a lean, not a mandate.
- **Optional** — a genuine improvement that is safe to defer (e.g. a new capability worth a
  future module).

Use this structure:

```
## Verdict
<one line: is there a new version, and is action required?>

## What changed
- Version: <baseline resolved version> → <current>, released <date>
- Price (standard): <baseline> → <current> per 1,000 pages  [flag if changed]
- Response schema: <unchanged | fields added/renamed — name them>
- New capabilities: <short list>

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

If nothing changed (alias still on the baseline version, same price, same schema), say so in one
line and stop — don't manufacture work.

## Standing decision: pin vs. float

This tension recurs on every check, so decide it once and record the decision here rather than
re-litigating it each time.

- **Floating (`mistral-ocr-latest`, current state):** zero-effort upgrades, but Mistral controls
  Gleanary's bill and output behavior silently. OCR 4 doubling the page price with no deploy is
  exactly this failure mode.
- **Pinned (dated id, e.g. the `ocr-<N>` string from the model card):** version moves become
  deliberate; `PAGE_BASED_PRICING` stays keyed to a known model; a future OCR 5 doesn't
  auto-enroll. Cost is manual bumps to get improvements.

Given Gleanary is single-user with controlled deploys and a stated "cost visibility before
expensive features" principle, pinning aligns better with the project's values. If the user has
already chosen, record it here:

- **Decision:** **Pin.** Code already uses `mistral-ocr-4-0`. Upgrade deliberately when OCR 5 ships and action items are clear.
- **Decided on:** 2026-06-24 (implicit in commit d477c2a)

## Maintenance

After a confirmed check, update **Current integration baseline** so the next run diffs against
reality, not history:

- Bump **Last verified** to today.
- If the alias moved, update **Resolves to** and the **Standard price assumed in code** to match
  what `PAGE_BASED_PRICING` will be set to once the action items are applied.
- If a request param or response field changed, update the two relevant lines.

If the user actually applies the integration changes in Gleanary, the source of truth shifts to
the repo: `src/db/schema.ts` → `CHANGELOG.md` → module specs. This skill's baseline is a
convenience snapshot, not authority — when they conflict, the repo wins.

## Generalizing later (note, not part of the check)

The check → diff → severity-ranked integration verdict pattern is the reusable part. If the user
later wants the same reliability for other Gleanary AI dependencies (Anthropic models behind the
native SDK, OpenRouter commodity models, Kimi K2 for deep research), clone this skill with a new
baseline section and provider-specific source URLs. Don't fold them into this skill — keeping one
skill per provider keeps each baseline concrete and the trigger sharp.
