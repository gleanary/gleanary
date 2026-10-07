'use client';

import { useRouter } from 'next/navigation';
import { Archive, ArchiveRestore } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useArticleStatus } from '@/components/reader/article-status-context';

/**
 * Inline archive/unarchive button rendered at the end of article content.
 * Toggles between archive and unarchive based on the article's current status.
 * Uses shared ArticleStatusContext so it stays in sync with the toolbar.
 */
export function ArchiveFooterButton() {
  const router = useRouter();
  const { status, isPending, toggleArchive } = useArticleStatus();

  const isArchived = status === 'archived';

  return (
    <div className="mt-12 flex flex-col items-center gap-3 py-8">
      <Button
        variant="outline"
        size="lg"
        data-testid="archive-footer-button"
        onClick={() =>
          toggleArchive(() => {
            router.push('/');
            router.refresh();
          })
        }
        disabled={isPending}
        className="gap-2 border-[rgb(var(--reader-text))]/15 text-[rgb(var(--reader-text))]/60 hover:text-[rgb(var(--reader-text))]/80"
      >
        {isArchived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
        {isPending
          ? isArchived
            ? 'Unarchiving…'
            : 'Archiving…'
          : isArchived
            ? 'Unarchive'
            : 'Archive'}
      </Button>
    </div>
  );
}
