import type { ReadingAnchor } from '@/types';

/** Block-level elements that structure reader content (shared with the TTS word highlighter). */
export const BLOCK_SELECTORS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, pre, td, th';

/**
 * Capture the reading position as a content anchor: the first block whose
 * bottom edge is below the viewport top, plus how far it is scrolled past.
 *
 * @param container - The `.article-content` element.
 * @param scrollY - Window scroll offset to anchor at (defaults to the current one).
 * @returns The anchor, or `null` if no block is at or below the viewport top.
 */
export function computeReadingAnchor(
  container: HTMLElement,
  scrollY: number = window.scrollY,
): ReadingAnchor | null {
  const blocks = container.querySelectorAll<HTMLElement>(BLOCK_SELECTORS);
  // Shift viewport-relative rects to where they would be when scrolled to `scrollY`
  const shift = window.scrollY - scrollY;
  for (const [block, el] of Array.from(blocks).entries()) {
    const rect = el.getBoundingClientRect();
    const top = rect.top + shift;
    if (top + rect.height <= 0) continue;
    const offset = rect.height > 0 ? Math.min(1, Math.max(0, -top / rect.height)) : 0;
    return { block, offset };
  }
  return null;
}

/**
 * Inverse of {@link computeReadingAnchor}: the window scroll offset that puts
 * the anchored point of the anchored block at the viewport top.
 *
 * @param container - The `.article-content` element.
 * @param anchor - A previously captured anchor.
 * @returns Scroll offset in pixels, or `null` if the block no longer exists.
 */
export function anchorToScrollY(container: HTMLElement, anchor: ReadingAnchor): number | null {
  const block = container.querySelectorAll<HTMLElement>(BLOCK_SELECTORS)[anchor.block];
  if (!block) return null;
  const rect = block.getBoundingClientRect();
  return window.scrollY + rect.top + anchor.offset * rect.height;
}
