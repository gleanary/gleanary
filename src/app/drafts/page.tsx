import { getDraftSummaries } from '@/lib/db-helpers';
import { TopBar } from '@/components/layout/top-bar';
import { DraftList } from '@/components/drafts/draft-list';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Drafts — Gleanary' };

export default function DraftsPage() {
  const initialDrafts = getDraftSummaries();

  return (
    <main className="px-4 pt-3 pb-6">
      <TopBar>
        <span className="text-foreground mr-1 flex-1 px-2 text-sm font-semibold">Drafts</span>
      </TopBar>
      <div className="mx-auto max-w-4xl py-6">
        <DraftList initialDrafts={initialDrafts} />
      </div>
    </main>
  );
}
