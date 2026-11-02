/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ArticleProvider, useArticle } from '@/components/reader/article-context';
import { ArticleReader } from '@/components/reader/article-reader';
import { SidebarProvider } from '@/components/layout/sidebar-context';
import { ContextPanelProvider, useContextPanel } from '@/components/layout/context-panel-context';
import { ContextPanelPortal } from '@/components/layout/context-panel';
import { anchorToScrollY, computeReadingAnchor } from '@/lib/reading-anchor';
import { getScrollableHeight } from '@/lib/scroll-progress';
import type { Article } from '@/types';

const { mockBack } = vi.hoisted(() => ({ mockBack: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ back: mockBack }) }));

const mockFetch = vi.fn();

// Layout model: block i sits at document y = i * BLOCK_SPACING (+ layoutShift),
// each BLOCK_HEIGHT tall. Rects are derived from window.scrollY so they stay
// consistent with whatever scroll position the component sets.
const BLOCK_COUNT = 5;
const BLOCK_SPACING = 500;
const BLOCK_HEIGHT = 100;
let layoutShift = 0;
// Block getBoundingClientRect reads (layout reads in a real browser).
let rectReads = 0;

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
      rectReads++;
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
  mockBack.mockReset();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  layoutShift = 0;
  rectReads = 0;
  rafQueue = [];
  resizeCallbacks = [];
  // scrollHeight 3000 − innerHeight 1000 → scrollable 2000, so progress 0.5 → y 1000
  setViewport(3000, 1000);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  // Like a browser, clamp to the scrollable range (scrollHeight − innerHeight)
  vi.spyOn(window, 'scrollTo').mockImplementation(((opts: ScrollToOptions) => {
    setScrollY(Math.min(Math.max(opts.top ?? 0, 0), getScrollableHeight()));
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

  it('stops re-applying after a scroll away from the restore target (scrollbar drag)', () => {
    renderReader({ readingProgress: 0.5, readingAnchorBlock: 2, readingAnchorOffset: 0.4 });
    flushRaf();
    setScrollY(1500);
    fireEvent.scroll(window);
    layoutShift = 200;
    triggerResize();
    expect(scrollToCalls()).toEqual([1040]);
  });

  it('keeps re-applying after the scroll event caused by its own restore', () => {
    renderReader({ readingProgress: 0.5, readingAnchorBlock: 2, readingAnchorOffset: 0.4 });
    flushRaf();
    fireEvent.scroll(window);
    layoutShift = 200;
    triggerResize();
    expect(scrollToCalls().at(-1)).toBe(1240);
  });

  it('keeps re-applying after a scroll-anchoring adjustment by the browser', () => {
    renderReader({ readingProgress: 0.5, readingAnchorBlock: 2, readingAnchorOffset: 0.4 });
    flushRaf();
    // Chromium shifts scrollY with the content and fires scroll before ResizeObserver runs
    layoutShift = 200;
    setScrollY(1240);
    fireEvent.scroll(window);
    layoutShift = 300;
    triggerResize();
    expect(scrollToCalls().at(-1)).toBe(1340);
  });

  it('keeps re-applying when the browser clamps the restore target to the page end', () => {
    // block 4 top 2000 + 0.5 × 100 = 2050, beyond the 2000px scrollable range
    renderReader({ readingProgress: 0.99, readingAnchorBlock: 4, readingAnchorOffset: 0.5 });
    flushRaf();
    expect(window.scrollY).toBe(2000);
    fireEvent.scroll(window);
    // Content above loads and the page grows, so the anchor becomes reachable
    layoutShift = -100;
    triggerResize();
    expect(scrollToCalls().at(-1)).toBe(1950);
  });

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

  it('does not read block layout on scroll, only when a save is sent', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    renderReader({ readingProgress: 0, readingAnchorBlock: null, readingAnchorOffset: null });
    for (const y of [400, 800, 1040]) {
      setScrollY(y);
      fireEvent.scroll(window);
    }
    expect(rectReads).toBe(0);
    act(() => vi.advanceTimersByTime(5_000));
    expect(rectReads).toBeGreaterThan(0);
  });

  it('saves the anchor of the furthest point even after scrolling back up', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    renderReader({ readingProgress: 0, readingAnchorBlock: null, readingAnchorOffset: null });
    setScrollY(1040);
    fireEvent.scroll(window);
    setScrollY(200);
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

describe('ArticleReader Escape', () => {
  it('goes back on Escape', () => {
    renderReader({ readingProgress: 0, readingAnchorBlock: null, readingAnchorOffset: null });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('does not go back when an earlier handler already handled Escape (defaultPrevented)', () => {
    renderReader({ readingProgress: 0, readingAnchorBlock: null, readingAnchorOffset: null });
    // Like highlight-layer / the context panel: a capture-phase handler claims the key
    const claim = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener('keydown', claim, { capture: true });
    try {
      fireEvent.keyDown(window, { key: 'Escape' });
    } finally {
      window.removeEventListener('keydown', claim, { capture: true });
    }
    expect(mockBack).not.toHaveBeenCalled();
  });
});

describe('ArticleReader place-keeping across panel width changes', () => {
  function PanelHarness({ children }: { children: React.ReactNode }) {
    const { contentWrapperRef, toggle } = useContextPanel();
    return (
      <div ref={contentWrapperRef}>
        <button onClick={() => toggle()}>toggle panel</button>
        <ContextPanelPortal title="Details" tabs={[]} />
        {children}
      </div>
    );
  }

  function renderInShell(fields: Partial<Article>) {
    render(
      <SidebarProvider>
        <ContextPanelProvider>
          <PanelHarness>
            <ArticleProvider initialArticle={makeArticle(fields)}>
              <ArticleReader>
                <div className="article-content" data-testid="article-content">
                  {Array.from({ length: BLOCK_COUNT }, (_, i) => (
                    <p key={i}>Paragraph {i}</p>
                  ))}
                </div>
              </ArticleReader>
            </ArticleProvider>
          </PanelHarness>
        </ContextPanelProvider>
      </SidebarProvider>,
    );
    stubBlockRects();
  }

  function togglePanel() {
    fireEvent.click(screen.getByRole('button', { name: 'toggle panel' }));
  }

  function patchProgress(): number[] {
    return mockFetch.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
      .map(([, init]) => JSON.parse((init as RequestInit).body as string))
      .filter((body) => 'readingProgress' in body)
      .map((body) => body.readingProgress as number);
  }

  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  });

  it('re-applies the last known anchor while the layout reflows', () => {
    renderInShell({ readingProgress: 0, readingAnchorBlock: null, readingAnchorOffset: null });
    flushRaf();
    setScrollY(1040);
    fireEvent.scroll(window);
    flushRaf();

    togglePanel();
    // The narrower column pushes block 2 down 200px
    layoutShift = 200;
    triggerResize();
    expect(scrollToCalls().at(-1)).toBe(1240);
  });

  it('does not advance reading progress from scrolls during a panel transition', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    renderInShell({ readingProgress: 0, readingAnchorBlock: null, readingAnchorOffset: null });
    flushRaf();
    setScrollY(400);
    fireEvent.scroll(window);
    flushRaf();
    act(() => vi.advanceTimersByTime(5_000));
    expect(patchProgress()).toEqual([0.2]);

    togglePanel();
    // Reflow changes the scroll ratio without the reader reading anything
    setScrollY(1000);
    fireEvent.scroll(window);
    act(() => vi.advanceTimersByTime(5_000));
    expect(patchProgress()).toEqual([0.2]);
  });

  it('leaves a layout change during the mount restore window to the mount restore', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    renderInShell({ readingProgress: 0.5, readingAnchorBlock: 2, readingAnchorOffset: 0.4 });
    flushRaf();
    expect(window.scrollY).toBe(1040);
    // The restore's own scroll event: keeps the window open, updates the last known anchor
    fireEvent.scroll(window);
    flushRaf();

    // e.g. the sidebar hydrating open from localStorage right after mount
    togglePanel();
    // Progress keeps tracking: no panel transition pause was started
    setScrollY(1500);
    fireEvent.scroll(window);
    act(() => vi.advanceTimersByTime(5_000));
    expect(patchProgress()).toEqual([0.75]);
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

  it('anchors at a given scroll offset instead of the current one', () => {
    const container = content();
    setScrollY(0);
    expect(computeReadingAnchor(container, 1040)).toEqual({ block: 2, offset: 0.4 });
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
