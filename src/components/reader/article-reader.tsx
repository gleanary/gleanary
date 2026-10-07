'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { patchArticle } from '@/lib/article-api';
import { getScrollableHeight, getScrollProgress, progressToScrollY } from '@/lib/scroll-progress';
import { useArticle } from '@/components/reader/article-context';

const PROGRESS_DEBOUNCE_MS = 5_000;

/** Returns scroll progress as a 0–1 float (rounded to 2 decimals), or null if page is not scrollable. */
function getRoundedScrollProgress(): number | null {
  const progress = getScrollProgress();
  return progress === null ? null : Math.round(progress * 100) / 100;
}

/**
 * Client wrapper for the reader view. Handles:
 * - Reading progress tracking (scroll → percentage → debounced PATCH)
 * - Auto-mark as "reading" when opened from inbox
 * - Keyboard shortcut: Escape to go back
 */
export function ArticleReader({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { article, progressResetKey } = useArticle();
  const lastSavedProgress = useRef(article.readingProgress ?? 0);
  const maxProgress = useRef(article.readingProgress ?? 0);
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

      // Only save if progress exceeds last saved value meaningfully (> 1%)
      if (maxProgress.current - lastSavedProgress.current < 0.01) return;

      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }

      debounceTimer.current = setTimeout(() => {
        lastSavedProgress.current = maxProgress.current;
        patchArticle(article.id, { readingProgress: maxProgress.current });
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
      }

      if (maxProgress.current - lastSavedProgress.current >= 0.01) {
        patchArticle(article.id, { readingProgress: maxProgress.current }, { keepalive: true });
      }
    };

    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, [article.id]);

  // Restore scroll position from saved reading progress
  useEffect(() => {
    const savedProgress = article.readingProgress ?? 0;
    if (savedProgress <= 0) return;

    const rafId = requestAnimationFrame(() => {
      const top = progressToScrollY(savedProgress, getScrollableHeight());
      if (top === null) return;
      window.scrollTo({ top, behavior: 'instant' });
    });

    return () => cancelAnimationFrame(rafId);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- run once on mount only

  // Scroll to top and reset tracking refs when the user explicitly resets progress.
  // Uses progressResetKey (incremented by the toolbar) so this only fires on real
  // user-initiated resets, not on initial mount when readingProgress happens to be 0.
  useEffect(() => {
    if (progressResetKey === 0) return;

    isResettingProgress.current = true;
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    lastSavedProgress.current = 0;
    maxProgress.current = 0;

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
