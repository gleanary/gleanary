import { ChatConversation } from '@/components/chat/chat-conversation';

export const metadata = { title: 'New Chat — Gleanary' };

interface PageProps {
  searchParams: Promise<{ scope?: string; prefill?: string }>;
}

export default async function NewChatPage({ searchParams }: PageProps) {
  const { scope, prefill } = await searchParams;
  return (
    <ChatConversation
      session={null}
      initialMessages={[]}
      initialScope={scope}
      initialPrefill={prefill}
    />
  );
}
