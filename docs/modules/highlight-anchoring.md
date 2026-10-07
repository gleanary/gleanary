# Module: Robust Highlight Anchoring (Text-Quote)

**Status**: Done (pending backfill run and v1 fallback removal — see TECH_DEBT.md)
**Last verified against code**: 2026-06 (Module 20, session 2)
**Schema tables**: `highlights` (added `anchor_status`)
**Implemented sections**: §3-§5 core, §6 reader/jsdom wiring, §7 schema/types/validation, §8 `reanchor-highlights` route, §9 backfill script + lazy reader fallback, §10 orphan badge
**Unimplemented sections**: none (v1 fallback removal deferred to after backfill confirmation — see TECH_DEBT.md)
**Depends on**: Module 4 (Reader View), Module 5 (Highlight Library)
**Blocks**: Custom Ingestion Format Scripts (re-anchoring on reformat depends on this)

---

## 1. Purpose

Replace the current child-index DOM-path anchoring with a **text-quote + text-position** model so highlights survive changes to an article's HTML — reformatting, AI cleanup, re-extraction, and (the motivating case) re-running a custom format script. This is the same mechanism Kindle uses to keep highlights across book editions: anchor to the _text and its surrounding context_, not to a position in one specific rendering.

After this lands, mutating an article's `content_html` no longer silently breaks its highlights. Highlights that can still be located are re-anchored automatically; highlights that genuinely no longer exist in the new content are flagged **orphaned** for review rather than dropped.

---

## 2. Problem with the current model

`highlights.position_data` currently stores:

```json
{
  "startContainerPath": [2, 0, 5],
  "startOffset": 12,
  "endContainerPath": [2, 0, 7],
  "endOffset": 4,
  "text": "..."
}
```

`*ContainerPath` is a child-index walk from the content root ("3rd child -> 1st child -> 6th child"). Any transform that inserts, removes, or reorders a node before the highlight invalidates every path after it. Reformatting at ingestion is, by design, exactly such a transform. The only reason this hasn't caused widespread breakage yet is that today's on-demand "Format with AI" is rare and usually run before highlighting; moving reformat to ingestion and making it re-runnable makes the fragility load-bearing.

The stored `text` field is the asset we build on — it already contains the quote, which is the durable identifier.

---

## 3. Anchor model (`position_data` v2)

A v2 anchor combines a **TextQuoteSelector** (durable) with a **TextPositionSelector** (fast path), per the W3C Web Annotation model.

```ts
// src/types/index.ts
export interface TextQuoteAnchor {
  v: 2;
  exact: string; // the highlighted text (verbatim, from the root text stream)
  prefix: string; // up to ANCHOR_CONTEXT_LEN chars immediately before `exact`
  suffix: string; // up to ANCHOR_CONTEXT_LEN chars immediately after `exact`
  start: number; // char offset of `exact` start into the root text stream
  end: number; // char offset of `exact` end (exclusive)
}
```

Constants (`src/lib/highlight-anchoring.ts`):

- `ANCHOR_CONTEXT_LEN = 32` — prefix/suffix window. Enough to disambiguate repeated quotes without bloating rows.
- `ANCHOR_MAX_ERROR_RATIO = 0.25` — fuzzy match tolerance; `maxErrors = clamp(round(exact.length * RATIO), 1, 64)`.

The version discriminant `v` is mandatory. Rows without it are treated as **v1** (legacy) and upgraded (see §9).

---

## 4. The "root text stream" and offsets

All offsets and context are computed over a single canonical string: the **in-document-order concatenation of every text node's value within the content root**, with **no whitespace normalization**.

- Reproducible directly from the DOM at any time (no stored intermediate).
- Cross-element ranges fall out naturally — a highlight spanning `<p>...</p><p>...</p>` is just a `[start, end)` slice of the stream.
- Identical in the browser and in jsdom, which is what lets the same code run client-side and server-side (see §6).

`getRootText(root)` returns the stream; a parallel index lets us map a stream offset back to `{ node, nodeOffset }` for `Range` construction.

> Decision logged: raw concatenation over normalized text. Normalization (collapsing runs of whitespace) would make offsets more robust to whitespace-only reformat changes, but breaks reproducibility-from-DOM and complicates offset<->node mapping. Fuzzy matching (see §5) already absorbs whitespace drift, so raw wins.

---

## 5. Algorithm

### Describe (selection -> anchor) — on create / boundary edit

`describeRange(root, range): TextQuoteAnchor`

1. Compute `start`/`end` by mapping the `Range` endpoints into root-text-stream offsets.
2. `exact = stream.slice(start, end)`.
3. `prefix = stream.slice(max(0, start - CONTEXT_LEN), start)`; `suffix = stream.slice(end, end + CONTEXT_LEN)`.
4. Return `{ v: 2, exact, prefix, suffix, start, end }`.

### Resolve (anchor -> range) — on render / re-anchor

`anchorToRange(root, anchor): Range | null`

1. **Position fast path.** If `stream.slice(anchor.start, anchor.end) === anchor.exact`, build the `Range` from those offsets and return. (No mutation -> no drift; the common case where content is unchanged.)
2. **Quote fuzzy path.** Otherwise run approximate string search for `prefix + exact + suffix` (then narrow to `exact`) across the stream, seeded near `anchor.start`, accepting the best match within `maxErrors`. Prefix/suffix disambiguate when `exact` occurs multiple times; the position seed breaks ties toward the original location.
3. **Orphan.** If no match within tolerance, return `null`.

On a successful fuzzy resolve, recompute and persist the v2 anchor (offsets + context refreshed) so the fast path hits next time.

---

## 6. Architecture: one core, two environments

`src/lib/highlight-anchoring.ts` becomes **environment-agnostic** — pure functions over the standard DOM `Element`/`Range`/`Text` interfaces, which exist in both the browser and jsdom (already a dependency). No `window`, no React, no Node APIs.

- **Browser (reader).** `highlight-layer.tsx` calls `describeRange` on creation and `anchorToRange` on mount for each highlight. `null` -> PATCH `anchorStatus: 'orphaned'`; a drifted-but-resolved anchor -> PATCH refreshed `positionData`. Orphan/drift PATCHes are deferred until `contentVersion` has advanced past 0 (i.e. `ArticleContent`'s async KaTeX pass has settled and fired `onReady`) — the first synchronous application pass runs against the pre-KaTeX DOM, where raw `$...$` delimiters would fuzzy-mismatch anchors captured against rendered math. Existing mark-injection (`getHighlightMarks`, `createRangeFromMarks`) is unchanged downstream of the `Range`.
- **jsdom (server, on reformat).** The re-anchor route (see §8) parses the _new_ `content_html` into a jsdom document, runs `anchorToRange` against it for every highlight, and persists refreshed anchors / orphan flags — without waiting for the user to open the article.

This shared core is the reuse win: the format-script pipeline gets server-side re-anchoring "for free" by calling the same functions.

> Note: jsdom re-anchoring computes and stores anchors only. Visual `<mark>` rendering stays browser-only in `highlight-layer.tsx`.

---

## 7. Schema, types, validation

- **Migration**: add `highlights.anchor_status TEXT NOT NULL DEFAULT 'anchored'` with enum `'anchored' | 'orphaned'`. (New column -> migration + `docs/architecture.md` §5 update + this spec's status block.)
- **`position_data`**: column type unchanged (TEXT JSON). Stored shape changes from v1 to `TextQuoteAnchor` (v2). Server treats it as opaque beyond Zod-validating the JSON.
- **Types** (`src/types/index.ts`): add `TextQuoteAnchor`; add `'anchored' | 'orphaned'` `AnchorStatus`; extend `HighlightWithContext` with `anchorStatus`.
- **Zod** (`src/lib/validators.ts`): add `textQuoteAnchorSchema`; `position_data` on POST/PATCH must parse as either a v2 anchor or (transitional) a v1 shape. After backfill completes, drop v1 acceptance.

---

## 8. API contract

Minimal, since `position_data` was always opaque JSON.

- `POST /api/highlights` — body carries a v2 `positionData`; `anchorStatus` defaults `'anchored'`.
- `PATCH /api/highlights/[id]` — may update `positionData` (boundary edits, refreshed offsets) and `anchorStatus`.
- `GET /api/highlights` — `HighlightWithContext` now includes `anchorStatus`. (Library can badge orphans.)
- **New** `POST /api/articles/[id]/reanchor-highlights` — re-anchors all highlights for one article against current `content_html` using jsdom. Idempotent. Zod-validated `id`. Single-user (`userId = 1`).
  - **Response** `200`: `{ reanchored: number, orphaned: number, unchanged: number }`
  - Intended caller: the format-script reformat flow, after it rewrites `content_html`. Also callable standalone after any content mutation.

---

## 9. Migration (v1 -> v2)

Eager, one-time backfill with a lazy safety net.

- **Script** `scripts/backfill-highlight-anchors.ts`: for each article, load `content_html` into jsdom; for each highlight:
  1. If already v2 -> skip.
  2. If v1 -> reconstruct the `Range` via the ported legacy path logic, then `describeRange` -> persist v2.
  3. If legacy path reconstruction fails (already broken) -> fuzzy-match the stored `text` alone (no context) against the stream; on hit synthesize a v2 anchor with derived context, else set `anchorStatus: 'orphaned'`.
- **Lazy fallback**: the reader's resolve step accepts a v1 anchor for one release — upgrading it in place on first successful render — so highlights created between deploy and backfill aren't lost. Remove v1 handling once backfill is confirmed.

---

## 10. Orphan handling

- Data-first in v1 of this module: orphaned highlights are **not rendered in the reader** (no valid range) but remain fully intact in the library with their `text`, `note`, and tags, badged "needs re-anchoring."
- The library badge is the only UI surface this spec ships. A richer recovery flow (manual re-place, "find similar," bulk dismiss) is **out of scope** and deferred.

---

## 11. Edge cases

- **Repeated quote** (same `exact` many times): prefix/suffix + position seed disambiguate; if still ambiguous after large drift, orphan.
- **Cross-element / cross-paragraph range**: handled by stream offsets; range reconstruction walks to the correct start/end text nodes.
- **Whitespace-only reformat changes**: absorbed by fuzzy tolerance; position fast path may miss but quote path recovers.
- **Boundary edit via drag handles**: recompute full v2 anchor on save (existing PATCH of `text` + `positionData`).
- **Very short quote** (1-2 words) in a heavily mutated article: may exceed ambiguity tolerance -> orphan. Acceptable.
- **Idempotency**: resolving an unchanged anchor must not drift offsets (guaranteed by the position fast path returning before any recompute).
- **Performance**: position fast path avoids fuzzy search for the unchanged-content common case. Compute the root-text stream once per render/re-anchor pass and share it across all highlights. Bound `maxErrors`.
- **Empty/whitespace selection**: rejected at create (existing behavior).
- **Image-only / no-text content**: anchoring is N/A; highlights require selected text, so no new failure mode.

---

## 12. Security

- `position_data` is **data, not code** — Zod-validated JSON, never evaluated. No injection surface.
- No new external network, no URL fetch -> no SSRF surface; `validateUrl()` not implicated.
- XSS invariant unchanged: anchoring only produces a `Range` over already-sanitized text nodes and wraps them in `<mark>`. No anchor field is ever inserted into the DOM as markup.
- New dependency (fuzzy matcher, see §13) is pure JS; include in `npm audit` review per `SECURE`.
- `reanchor-highlights` route: Zod-validated `id`, single-user, no untrusted input beyond the article's own stored content.

---

## 12.1 KaTeX class dependency

`getTextFromNode` (in `src/lib/highlight-anchoring.ts`) reconstructs the LaTeX source of rendered math when extracting a highlight's text, so it is coupled to KaTeX's output markup. Four class names and one annotation selector are **load-bearing** — a KaTeX bump that renames any of them silently breaks math-highlight extraction:

- `.katex` — the math wrapper; its presence triggers LaTeX reconstruction.
- `.katex-mathml` — the MathML subtree, skipped entirely to avoid double-extracting the annotation text.
- `.katex-html` — the visual rendering, used as the text fallback when no annotation is present.
- `.katex-display` — the display-block wrapper; `.closest('.katex-display')` selects `$$…$$` vs inline `$…$` delimiters.
- `annotation[encoding="application/x-tex"]` — the raw LaTeX source, the preferred reconstruction path.

These same names are used in `src/components/reader/article-content.tsx` (the `.katex` readiness check) and `src/app/globals.css` (`.katex-error`, `.katex-display` styling). They were **unchanged by KaTeX 0.18** — that release prefixed only the previously-unprefixed _internal_ classes (`base`→`katex-base`, `strut`→`katex-strut`, `sizing`→`katex-sizing`, …), none of which this code touches. `__tests__/unit/highlight-anchoring.test.ts` pins this contract against real `katex.renderToString()` output; **re-run those tests and re-verify this list on every KaTeX major/minor bump.**

---

## 13. Dependencies

- **`approx-string-match`** — small, focused, MIT, returns matches within k edits; the matcher Hypothesis uses for the same purpose. Add to `package.json`; no setup-step change, so no `README.md` update expected.
- **`katex`** — renders LaTeX math in the reader. Pinned to `^0.18.1`. See §12.1 for the class-name contract this module depends on; bumps must re-run the KaTeX unit tests and `e2e/math-article.spec.ts`.

---

## 14. Test plan

**Unit** (`__tests__/unit/highlight-anchoring.test.ts`):

- `describeRange` -> `anchorToRange` round-trip on the same DOM.
- Resolve after node insertion before / after / inside the highlight.
- Resolve with duplicate `exact` strings — prefix/suffix disambiguation.
- Resolve with whitespace drift within tolerance; reject beyond tolerance.
- Cross-element ranges.
- Orphan when the quote is removed.
- Offset reproducibility from a freshly parsed DOM.
- Idempotency: re-resolving an unchanged anchor leaves offsets untouched.

**Integration** (`__tests__/integration/highlight-anchoring.test.ts`):

- POST stores a valid v2 anchor; rejects malformed `positionData`.
- `reanchor-highlights` returns correct `{ reanchored, orphaned, unchanged }` counts.
- Orphaned highlight surfaces with `anchorStatus: 'orphaned'` in GET.
- v1 -> v2 backfill upgrades a legacy row; orphans an unrecoverable one.

**E2E** (`e2e/highlight-survives-reformat.spec.ts`):

- Create highlight -> apply a synthetic content mutation via `reanchor-highlights` -> reopen reader -> highlight still rendered at the correct text.

---

## 15. Resolved decisions

1. **Fuzzy matcher**: `approx-string-match`. Purpose-built for annotation anchoring (returns all matches within an edit-distance budget as scored ranges; no pattern-length cap). Candidate selection — lowest `errors`, ties broken by proximity to `anchor.start` — is implemented in our resolve step, not the library.
2. **Context length**: `ANCHOR_CONTEXT_LEN = 32`.
3. **Fuzzy tolerance**: `ANCHOR_MAX_ERROR_RATIO = 0.25` (`maxErrors = clamp(round(exact.length * 0.25), 1, 64)`). Compile-time constant for now; revisit from observed orphan-rate telemetry (the `reanchor-highlights` route already returns `orphaned` counts). Add a `TECH_DEBT.md` entry to make it a setting once telemetry justifies tuning, mirroring the `CHUNK_THRESHOLD` precedent.
4. **Migration style**: eager backfill script + lazy fallback (accept v1 anchors for one release, upgrading in place on first successful render; remove v1 handling after backfill is confirmed).
5. **Orphan UX in v1**: library badge only. Richer recovery flow deferred (see §10).

---

## 16. Sequencing

This module ships **before** the custom format-script feature. The script feature's re-anchor-on-reformat step is just a call to `POST /api/articles/[id]/reanchor-highlights`; without robust anchoring, changing a script would orphan highlights wholesale.
