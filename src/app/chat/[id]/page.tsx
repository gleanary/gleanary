import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { db } from '@/db';
import { chatSessions, chatMessages } from '@/db/schema';
import { ChatConversation } from '@/components/chat/chat-conversation';
import { toChatMessageDisplay } from '@/lib/db-helpers';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, Number(id)))
    .get();
  return { title: session ? `${session.title} — Chat — Gleanary` : 'Chat — Gleanary' };
}

export default async function ChatSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sessionId = Number(id);

  if (isNaN(sessionId)) notFound();

  const session = db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).get();
  if (!session) notFound();

  const messages = db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(chatMessages.createdAt)
    .all();

  return (
    <ChatConversation
      session={{ id: session.id, title: session.title, scope: session.scope, model: session.model }}
      initialMessages={messages.map(toChatMessageDisplay)}
    />
  );
}
