import Link from 'next/link';
import { Highlighter, BookOpen, SquarePen } from 'lucide-react';
import { StatusBadge } from './status-track';
import { formatDate } from '@/lib/text-utils';
import type { ThesisListItem } from '@/types';

interface ThesisCardProps {
  thesis: ThesisListItem;
  snippet?: string;
}

/**
 * Card component for a single thesis in the list view.
 * Shows title, claim preview, status badge, and linked counts.
 * @param props - Thesis list item data
 */
export function ThesisCard({ thesis, snippet }: ThesisCardProps) {
  return (
    <Link
      href={`/theses/${thesis.id}`}
      className="bg-card border-border hover:border-primary/30 block rounded-lg border p-4 transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-foreground truncate font-medium">{thesis.title}</h3>
          {thesis.claim && (
            <p className="text-muted-foreground mt-1 line-clamp-2 text-sm">{thesis.claim}</p>
          )}
        </div>
        <StatusBadge status={thesis.status} />
      </div>

      {snippet && (
        // Safe: server-guaranteed escaped HTML containing only <mark> tags — see docs/modules/global-search.md §6.1
        <p
          className="text-muted-foreground mt-2 text-xs [&_mark]:rounded-sm [&_mark]:bg-[rgba(253,224,71,0.4)] [&_mark]:dark:bg-[rgba(253,224,71,0.25)]"
          dangerouslySetInnerHTML={{ __html: snippet }}
        />
      )}
      <div className="text-muted-foreground mt-3 flex items-center gap-4 text-xs">
        <span className="flex items-center gap-1">
          <Highlighter size={12} />
          {thesis.highlightCount} {thesis.highlightCount === 1 ? 'highlight' : 'highlights'}
        </span>
        <span className="flex items-center gap-1">
          <BookOpen size={12} />
          {thesis.researchCount} {thesis.researchCount === 1 ? 'research' : 'research entries'}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <SquarePen size={12} />
          {formatDate(thesis.updatedAt)}
        </span>
      </div>
    </Link>
  );
}
