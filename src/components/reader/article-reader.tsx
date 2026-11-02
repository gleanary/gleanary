'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { patchArticle } from '@/lib/article-api';
import { getScrollableHeight, getScrollProgress, progressToScrollY } from '@/lib/scroll-progress';
import { anchorToScrollY, computeReadingAnchor, getContentContainer } from '@/lib/reading-anchor';
import { capturePanelAnchor, panelAnchorToScrollY } from '@/lib/panel-anchor';
import { useArticle } from '@/components/reader/article-context';
import { useOptionalTTS } from '@/components/reader/tts-provider';
import { useOptionalContextPanel } from '@/components/layout/context-panel-context';
import type { PanelAnchor, ReadingAnchor } from '@/types';

const PROGRESS_DEBOUNCE_MS = 5_000;
/** How long after mount late layout (images, KaTeX) may re-apply the restored position. */
const RESTORE_WINDOW_MS = 3_000;
/**
 * User input that hands scrolling back to the reader, ending the restore window. Scrolls
 * also end it (see `onScroll`); these catch input before, or without, a scroll.
 */
const RESTORE_CANCEL_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
/** A panel restore ends once the slide is over and layout has been quiet this long. */
const PANEL_RESTORE_QUIET_MS = 300;
/** Hard cap on a panel restore (e.g. when `transitionend` never fires). */
const PANEL_RESTORE_MAX_MS = 1_500;
/** Trailing programmatic scroll events after a panel restore stops are still ignored. */
const PANEL_TRANSITION_SETTLE_MS = 200;

/**
 * Content anchor at the given scroll offset, or null when there is no `.article-content`
 * (e.g. PDF original view). Reads layout, so only call it when a save is about to be sent.
 */
function captureReadingAnchor(scrollY: number): ReadingAnchor | null {
  const container = getContentContainer();
  return container ? computeReadingAnchor(container, scrollY) : null;
}

/**
 * PATCH body for a progress save: the ratio plus the content anchor at the scroll
 * offset where it was reached. Computing the anchor from that offset now assumes the
 * layout above it has not shifted since, which holds within one debounce interval.
 */
function progressUpdate(progress: number, scrollY: number) {
  const anchor = captureReadingAnchor(scrollY);
  return {
    readingProgress: progress,
    readingAnchorBlock: anchor?.block ?? null,
    readingAnchorOffset: anchor?.offset ?? null,
  };
}

/** Clamps a scroll offset to the scrollable range, like the browser clamps scrollTo. */
function clampScrollY(top: number): number {
  return Math.min(Math.max(top, 0), getScrollableHeight());
}

/** Returns scroll progress as a 0–1 float (rounded to 2 decimals), or null if page is not scrollable. */
function getRoundedScrollProgress(): number | null {
  const progress = getScrollProgress();
  return progress === null ? null : Math.round(progress * 100) / 100;
}

/**
 * Client wrapper for the reader view. Handles:
 * - Reading progress tracking (scroll → percentage + content anchor → debounced PATCH)
 * - Scroll restore to the saved content anchor (ratio fallback), re-applied on late layout
 * - Keeping the place when a side panel (context panel, sidebar) changes the column width
 * - Auto-mark as "reading" when opened from inbox
 * - Keyboard shortcut: Escape to go back
 */
export function ArticleReader({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { article, progressResetKey } = useArticle();
  const lastSavedProgress = useRef(article.readingProgress ?? 0);
  const maxProgress = useRef(article.readingProgress ?? 0);
  // Scroll offset at the moment maxProgress last advanced; the anchor is computed from it at save time
  const maxScrollY = useRef(0);
  // Ends the post-restore re-apply window (set while it is active)
  const stopRestore = useRef<(() => void) | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isResettingProgress = useRef(false);

  // Place-keeping across side-panel width changes (null outside the app shell)
  const contextPanel = useOptionalContextPanel();
  const layoutKey = contextPanel?.layoutKey ?? null;
  const contentWrapperRef = contextPanel?.contentWrapperRef;
  const tts = useOptionalTTS();
  const isTTSPlaying = useRef(false);
  // Position at the viewport top, kept current by a throttled scroll listener
  const lastAnchor = useRef<PanelAnchor | null>(null);
  // Set while a panel transition reflows the page: progress and anchor tracking pause
  const isPanelTransitioning = useRef(false);
  const stopPanelRestore = useRef<(() => void) | null>(null);
  const panelSettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevLayoutKey = useRef(layoutKey);

  // Auto-mark as "reading" if status is "inbox". Conditional on the server still seeing
  // "inbox" so a late request never downgrades a status set meanwhile (e.g. archived).
  useEffect(() => {
    if (article.status === 'inbox') {
      patchArticle(article.id, { status: 'reading', ifStatus: 'inbox' });
    }
  }, [article.id, article.status]);

  // Scroll progress tracking (monotonic — only increases)
  useEffect(() => {
    const handleScroll = () => {
      // A panel transition reflows the page and moves the scroll ratio without reading
      if (isResettingProgress.current || isPanelTransitioning.current) return;

      const progress = getRoundedScrollProgress();
      if (progress === null) return;

      // Only track forward progress
      if (progress <= maxProgress.current) return;
      maxProgress.current = progress;
      maxScrollY.current = window.scrollY;

      // Only save if progress exceeds last saved value meaningfully (> 1%)
      if (maxProgress.current - lastSavedProgress.current < 0.01) return;

      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }

      debounceTimer.current = setTimeout(() => {
        lastSavedProgress.current = maxProgress.current;
        patchArticle(article.id, progressUpdate(maxProgress.current, maxScrollY.current));
      }, PROGRESS_DEBOUNCE_MS);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [article.id]);

  // Save progress on page unload (only if it exceeds last saved value)
  useEffect(() => {
    const handleUnload = () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }

      const progress = getRoundedScrollProgress();
      if (progress !== null && progress > maxProgress.current) {
        maxProgress.current = progress;
        maxScrollY.current = window.scrollY;
      }

      if (maxProgress.current - lastSavedProgress.current >= 0.01) {
        patchArticle(article.id, progressUpdate(maxProgress.current, maxScrollY.current), {
          keepalive: true,
        });
      }
    };

    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, [article.id]);

  // Restore scroll position: to the saved content anchor when there is one (robust to
  // layout that differs from save time), else to the saved progress ratio.
  useEffect(() => {
    const savedProgress = article.readingProgress ?? 0;
    if (savedProgress <= 0) return;
    const savedAnchor: ReadingAnchor | null =
      article.readingAnchorBlock != null
        ? { block: article.readingAnchorBlock, offset: article.readingAnchorOffset ?? 0 }
        : null;

    // Scroll offset of the saved position in the current layout, clamped to the page end
    // like the browser clamps scrollTo
    const targetY = (): number | null => {
      const container = getContentContainer();
      const anchorTop = savedAnchor && container ? anchorToScrollY(container, savedAnchor) : null;
      const top = anchorTop ?? progressToScrollY(savedProgress, getScrollableHeight());
      return top === null ? null : clampScrollY(top);
    };
    const restore = () => {
      const top = targetY();
      if (top !== null) window.scrollTo({ top, behavior: 'instant' });
    };

    // Images without dimensions and async KaTeX can resize the content after the first
    // restore; browsers without scroll anchoring (Safari) would then drift. Re-apply on
    // resize until the user takes over or the window expires.
    let observer: ResizeObserver | null = null;
    let windowTimer: ReturnType<typeof setTimeout> | null = null;
    // A scroll that leaves the saved position (scrollbar drag, hash navigation, TTS
    // auto-scroll) also hands over. Comparing against the current target rather than the
    // last restore lets the browser's own scroll anchoring and end-of-page clamping through.
    const onScroll = () => {
      const top = targetY();
      if (top === null || Math.abs(window.scrollY - top) > 1) stop();
    };
    const stop = () => {
      observer?.disconnect();
      if (windowTimer) clearTimeout(windowTimer);
      RESTORE_CANCEL_EVENTS.forEach((type) => window.removeEventListener(type, stop));
      window.removeEventListener('scroll', onScroll);
      stopRestore.current = null;
    };

    const rafId = requestAnimationFrame(() => {
      restore();
      if (typeof ResizeObserver === 'undefined') {
        stopRestore.current = null;
        return;
      }
      observer = new ResizeObserver(restore);
      const container = getContentContainer();
      if (container) observer.observe(container);
      observer.observe(document.documentElement);
      windowTimer = setTimeout(stop, RESTORE_WINDOW_MS);
      RESTORE_CANCEL_EVENTS.forEach((type) =>
        window.addEventListener(type, stop, { passive: true }),
      );
      window.addEventListener('scroll', onScroll, { passive: true });
      stopRestore.current = stop;
    });
    // The window is active from now on (a sidebar hydrating open before the first frame
    // must be left to this restore, see the layout-key effect); stopping before the
    // first frame cancels it.
    stopRestore.current = () => {
      cancelAnimationFrame(rafId);
      stop();
    };

    return () => {
      cancelAnimationFrame(rafId);
      stop();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- run once on mount only

  // Last known anchor: captured on scroll (once per frame), seeded once after mount.
  // Frozen during a panel transition so reflow scrolls never overwrite it.
  const hasContextPanel = layoutKey !== null;
  useEffect(() => {
    if (!hasContextPanel) return;
    let rafId: number | null = null;
    const capture = () => {
      rafId = null;
      if (!isPanelTransitioning.current) lastAnchor.current = capturePanelAnchor();
    };
    const onScroll = () => {
      if (rafId === null) rafId = requestAnimationFrame(capture);
    };
    rafId = requestAnimationFrame(capture);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [hasContextPanel]);

  useLayoutEffect(() => {
    isTTSPlaying.current = tts?.status === 'playing';
  });

  // A side panel opened or closed: the column width changes and the text reflows. Keep
  // the last known anchor at the viewport top until the slide is over and layout is quiet
  // (PDF pages re-render after a debounced width update, well after transitionend).
  useLayoutEffect(() => {
    if (prevLayoutKey.current === layoutKey) return;
    prevLayoutKey.current = layoutKey;
    // The mount restore owns the position during its window (its observer handles the reflow)
    if (stopRestore.current) return;
    // TTS auto-scroll owns the position while playing
    if (isTTSPlaying.current) return;
    const anchor = lastAnchor.current;
    if (!anchor) return;

    stopPanelRestore.current?.();
    if (panelSettleTimer.current) clearTimeout(panelSettleTimer.current);
    isPanelTransitioning.current = true;

    const wrapper = contentWrapperRef?.current ?? null;
    let transitionEnded = false;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    const restore = () => {
      const top = panelAnchorToScrollY(anchor);
      if (top !== null) window.scrollTo({ top: clampScrollY(top), behavior: 'instant' });
    };
    const armQuietTimer = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        if (transitionEnded) stop();
      }, PANEL_RESTORE_QUIET_MS);
    };
    const onResize = () => {
      restore();
      armQuietTimer();
    };
    const onTransitionEnd = (e: TransitionEvent) => {
      if (e.target !== wrapper) return;
      transitionEnded = true;
      restore();
      armQuietTimer();
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize);
    const container = getContentContainer();
    if (container) observer?.observe(container);
    observer?.observe(document.documentElement);
    wrapper?.addEventListener('transitionend', onTransitionEnd);
    const capTimer = setTimeout(stop, PANEL_RESTORE_MAX_MS);
    RESTORE_CANCEL_EVENTS.forEach((type) => window.addEventListener(type, stop, { passive: true }));

    function stop() {
      observer?.disconnect();
      wrapper?.removeEventListener('transitionend', onTransitionEnd);
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(capTimer);
      RESTORE_CANCEL_EVENTS.forEach((type) => window.removeEventListener(type, stop));
      stopPanelRestore.current = null;
      panelSettleTimer.current = setTimeout(() => {
        isPanelTransitioning.current = false;
      }, PANEL_TRANSITION_SETTLE_MS);
    }
    stopPanelRestore.current = stop;
  }, [layoutKey, contentWrapperRef]);

  useEffect(
    () => () => {
      stopPanelRestore.current?.();
      if (panelSettleTimer.current) clearTimeout(panelSettleTimer.current);
    },
    [],
  );

  // Scroll to top and reset tracking refs when the user explicitly resets progress.
  // Uses progressResetKey (incremented by the toolbar) so this only fires on real
  // user-initiated resets, not on initial mount when readingProgress happens to be 0.
  useEffect(() => {
    if (progressResetKey === 0) return;

    isResettingProgress.current = true;
    stopRestore.current?.();
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    lastSavedProgress.current = 0;
    maxProgress.current = 0;
    maxScrollY.current = 0;

    const rafId = requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: 'instant' });
      // Allow scroll event from scrollTo to settle before re-enabling tracking
      setTimeout(() => {
        isResettingProgress.current = false;
      }, 200);
    });

    return () => {
      cancelAnimationFrame(rafId);
      isResettingProgress.current = false;
    };
  }, [progressResetKey]);

  // Keyboard: Escape to go back
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Already handled earlier: closing the context panel, exiting highlight edit mode
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') {
        router.back();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [router]);

  return <article className="mx-auto max-w-[680px] px-4 py-8 sm:px-6 md:py-12">{children}</article>;
}
