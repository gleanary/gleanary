/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ArticleProvider, useArticle } from '@/components/reader/article-context';
import { ArticleReader } from '@/components/reader/article-reader';
import { anchorToScrollY, computeReadingAnchor } from '@/lib/reading-anchor';
import type { Article } from '@/types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ back: vi.fn() }) }));

const mockFetch = vi.fn();

// Layout model: block i sits at document y = i * BLOCK_SPACING (+ layoutShift),
// each BLOCK_HEIGHT tall. Rects are derived from window.scrollY so they stay
// consistent with whatever scroll position the component sets.
const BLOCK_COUNT = 5;
const BLOCK_SPACING = 500;
const BLOCK_HEIGHT = 100;
let layoutShift = 0;

// requestAnimationFrame queue, flushed manually for determinism.
let rafQueue: FrameRequestCallback[] = [];

// Captured ResizeObserver callbacks (jsdom has no ResizeObserver).
let resizeCallbacks: Array<() => void> = [];

function flushRaf() {
  const queue = rafQueue;
  rafQueue = [];
  act(() => queue.forEach((cb) => cb(0)));
}

function triggerResize() {
  act(() => resizeCallbacks.forEach((cb) => cb()));
}

function setViewport(scrollHeight: number, innerHeight: number) {
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true });
  setScrollY(0);
}

function setScrollY(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
}

function stubBlockRects() {
  document.querySelectorAll<HTMLElement>('.article-content p').forEach((el, i) => {
    el.getBoundingClientRect = () => {
      const top = i * BLOCK_SPACING + layoutShift - window.scrollY;
      return {
        top,
        bottom: top + BLOCK_HEIGHT,
        height: BLOCK_HEIGHT,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    };
  });
}

function ResetTrigger() {
  const { triggerProgressReset } = useArticle();
  return <button onClick={triggerProgressReset}>reset</button>;
}

function makeArticle(fields: Partial<Article>): Article {
  return { id: 1, status: 'reading', ...fields } as Article;
}

function renderReader(fields: Partial<Article>, { withContent = true } = {}) {
  render(
    <ArticleProvider initialArticle={makeArticle(fields)}>
      <ArticleReader>
        {withContent && (
          <div className="article-content" data-testid="article-content">
            {Array.from({ length: BLOCK_COUNT }, (_, i) => (
              <p key={i}>Paragraph {i}</p>
            ))}
          </div>
        )}
      </ArticleReader>
      <ResetTrigger />
    </ArticleProvider>,
  );
  stubBlockRects();
}

function scrollToCalls(): number[] {
  return vi
    .mocked(window.scrollTo)
    .mock.calls.map((args) => (args[0] as ScrollToOptions).top as number);
}

beforeAll(() => {
  // Client-side relative-URL fetch (patchArticle) — MSW cannot intercept it in Node.
  vi.stubGlobal('fetch', mockFetch);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  layoutShift = 0;
  rafQueue = [];
  resizeCallbacks = [];
  // scrollHeight 3000 − innerHeight 1000 → scrollable 2000, so progress 0.5 → y 1000
  setViewport(3000, 1000);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  vi.spyOn(window, 'scrollTo').mockImplementation(((opts: ScrollToOptions) => {
    setScrollY(opts.top ?? 0);
  }) as typeof window.scrollTo);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
        resizeCallbacks.push(cb);
      }
      observe() {}
      disconnect() {
        resizeCallbacks = resizeCallbacks.filter((c) => c !== this.cb);
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ArticleReader reading-position restore', () => {
  it('restores to the saved content anchor, not the height ratio', () => {
    renderReader({ readingProgress: 0.5, readingAnchorBlock: 2, readingAnchorOffset: 0.4 });
    flushRaf();
    // block 2 top 1000 + 0.4 × 100 → 1040 (ratio path would give 0.5 × 2000 = 1000)
    expect(scrollToCalls()).toEqual([1040]);
  });

  it('falls back to the ratio when no anchor was saved (legacy article)', () => {
    renderReader({ readingProgress: 0.5, readingAnchorBlock: null, readingAnchorOffset: null });
    flushRaf();
    expect(scrollToCalls()).toEqual([1000]);
  });

  it('falls back to the ratio when the anchor block no longer exists', () => {
    renderReader({ readingProgress: 0.5, readingAnchorBlock: 10, readingAnchorOffset: 0.4 });
    flushRaf();
    expect(scrollToCalls()).toEqual([1000]);
  });

  it('falls back to the ratio when there is no .article-content (PDF original view)', () => {
    renderReader(
      { readingProgress: 0.5, readingAnchorBlock: 2, readingAnchorOffset: 0.4 },
      { withContent: false },
    );
    flushRaf();
    expect(scrollToCalls()).toEqual([1000]);
  });

  it('does not restore when reading progress is 0', () => {
    renderReader({ readingProgress: 0, readingAnchorBlock: null, readingAnchorOffset: null });
    flushRaf();
    expect(scrollToCalls()).toEqual([]);
  });

  it('re-applies the anchor when late layout shifts the content', () => {
    renderReader({ readingProgress: 0.5, readingAnchorBlock: 2, readingAnchorOffset: 0.4 });
    flushRaf();
    // A hero image above the anchor finishes loading and pushes content down 200px
    layoutShift = 200;
    triggerResize();
    expect(scrollToCalls().at(-1)).toBe(1240);
  });

  it.each(['wheel', 'touchstart', 'keydown', 'pointerdown'])(
    'stops re-applying after user interaction (%s)',
    (type) => {
      renderReader({ readingProgress: 0.5, readingAnchorBlock: 2, readingAnchorOffset: 0.4 });
      flushRaf();
      fireEvent(window, new Event(type));
      layoutShift = 200;
      triggerResize();
      expect(scrollToCalls()).toEqual([1040]);
    },
  );

  it('stops re-applying once the restore window expires', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    renderReader({ readingProgress: 0.5, readingAnchorBlock: 2, readingAnchorOffset: 0.4 });
    flushRaf();
    act(() => vi.advanceTimersByTime(3_000));
    layoutShift = 200;
    triggerResize();
    expect(scrollToCalls()).toEqual([1040]);
  });

  it('cancels the restore window when progress is reset', () => {
    renderReader({ readingProgress: 0.5, readingAnchorBlock: 2, readingAnchorOffset: 0.4 });
    flushRaf();
    fireEvent.click(screen.getByRole('button', { name: 'reset' }));
    flushRaf();
    layoutShift = 200;
    triggerResize();
    expect(scrollToCalls()).toEqual([1040, 0]);
  });
});

describe('ArticleReader reading-position save', () => {
  function patchBodies(): Array<Record<string, unknown>> {
    return mockFetch.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
      .map(([, init]) => JSON.parse((init as RequestInit).body as string));
  }

  it('sends the content anchor with the debounced progress save', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    renderReader({ readingProgress: 0, readingAnchorBlock: null, readingAnchorOffset: null });
    // scrollY 1040 → block 2 (top 1000) is the first visible block, 40% scrolled past
    setScrollY(1040);
    fireEvent.scroll(window);
    act(() => vi.advanceTimersByTime(5_000));
    expect(patchBodies()).toEqual([
      { readingProgress: 0.52, readingAnchorBlock: 2, readingAnchorOffset: 0.4 },
    ]);
  });

  it('sends the content anchor with the keepalive save on page unload', () => {
    renderReader({ readingProgress: 0, readingAnchorBlock: null, readingAnchorOffset: null });
    setScrollY(1040);
    fireEvent(window, new Event('beforeunload'));
    expect(patchBodies()).toEqual([
      { readingProgress: 0.52, readingAnchorBlock: 2, readingAnchorOffset: 0.4 },
    ]);
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.keepalive).toBe(true);
  });
});

describe('computeReadingAnchor / anchorToScrollY', () => {
  function content(): HTMLElement {
    renderReader({ readingProgress: 0, readingAnchorBlock: null, readingAnchorOffset: null });
    return screen.getByTestId('article-content');
  }

  it('anchors to the first block still visible at the viewport top', () => {
    const container = content();
    setScrollY(1040);
    expect(computeReadingAnchor(container)).toEqual({ block: 2, offset: 0.4 });
  });

  it('uses offset 0 when the first visible block starts below the viewport top', () => {
    const container = content();
    // Block 0 bottom (100) <= scrollY → skipped; block 1 top 500 − 300 = 200 > 0
    setScrollY(300);
    expect(computeReadingAnchor(container)).toEqual({ block: 1, offset: 0 });
  });

  it('returns null when every block is above the viewport top', () => {
    const container = content();
    setScrollY(5000);
    expect(computeReadingAnchor(container)).toBeNull();
  });

  it('returns null when the container has no blocks', () => {
    const empty = document.createElement('div');
    expect(computeReadingAnchor(empty)).toBeNull();
  });

  it('converts an anchor back to a scroll offset independent of the current scroll', () => {
    const container = content();
    setScrollY(700);
    expect(anchorToScrollY(container, { block: 2, offset: 0.4 })).toBe(1040);
  });

  it('round-trips a captured anchor to the same scroll offset', () => {
    const container = content();
    setScrollY(1575);
    const anchor = computeReadingAnchor(container);
    expect(anchor).not.toBeNull();
    setScrollY(0);
    expect(anchorToScrollY(container, anchor!)).toBe(1575);
  });

  it('returns null when the anchored block no longer exists', () => {
    const container = content();
    expect(anchorToScrollY(container, { block: BLOCK_COUNT, offset: 0 })).toBeNull();
  });
});
