import Link from 'next/link';
import { Plus, MessageSquare } from 'lucide-react';
import { count, desc, inArray, max } from 'drizzle-orm';
import { db } from '@/db';
import { chatSessions, chatMessages } from '@/db/schema';
import { Button } from '@/components/ui/button';
import { TopBar, TopBarButton } from '@/components/layout/top-bar';
import { ChatSessionList } from '@/components/chat/chat-session-list';
import { KnowledgeHealthPanel } from '@/components/chat/knowledge-health-panel';
import type { ChatSessionListItem } from '@/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Chat — Gleanary' };

function getSessions(): ChatSessionListItem[] {
  const rows = db.select().from(chatSessions).orderBy(desc(chatSessions.updatedAt)).all();
  if (rows.length === 0) return [];

  const ids = rows.map((s) => s.id);
  const msgStats = ids.length
    ? db
        .select({
          sessionId: chatMessages.sessionId,
          count: count(),
          lastAt: max(chatMessages.createdAt),
        })
        .from(chatMessages)
        .where(inArray(chatMessages.sessionId, ids))
        .groupBy(chatMessages.sessionId)
        .all()
    : [];

  const statsMap = new Map(msgStats.map((r) => [r.sessionId, r]));

  return rows.map((s) => ({
    id: s.id,
    title: s.title,
    scope: s.scope,
    model: s.model,
    messageCount: statsMap.get(s.id)?.count ?? 0,
    lastMessageAt: statsMap.get(s.id)?.lastAt ?? null,
    createdAt: s.createdAt,
  }));
}

export default function ChatPage() {
  const sessions = getSessions();

  return (
    <main className="px-4 pt-3 pb-6">
      <TopBar>
        <span className="text-foreground mr-1 flex-1 px-2 text-sm font-semibold">Chat</span>
        <TopBarButton asChild>
          <Link href="/chat/new">
            <Plus size={14} />
            New chat
          </Link>
        </TopBarButton>
      </TopBar>
      <div className="mx-auto max-w-3xl py-6">
        <KnowledgeHealthPanel />
        {sessions.length === 0 ? (
          <div className="text-muted-foreground py-16 text-center">
            <MessageSquare size={48} className="mx-auto mb-4 opacity-30" />
            <p className="text-lg">No conversations yet</p>
            <p className="mt-2 text-sm">
              Chat with your knowledge base — ask questions across articles, highlights, and theses.
            </p>
            <Button className="mt-4" asChild>
              <Link href="/chat/new">
                <Plus size={14} className="mr-1" />
                Start a conversation
              </Link>
            </Button>
          </div>
        ) : (
          <ChatSessionList sessions={sessions} />
        )}
      </div>
    </main>
  );
}
