'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getScrollProgress } from '@/lib/scroll-progress';
import { useArticle } from '@/components/reader/article-context';

/**
 * Thin horizontal progress bar fixed at the very top of the viewport.
 * Shows scroll progress through the article content area (0–100%).
 * Progress is monotonic — it only increases, never decreases when
 * the user scrolls back up.
 */
export function ReadingProgressBar() {
  const { article, progressResetKey } = useArticle();
  const initialProgress = article.readingProgress ?? 0;
  const [lastSeenResetKey, setLastSeenResetKey] = useState(0);
  const [progress, setProgress] = useState(initialProgress);
  const maxProgress = useRef(initialProgress);

  // Derived state: detect a user-triggered reset without a useEffect+setState cascade.
  // React's recommended pattern for syncing state with a changing prop/context value.
  if (progressResetKey !== lastSeenResetKey && progressResetKey > 0) {
    setLastSeenResetKey(progressResetKey);
    setProgress(0);
  }

  // Zero the maxProgress ref after each reset commit, before the browser repaints,
  // so the scroll handler cannot re-advance progress between commit and repaint.
  useLayoutEffect(() => {
    if (lastSeenResetKey > 0) {
      maxProgress.current = 0;
    }
  }, [lastSeenResetKey]);

  useEffect(() => {
    const onScroll = () => {
      const current = getScrollProgress();
      if (current === null) return;
      if (current > maxProgress.current) {
        maxProgress.current = current;
        setProgress(current);
      }
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div
      role="progressbar"
      aria-label="Reading progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      className="fixed top-0 left-0 z-50 h-[3px] w-full"
    >
      <div
        className="h-full bg-blue-400 transition-[width] duration-150 ease-out dark:bg-blue-500"
        style={{ width: `${progress * 100}%` }}
      />
    </div>
  );
}
