'use client';

import Link from 'next/link';
import { MessageSquare, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { scopeDisplayLabel } from '@/components/chat/scope-selector';
import { formatRelativeTime } from '@/lib/text-utils';
import type { ChatSessionListItem } from '@/types';

/**
 * Renders a list of chat session cards.
 * @param props.sessions - Array of chat session summaries
 */
export function ChatSessionList({ sessions }: { sessions: ChatSessionListItem[] }) {
  const router = useRouter();

  async function handleDelete(e: React.MouseEvent, sessionId: number) {
    e.preventDefault();
    e.stopPropagation();
    const res = await fetch(`/api/chat/${sessionId}`, { method: 'DELETE' });
    if (res.ok) router.refresh();
  }

  return (
    <div className="space-y-2">
      {sessions.map((s) => (
        <Link
          key={s.id}
          href={`/chat/${s.id}`}
          className="bg-card hover:bg-accent/50 border-border group flex items-center gap-3 rounded-lg border p-4 transition-colors"
        >
          <MessageSquare size={18} className="text-muted-foreground shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{s.title}</span>
              {s.scope !== 'all' && (
                <Badge variant="secondary" className="shrink-0 text-[10px]">
                  {scopeDisplayLabel(s.scope)}
                </Badge>
              )}
            </div>
            <div className="text-muted-foreground mt-0.5 text-xs">
              {s.messageCount} messages
              {s.lastMessageAt && <> &middot; {formatRelativeTime(s.lastMessageAt)}</>}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => handleDelete(e, s.id)}
            className="text-muted-foreground hover:text-destructive shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-transparent dark:hover:bg-transparent"
            aria-label="Delete session"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </Link>
      ))}
    </div>
  );
}
