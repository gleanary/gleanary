import { getDueHighlights } from '@/lib/spaced-repetition';
import { ReviewSession } from '@/components/review/review-session';
import { TopBar } from '@/components/layout/top-bar';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Daily Review — Gleanary' };

const DEFAULT_LIMIT = 15;

export default function ReviewPage() {
  const { highlights, totalDue } = getDueHighlights(DEFAULT_LIMIT);

  return (
    <main className="px-4 pt-3 pb-6">
      <TopBar>
        <span className="text-foreground mr-1 px-2 text-sm font-semibold">Daily Review</span>
      </TopBar>
      <div className="mx-auto max-w-4xl py-6">
        <ReviewSession initialHighlights={highlights} initialTotalDue={totalDue} />
      </div>
    </main>
  );
}
