import { anchorToScrollY, computeReadingAnchor, getContentContainer } from '@/lib/reading-anchor';
import type { PanelAnchor } from '@/types';

/** The first PDF page (`[data-page]` sentinel set by `PdfViewer`) still visible at the viewport top. */
function capturePdfAnchor(): PanelAnchor | null {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-page]'))) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom <= 0) continue;
    const page = Number(el.dataset.page);
    if (!Number.isFinite(page)) return null;
    const offset = rect.height > 0 ? Math.min(1, Math.max(0, -rect.top / rect.height)) : 0;
    return { kind: 'pdf', page, offset, gap: Math.max(0, rect.top) };
  }
  return null;
}

/**
 * Capture the reading position at the viewport top so it can be kept while a side panel
 * changes the reader width. HTML content (`.article-content`) anchors to a block via
 * {@link computeReadingAnchor}; the PDF original view anchors to a page.
 *
 * @returns The anchor, or `null` at the very top of the page (nothing to keep) or when
 *   there is no reader content in the DOM.
 */
export function capturePanelAnchor(): PanelAnchor | null {
  if (window.scrollY <= 0) return null;
  const container = getContentContainer();
  if (container) {
    const anchor = computeReadingAnchor(container);
    if (!anchor) return null;
    // When the block starts below the viewport top (offset 0), keep that distance too
    const top = anchorToScrollY(container, anchor);
    const gap = top === null ? 0 : Math.max(0, top - window.scrollY);
    return { kind: 'html', ...anchor, gap };
  }
  return capturePdfAnchor();
}

/**
 * Inverse of {@link capturePanelAnchor}: the window scroll offset that puts the anchored
 * point back at the viewport top in the current layout.
 *
 * @param anchor - A previously captured anchor
 * @returns Scroll offset in pixels (unclamped), or `null` if the anchored element is gone
 */
export function panelAnchorToScrollY(anchor: PanelAnchor): number | null {
  if (anchor.kind === 'html') {
    const container = getContentContainer();
    const top = container ? anchorToScrollY(container, anchor) : null;
    return top === null ? null : top - anchor.gap;
  }
  const el = document.querySelector<HTMLElement>(`[data-page="${anchor.page}"]`);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return window.scrollY + rect.top + anchor.offset * rect.height - anchor.gap;
}
