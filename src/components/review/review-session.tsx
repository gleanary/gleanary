'use client';

import { useState, useCallback, useTransition } from 'react';
import { ReviewCard } from './review-card';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import type { HighlightWithContext, ReviewAction } from '@/types';

interface ReviewSessionProps {
  initialHighlights: HighlightWithContext[];
  initialTotalDue: number;
}

/**
 * Client component managing the review session state.
 * Displays cards one at a time and tracks progress.
 * @param initialHighlights - Due highlights fetched server-side
 * @param initialTotalDue - Total number of due highlights
 */
export function ReviewSession({ initialHighlights, initialTotalDue }: ReviewSessionProps) {
  const [queue, setQueue] = useState(initialHighlights);
  const [reviewed, setReviewed] = useState(0);
  const [totalDue] = useState(initialTotalDue);
  const [isPending, startTransition] = useTransition();

  const sessionSize = initialHighlights.length;
  const current = queue[0];
  const isComplete = queue.length === 0;

  const handleAction = useCallback(
    (action: ReviewAction) => {
      if (!current) return;

      startTransition(async () => {
        const res = await fetch('/api/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ highlightId: current.id, action }),
        });

        if (res.ok) {
          setQueue((prev) => prev.slice(1));
          setReviewed((prev) => prev + 1);
        }
      });
    },
    [current],
  );

  if (initialHighlights.length === 0) {
    return (
      <div className="py-16 text-center">
        <p className="text-muted-foreground text-lg">All caught up!</p>
        <p className="text-muted-foreground/60 mt-2 text-sm">
          No highlights due for review. Check back tomorrow.
        </p>
        <Link
          href="/"
          className="text-muted-foreground hover:text-foreground mt-4 inline-block text-sm"
        >
          Back to inbox
        </Link>
      </div>
    );
  }

  if (isComplete) {
    return (
      <div data-testid="session-complete" className="py-16 text-center">
        <p className="text-foreground text-lg font-medium">Session complete!</p>
        <p className="text-muted-foreground mt-2 text-sm">
          You reviewed {reviewed} highlight{reviewed !== 1 ? 's' : ''}.
          {totalDue > sessionSize && <> {totalDue - sessionSize} more due — reload to continue.</>}
        </p>
        <div className="mt-4 flex justify-center gap-3">
          <Link href="/" className="text-muted-foreground hover:text-foreground text-sm">
            Back to inbox
          </Link>
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
            Review more
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div data-testid="review-progress" className="text-muted-foreground text-center text-sm">
        {reviewed + 1} / {sessionSize}
        {totalDue > sessionSize && (
          <span className="text-muted-foreground/60 ml-2">({totalDue} total due)</span>
        )}
      </div>

      <ReviewCard
        key={current!.id}
        highlight={current!}
        onAction={handleAction}
        disabled={isPending}
      />

      <div className="mx-auto max-w-2xl">
        <div className="bg-muted h-1 overflow-hidden rounded-full">
          <div
            className="bg-primary h-full transition-all duration-300"
            style={{ width: `${(reviewed / sessionSize) * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
