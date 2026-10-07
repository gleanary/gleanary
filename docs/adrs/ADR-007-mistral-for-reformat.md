# ADR 007: Use Mistral (Ministral 3 8B) for article reformatting, with Anthropic Haiku fallback

**Status**: Accepted
**Date**: 2026-05-19
**Related**: Fast Reformat design work (in progress; final location to be decided per the spec-placement discussion — either as a section of `docs/modules/ai-features.md` or a standalone `docs/modules/fast-reformat.md`).

## Context

The existing "Reformat with AI" feature (`POST /api/ai/clean`) sends article HTML to Anthropic Claude Haiku for structural cleanup — collapsing layout tables, dropping tracking pixels, normalizing image grids, fixing tag balance. Observed wallclock on typical articles is 50–80 s, dominated by sequential output-token generation against ~6–8K-token outputs.

Two pressures motivated revisiting the provider:

1. **User-perceived speed.** PDF reformatting via Mistral OCR completes in seconds, while HTML reformat takes nearly a minute. The two are different tasks (vision-based extraction vs. text-in/text-out rewriting) and the comparison isn't fair, but the perception that article "AI reformat is slow" is real, and the bottleneck for HTML specifically is output throughput.

2. **Cost.** Reformat is one of the most output-heavy AI calls in the system — roughly 8K output tokens per run. Haiku at approximately $4 per M output tokens makes each call cost on the order of cents. At meaningful import volume, that adds up much faster than the other AI features (summarize, tag, explain), which generate far fewer output tokens. Auto-reformat-on-parse, which the broader Fast Reformat design depends on, is only economically viable at meaningfully lower output prices.

Mistral OCR is not a drop-in replacement — it accepts PDFs and images only, not HTML. The question is whether a Mistral text-in/text-out chat model is fast enough and cheap enough to justify onboarding a second provider.

## Decision

**Use Ministral 3 8B via Mistral's first-party API as the primary provider for article reformatting. Keep Anthropic Claude Haiku as automatic fallback when Mistral is unavailable, rate-limited, or produces output that fails post-stream validation.**

Both providers route through a unified internal interface (`callMistral` / `callMistralStreaming` mirror the existing Claude helpers). The active provider is controlled by a `reformat_provider` setting (default `mistral`). The fallback path is automatic and logged, not user-visible except when the fallback rate crosses a threshold that surfaces a settings warning.

## Rationale

Ministral 3 8B hits a useful sweet spot among Mistral's lineup for this task.

| Metric                                        | Ministral 3 8B (Mistral API) | Claude Haiku 4.5                    |
| --------------------------------------------- | ---------------------------- | ----------------------------------- |
| Sustained output speed                        | ~158 t/s                     | ~100 t/s                            |
| TTFT                                          | 0.54 s                       | ~0.5 s                              |
| Pricing in / out per M tokens                 | $0.15 / $0.15                | ~$0.80 / $4                         |
| Intelligence Index (Artificial Analysis v4.0) | 15                           | not directly comparable             |
| Prompt caching                                | none                         | yes (90 % discount on cached input) |

The throughput improvement is meaningful but modest — roughly 1.5× on the primary path. **The cost reduction is the larger lever**: roughly 25× cheaper on output, which is where reformat spends. At Ministral pricing, auto-reformat-on-parse becomes economically negligible (cents per hundred articles); at Haiku pricing it becomes a real ongoing cost that would push the design toward "only on user request."

Intelligence Index 15 is enough headroom for faithful HTML structural rewriting on the inputs we observe — newsletters, RSS articles with layout tables, articles with consecutive image grids. The residual risk is structural drift: small models occasionally drop content, break tag balance, or paraphrase against instructions. This risk is **mitigated, not eliminated**, by post-stream validation (length bounds, sanitization, structural sanity checks) with automatic Haiku fallback when validation fails. Drift becomes a small latency cost on affected articles rather than a silent quality regression.

Haiku is retained as fallback rather than replaced outright because:

- A single-provider design has no defense against Mistral outages or rate-limit events.
- Haiku is already integrated, instrumented, and well-understood; the marginal cost of keeping it as a fallback is low.
- Validation-failure fallback converts small-model drift from a quality risk into a latency cost.

## Alternatives considered

**Mistral OCR (`mistral-ocr-latest`)** — rejected. Input modality is PDF / JPEG / PNG / TIFF / WEBP / AVIF / DOCX / PPTX only; HTML is not supported. Rasterizing HTML to PDF then OCR'ing it would lose hyperlinks, code formatting, and semantic structure beyond what's visually obvious, and would break DOM-based highlight anchoring. Not viable for content that already arrived as HTML.

**Ministral 3 3B** — rejected. Faster (~226 t/s) and cheaper ($0.10 / $0.10), but Intelligence Index 11 and flagged as verbose by Artificial Analysis. Faithful structural rewriting on long HTML inputs is the wrong task for a 3B model. Expected fallback rate too high to be the primary path.

**Mistral Small 3.2 (24B)** — kept as a second-tier escalation, not selected as primary. Slower (~126 t/s on Mistral, 186 t/s on DeepInfra FP8), higher output cost ($0.30 per M). Intelligence comparable to Ministral 8B in practice. No strong reason to prefer it over 8B at the outset, but it's the natural escalation if 8B's fallback rate proves too high in production.

**Bedrock-hosted Ministral 8B** — rejected for v1. Faster (~285 t/s) but adds AWS auth, billing, and IAM surface to the settings module. Not worth the integration cost for a single-user app. Worth reconsidering only if Phase 3 chunking lands and per-call latency still matters.

**DeepInfra-hosted Mistral Small 3.2 (FP8)** — rejected for v1, similar reasoning. Adds a third provider relationship for marginal speed gain.

**Stay on Haiku, only add streaming** — partially rejected. Streaming alone (without changing provider) gives meaningful UX improvement (the user sees content arrive) but does nothing about cost, which is the larger lever once auto-reformat-on-parse is in place. Streaming is happening anyway as part of the work; the provider swap is the additional, separable decision this ADR records.

**Groq- or Cerebras-hosted open-weight models** — out of scope for this decision. Genuinely faster (500–1500 t/s) but neither hosts Mistral models in a way that materially beats Mistral's own API for the small-model tier we're targeting. Worth a fresh evaluation if a future feature needs near-real-time inference.

## Consequences

**Positive**

- Output cost per reformat drops by roughly an order of magnitude. Auto-reformat-on-parse becomes affordable.
- Throughput improvement is ~1.5×, modest but real, and stacks with the parallel chunking option deferred to Phase 3.
- Adds a second provider relationship, which is also useful as a forcing function for the upcoming Research module's provider strategy.
- Establishes the fallback pattern (`callMistral` / `callMistralStreaming` mirror of the existing Claude helpers), reusable for any future feature considering non-Anthropic providers.

**Negative**

- New API key surface in settings (`mistral_api_key`, AES-encrypted, with a Test Connection endpoint).
- AI Usage Tracking needs to handle a non-Anthropic provider — either a new `provider` column on the usage row, or new `feature` enum values that encode provider. Decision belongs in that module's spec; flagged here so it isn't missed.
- Pricing rate card (`src/lib/pricing.ts`) needs new entries for Ministral 3 8B and Mistral Small 3.2 (fallback tier).
- Small-model drift risk: occasionally produces output that fails validation and falls back to Haiku. Adds latency on those articles; not a quality regression because the fallback path produces the same output as the current Haiku-only design.
- No prompt caching on Mistral. Phase 3 chunking would pay full input cost on each chunk; cheap on Ministral but worth noting if chunking ever migrates to a more expensive provider.
- Fallback path roughly doubles the testable surface for every reformat code path — both providers must be exercised in integration tests.

**Neutral**

- Adds Mistral to the project's external-dependency list alongside Anthropic, Inworld, Jina, Readwise, and IMAP. Within the established pattern of narrow third-party services for specific tasks.
- Decision should be revisited if Ministral 3 8B is sunset, significantly repriced, or substantially outperformed by a successor. Reasonable expected lifetime: 18–24 months. A successor ADR should supersede this one rather than amend it.

## Open questions for resolution before acceptance

These were surfaced in the Fast Reformat design discussion and are tracked here for completeness, but their resolution does not block the provider decision itself.

1. Should the Mistral API key be a hard requirement, or should the system silently fall back to Haiku when the key is absent? (Recommendation: silent fallback with a settings warning, to keep the first-run experience working without configuration.)
2. Fallback threshold for surfacing a settings warning — what fallback rate over what window indicates "Mistral is degraded enough to switch primary"? (Suggested starting point: 10 % over 1 hour, tunable.)
3. Should AI Usage Tracking accumulate `provider` as a column or as part of `feature`? (Defer to that module's spec; mention here so the resolution lands consistently.)
