'use client';

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Archive,
  ArchiveRestore,
  Heart,
  ExternalLink,
  MoreHorizontal,
  Trash2,
  RotateCcw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { TopBar, TopBarButton } from '@/components/layout/top-bar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { patchArticle, deleteArticle } from '@/lib/article-api';
import { useArticleStatus } from '@/components/reader/article-status-context';
import { useArticle } from '@/components/reader/article-context';
import { ListenButton } from '@/components/reader/listen-button';
import type { ArticleStatus } from '@/types';

const FAVORITE_ACTIVE_CLASSES = 'fill-red-500 text-red-500';

const STATUS_LABELS: Record<ArticleStatus, string> = {
  inbox: 'Inbox',
  reading: 'Reading',
  archived: 'Archived',
  pending_review: 'Pending',
};

const STATUS_COLORS: Record<ArticleStatus, string> = {
  inbox: 'bg-tint-blue text-tint-blue-fg',
  reading: 'bg-tint-amber text-tint-amber-fg',
  archived: 'bg-tint-slate text-tint-slate-fg',
  pending_review: 'bg-tint-orange text-tint-orange-fg',
};

/**
 * Fixed toolbar at the top of the reader view.
 * Provides navigation, status management, and favorite toggle.
 */
export function ReaderToolbar({
  ttsEnabled = false,
  showOpenOriginal = true,
}: {
  ttsEnabled?: boolean;
  showOpenOriginal?: boolean;
}) {
  const router = useRouter();
  const { article, updateArticle, triggerProgressReset } = useArticle();
  const { status, isPending: isArchivePending, toggleArchive } = useArticleStatus();
  const [isFavorite, setIsFavorite] = useState(article.isFavorite ?? false);
  const [isPending, startTransition] = useTransition();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const handleToggleFavorite = useCallback(() => {
    startTransition(async () => {
      const newVal = !isFavorite;
      setIsFavorite(newVal);
      await patchArticle(article.id, { isFavorite: newVal });
    });
  }, [article.id, isFavorite]);

  const handleResetProgress = useCallback(() => {
    startTransition(async () => {
      const response = await patchArticle(article.id, { readingProgress: 0 });
      if (response.ok) {
        updateArticle({ readingProgress: 0 });
        triggerProgressReset();
      }
    });
  }, [article.id, updateArticle, triggerProgressReset]);

  const handleDelete = useCallback(() => {
    startTransition(async () => {
      await deleteArticle(article.id);
      router.push('/');
    });
  }, [article.id, router, startTransition]);

  return (
    <TopBar hideSidebarToggleOnMobile>
      <TopBarButton onClick={() => router.back()}>
        <ArrowLeft className="h-4 w-4" />
        <span className="hidden sm:inline">Back</span>
      </TopBarButton>

      <Badge variant="secondary" className={`text-xs ${STATUS_COLORS[status]}`}>
        {STATUS_LABELS[status]}
      </Badge>

      <div className="flex-1" />

      <TopBarButton
        onClick={() =>
          toggleArchive(() => {
            router.push('/');
            router.refresh();
          })
        }
        disabled={isPending || isArchivePending}
      >
        {status === 'archived' ? (
          <ArchiveRestore className="h-4 w-4" />
        ) : (
          <Archive className="h-4 w-4" />
        )}
        <span className="hidden sm:inline">{status === 'archived' ? 'Unarchive' : 'Archive'}</span>
      </TopBarButton>

      <TopBarButton onClick={handleToggleFavorite} disabled={isPending}>
        <Heart className={cn('h-4 w-4', isFavorite && FAVORITE_ACTIVE_CLASSES)} />
      </TopBarButton>

      {ttsEnabled && <ListenButton articleId={article.id} />}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <TopBarButton suppressHydrationWarning>
            <MoreHorizontal className="h-4 w-4" />
          </TopBarButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={handleResetProgress} disabled={isPending}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset reading progress
          </DropdownMenuItem>
          {showOpenOriginal && (
            <DropdownMenuItem asChild>
              <a
                href={
                  article.url.startsWith('upload://')
                    ? `/api/articles/${article.id}/original`
                    : article.url
                }
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                Open original
              </a>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem variant="destructive" onSelect={() => setIsDeleteDialogOpen(true)}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete document
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={isDeleteDialogOpen}
        onOpenChange={(open) => !isPending && setIsDeleteDialogOpen(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete document</DialogTitle>
            <DialogDescription>
              This will permanently delete this article and all its highlights. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsDeleteDialogOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isPending}>
              {isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TopBar>
  );
}
