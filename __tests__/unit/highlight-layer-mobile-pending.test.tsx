/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { HighlightLayer } from '@/components/reader/highlight-layer';
import type { Highlight } from '@/types';

vi.mock('@/lib/is-mobile', () => ({ isMobileDevice: true }));
vi.mock('@/lib/article-api', () => ({
  createHighlight: vi.fn(),
  deleteHighlight: vi.fn(),
  updateHighlight: vi.fn(() => Promise.resolve()),
}));

// positionData null → resolved by text search, so the mark lands on "Alpha beta".
const highlight: Highlight = {
  id: 1,
  articleId: 1,
  thesisId: null,
  externalId: null,
  text: 'Alpha beta',
  note: null,
  color: 'yellow',
  positionData: null,
  anchorStatus: 'anchored',
  createdAt: '2026-07-10T00:00:00.000Z',
  updatedAt: '2026-07-10T00:00:00.000Z',
  lastReviewed: null,
  reviewCount: null,
  reviewInterval: null,
};

/** The hidden span HighlightLayer appends to body to position the pending-selection popover. */
function pendingAnchorSpan(): Element | null {
  return document.body.querySelector(':scope > span[style*="position: absolute"]');
}

describe('HighlightLayer mobile pending selection', () => {
  beforeAll(() => {
    // Run the coalescing rAF synchronously; jsdom Ranges have no layout box.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 10, 10);
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    delete (Range.prototype as Partial<Range>).getBoundingClientRect;
    delete (Range.prototype as Partial<Range>).getClientRects;
  });

  it('clears the pending selection popover when a tap on a highlight enters edit mode', () => {
    render(
      <HighlightLayer articleId={1} initialHighlights={[highlight]}>
        <p data-testid="para">Alpha beta gamma. Delta epsilon zeta.</p>
      </HighlightLayer>,
    );
    const mark = screen.getByTestId('para').querySelector('mark[data-highlight-id="1"]');
    expect(mark).not.toBeNull();

    // Select "Delta epsilon" in the unhighlighted tail text node → pending confirm UI.
    const tail = screen.getByTestId('para').lastChild as Text;
    const range = document.createRange();
    const start = tail.data.indexOf('Delta');
    range.setStart(tail, start);
    range.setEnd(tail, start + 'Delta epsilon'.length);
    act(() => {
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(pendingAnchorSpan()).not.toBeNull();
    expect(screen.getAllByTestId('highlight-popover')).toHaveLength(1);

    // Tap the existing highlight → edit mode must drop the pending selection.
    act(() => {
      fireEvent.click(mark!);
    });

    expect(pendingAnchorSpan()).toBeNull();
    expect(screen.getAllByTestId('highlight-popover')).toHaveLength(1);
  });
});
