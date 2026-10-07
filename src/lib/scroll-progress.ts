/**
 * Single source of truth for the reader's scroll-progress formula.
 *
 * The visible progress bar, the persisted `readingProgress`, and the
 * scroll-position restore must all agree on what "document height" and
 * "progress" mean — changing the definition here changes all three together.
 * Rounding is intentionally left to callers (the bar is unrounded, the
 * persisted value is rounded to 2 decimals).
 */

/**
 * Scrollable document height in pixels: full document height minus the viewport.
 *
 * @returns The scrollable distance; `<= 0` means the page is not scrollable.
 */
export function getScrollableHeight(): number {
  return document.documentElement.scrollHeight - window.innerHeight;
}

/**
 * Convert a scroll offset into reading progress.
 *
 * @param scrollY - Vertical scroll offset in pixels.
 * @param scrollableHeight - Scrollable distance (see {@link getScrollableHeight}).
 * @returns Progress clamped to 0–1, or `null` if the page is not scrollable.
 */
export function computeScrollProgress(scrollY: number, scrollableHeight: number): number | null {
  if (scrollableHeight <= 0) return null;
  return Math.min(1, Math.max(0, scrollY / scrollableHeight));
}

/**
 * Current window scroll progress.
 *
 * @returns Progress clamped to 0–1, or `null` if the page is not scrollable.
 */
export function getScrollProgress(): number | null {
  return computeScrollProgress(window.scrollY, getScrollableHeight());
}

/**
 * Inverse of {@link computeScrollProgress}: the scroll offset for a given progress.
 *
 * @param progress - Reading progress as a 0–1 ratio.
 * @param scrollableHeight - Scrollable distance (see {@link getScrollableHeight}).
 * @returns Scroll offset in pixels, or `null` if the page is not scrollable.
 */
export function progressToScrollY(progress: number, scrollableHeight: number): number | null {
  if (scrollableHeight <= 0) return null;
  return progress * scrollableHeight;
}
