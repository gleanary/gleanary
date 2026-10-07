'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { formatDate } from '@/lib/text-utils';
import { TEMPLATES } from '@/lib/content-templates';
import type { DraftListItem } from '@/lib/draft-api';

interface DraftCardProps {
  draft: DraftListItem;
  /** When true, renders the parent thesis title as a secondary link and uses programmatic navigation for the card (avoids nested anchors). */
  showThesis?: boolean;
  snippet?: string;
}

function DraftMeta({ draft }: { draft: DraftListItem }) {
  const templateName = TEMPLATES[draft.templateId].name;
  const lastEditedAt = draft.lastEditedAt ?? draft.createdAt;
  return (
    <div className="min-w-0">
      <p className="text-foreground truncate text-sm font-medium">{draft.title}</p>
      <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="secondary">{templateName}</Badge>
        <span>· {draft.status === 'published' ? 'Published' : 'Draft'}</span>
        <span>· Last edited {formatDate(lastEditedAt)}</span>
      </div>
    </div>
  );
}

function SnippetRow({ snippet }: { snippet?: string }) {
  if (!snippet) return null;
  return (
    // Safe: server-guaranteed escaped HTML containing only <mark> tags — see docs/modules/global-search.md §6.1
    <p
      className="text-muted-foreground mt-1.5 text-xs [&_mark]:rounded-sm [&_mark]:bg-[rgba(253,224,71,0.4)] [&_mark]:dark:bg-[rgba(253,224,71,0.25)]"
      dangerouslySetInnerHTML={{ __html: snippet }}
    />
  );
}

export function DraftCard({ draft, showThesis, snippet }: DraftCardProps) {
  const router = useRouter();

  if (showThesis) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => router.push(`/drafts/${draft.id}`)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            router.push(`/drafts/${draft.id}`);
          }
        }}
        className="bg-muted/30 border-border hover:bg-muted/50 block cursor-pointer rounded-md border p-3 transition-colors"
        data-testid={`draft-card-${draft.id}`}
      >
        <DraftMeta draft={draft} />
        <SnippetRow snippet={snippet} />
        <p className="text-muted-foreground mt-1.5 text-xs">
          <Link
            href={`/theses/${draft.thesisId}`}
            className="hover:text-foreground underline-offset-2 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {draft.thesisTitle}
          </Link>
        </p>
      </div>
    );
  }

  return (
    <Link
      href={`/drafts/${draft.id}`}
      prefetch={false}
      className="bg-muted/30 border-border hover:bg-muted/50 block rounded-md border p-3 transition-colors"
      data-testid={`draft-card-${draft.id}`}
    >
      <DraftMeta draft={draft} />
      <SnippetRow snippet={snippet} />
    </Link>
  );
}
