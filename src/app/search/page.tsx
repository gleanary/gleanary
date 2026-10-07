import { Suspense } from 'react';
import { SearchPageContent } from '@/components/search/search-page-content';
import { TopBar } from '@/components/layout/top-bar';

export const metadata = { title: 'Search — Gleanary' };

export default function SearchPage() {
  return (
    <main className="px-4 pt-3 pb-6">
      <TopBar>
        <span className="text-foreground mr-1 px-2 text-sm font-semibold">Search</span>
      </TopBar>
      <div className="mx-auto max-w-3xl py-4">
        <Suspense
          fallback={<div className="text-muted-foreground py-8 text-center text-sm">Loading…</div>}
        >
          <SearchPageContent />
        </Suspense>
      </div>
    </main>
  );
}
