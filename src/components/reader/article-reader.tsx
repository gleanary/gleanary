'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { patchArticle } from '@/lib/article-api';
import { getScrollableHeight, getScrollProgress, progressToScrollY } from '@/lib/scroll-progress';
import { anchorToScrollY, computeReadingAnchor } from '@/lib/reading-anchor';
import { useArticle } from '@/components/reader/article-context';
import type { ReadingAnchor } from '@/types';

const PROGRESS_DEBOUNCE_MS = 5_000;
/** How long after mount late layout (images, KaTeX) may re-apply the restored position. */
const RESTORE_WINDOW_MS = 3_000;
/** User input that hands scrolling back to the reader, ending the restore window. */
const RESTORE_CANCEL_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

function getContentContainer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.article-content');
}

/** Current content anchor, or null when there is no `.article-content` (e.g. PDF original view). */
function captureReadingAnchor(): ReadingAnchor | null {
  const container = getContentContainer();
  return container ? computeReadingAnchor(container) : null;
}

/** PATCH body for a progress save: the ratio plus the content anchor captured with it. */
function progressUpdate(progress: number, anchor: ReadingAnchor | null) {
  return {
    readingProgress: progress,
    readingAnchorBlock: anchor?.block ?? null,
    readingAnchorOffset: anchor?.offset ?? null,
  };
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
 * - Auto-mark as "reading" when opened from inbox
 * - Keyboard shortcut: Escape to go back
 */
export function ArticleReader({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { article, progressResetKey } = useArticle();
  const lastSavedProgress = useRef(article.readingProgress ?? 0);
  const maxProgress = useRef(article.readingProgress ?? 0);
  // Content anchor captured at the moment maxProgress last advanced
  const maxAnchor = useRef<ReadingAnchor | null>(null);
  // Ends the post-restore re-apply window (set while it is active)
  const stopRestore = useRef<(() => void) | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isResettingProgress = useRef(false);

  // Auto-mark as "reading" if status is "inbox"
  useEffect(() => {
    if (article.status === 'inbox') {
      patchArticle(article.id, { status: 'reading' });
    }
  }, [article.id, article.status]);

  // Scroll progress tracking (monotonic — only increases)
  useEffect(() => {
    const handleScroll = () => {
      if (isResettingProgress.current) return;

      const progress = getRoundedScrollProgress();
      if (progress === null) return;

      // Only track forward progress
      if (progress <= maxProgress.current) return;
      maxProgress.current = progress;
      maxAnchor.current = captureReadingAnchor();

      // Only save if progress exceeds last saved value meaningfully (> 1%)
      if (maxProgress.current - lastSavedProgress.current < 0.01) return;

      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }

      debounceTimer.current = setTimeout(() => {
        lastSavedProgress.current = maxProgress.current;
        patchArticle(article.id, progressUpdate(maxProgress.current, maxAnchor.current));
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
        maxAnchor.current = captureReadingAnchor();
      }

      if (maxProgress.current - lastSavedProgress.current >= 0.01) {
        patchArticle(article.id, progressUpdate(maxProgress.current, maxAnchor.current), {
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

    const restore = () => {
      const container = getContentContainer();
      const anchorTop = savedAnchor && container ? anchorToScrollY(container, savedAnchor) : null;
      const top = anchorTop ?? progressToScrollY(savedProgress, getScrollableHeight());
      if (top === null) return;
      window.scrollTo({ top, behavior: 'instant' });
    };

    // Images without dimensions and async KaTeX can resize the content after the first
    // restore; browsers without scroll anchoring (Safari) would then drift. Re-apply on
    // resize until the user takes over or the window expires.
    let observer: ResizeObserver | null = null;
    let windowTimer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      observer?.disconnect();
      if (windowTimer) clearTimeout(windowTimer);
      RESTORE_CANCEL_EVENTS.forEach((type) => window.removeEventListener(type, stop));
      stopRestore.current = null;
    };

    const rafId = requestAnimationFrame(() => {
      restore();
      if (typeof ResizeObserver === 'undefined') return;
      observer = new ResizeObserver(restore);
      const container = getContentContainer();
      if (container) observer.observe(container);
      observer.observe(document.documentElement);
      windowTimer = setTimeout(stop, RESTORE_WINDOW_MS);
      RESTORE_CANCEL_EVENTS.forEach((type) =>
        window.addEventListener(type, stop, { passive: true }),
      );
      stopRestore.current = stop;
    });

    return () => {
      cancelAnimationFrame(rafId);
      stop();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- run once on mount only

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
    maxAnchor.current = null;

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
      if (e.key === 'Escape') {
        router.back();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [router]);

  return <article className="mx-auto max-w-[680px] px-4 py-8 sm:px-6 md:py-12">{children}</article>;
}
