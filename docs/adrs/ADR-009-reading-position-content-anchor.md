# ADR-009: Reading Position Stored as a Block Content Anchor

**Date**: 2026-10
**Status**: Accepted

## Context

The reader saved position as a single ratio (`articles.reading_progress`, 0–1) and restored it as `readingProgress × scrollable height` one frame after mount. Reopening an article landed about a paragraph below where the reader had stopped: images without stored dimensions and async KaTeX had not laid out yet, so the scrollable height at restore time was not the height the ratio was measured against, and browser scroll anchoring then preserved the overshoot (#26).

## Decision

Persist a **content anchor** next to the ratio: the index of the first block element (`BLOCK_SELECTORS` in `src/lib/reading-anchor.ts`, shared with the TTS word highlighter) whose bottom is below the viewport top, plus the fraction (0–1) of that block scrolled past. Stored in two nullable columns, `articles.reading_anchor_block` / `reading_anchor_offset` (migration 0022).

- Restore scrolls to the anchored block (`anchorToScrollY`), and falls back to the ratio for legacy articles, when the block no longer exists (content re-parsed or AI-cleaned), or when there is no `.article-content` (PDF original view).
- For up to 3 s after restore, late layout (image loads, KaTeX) re-applies the same target until the user scrolls away or interacts.
- `reading_progress` stays: it still drives the progress bar, sorting, and the monotonic "furthest point reached" guard. The anchor is only accepted alongside `readingProgress` (422 otherwise), so the two cannot drift (#27).

## Rationale

1. **A block anchor is independent of layout above it.** Whatever height loads late before the anchored block, the target is recomputed from the block's live position.
2. **Cheap and coarse is enough.** A reading position is a viewport point, not a text selection. A block index plus a fraction needs no text matching; the Module 20 text-quote anchors (`highlight-anchoring.ts`) are built for exact ranges.
3. **The ratio fallback covers content changes.** If reformatting shifts the block indices, the restore is no worse than before this change.
4. **Storing image dimensions at ingestion was dropped.** It was the other fix considered in #27. With anchor restore, and scroll anchoring now in every engine (Safari since 27), it no longer fixed the restore, and probing images at save time was costly and best-effort.

## Consequences

- Two nullable columns on `articles`; existing rows restore by ratio until they are next saved.
- A content change that adds or removes blocks before the anchor makes the restore land on the wrong block (the index stays in range but points elsewhere). This is accepted: it is rare, and the user just scrolls.
- The position stays the furthest point reached, not the last one (tracked in `TECH_DEBT.md`); switching would need a separate last-position field.
- See [reader-view.md](../modules/reader-view.md) (reading progress) and [data-layer.md](../modules/data-layer.md) (`PATCH /api/articles/[id]`).
