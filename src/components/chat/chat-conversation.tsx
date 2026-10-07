'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { HamburgerButton } from '@/components/layout/hamburger-button';
import { ChatMessage } from '@/components/chat/chat-message';
import { ChatInput } from '@/components/chat/chat-input';
import { ScopeSelector, scopeDisplayLabel } from '@/components/chat/scope-selector';
import { DEFAULT_CHAT_MODEL } from '@/lib/models';
import type { ChatMessageDisplay } from '@/types';

interface SessionInfo {
  id: number;
  title: string;
  scope: string;
  model: string;
}

interface Props {
  /** null for new chat (not yet created) */
  session: SessionInfo | null;
  initialMessages: ChatMessageDisplay[];
  /** Scope to use when creating a new session (from URL params) */
  initialScope?: string;
  /** Pre-filled message text (from URL params) */
  initialPrefill?: string;
}

/**
 * Main chat conversation component. Handles message sending, SSE streaming,
 * and rendering the full conversation.
 */
export function ChatConversation({
  session: initialSession,
  initialMessages,
  initialScope,
  initialPrefill,
}: Props) {
  const [session, setSession] = useState<SessionInfo | null>(initialSession);
  const [model, setModel] = useState<string>(initialSession?.model ?? DEFAULT_CHAT_MODEL);
  const [scope, setScope] = useState<string>(initialSession?.scope ?? initialScope ?? 'all');
  const [messages, setMessages] = useState<ChatMessageDisplay[]>(initialMessages);
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<SessionInfo | null>(initialSession);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingContent, scrollToBottom]);

  async function handleSend(message: string) {
    if (isStreaming) return;

    // Optimistically add user message
    const tempUserMsg: ChatMessageDisplay = {
      id: Date.now(),
      role: 'user',
      content: message,
      citations: [],
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);
    setIsStreaming(true);
    setStreamingContent('');

    try {
      const url = session ? `/api/chat/${session.id}` : '/api/chat';
      const body = session ? { message } : { message, scope, model };

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok || !response.body) {
        throw new Error(`Chat request failed: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let currentEvent = '';
      let buffer = '';

      function processLines(lines: string[]) {
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7);
          } else if (line.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(line.slice(6));
              handleSSEEvent(currentEvent, parsed);
              if (currentEvent === 'delta') {
                accumulated += parsed.content;
                setStreamingContent(accumulated);
              }
            } catch {
              // Incomplete JSON — will be completed in next chunk
            }
          }
        }
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        processLines(lines);
      }

      // Flush remaining buffer content
      if (buffer.trim()) {
        processLines(buffer.split('\n'));
      }
    } catch (err) {
      // Show error as a system message
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          role: 'assistant',
          content: `Error: ${err instanceof Error ? err.message : 'Unknown error'}. Please try again.`,
          citations: [],
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setIsStreaming(false);
      setStreamingContent('');
    }
  }

  function handleSSEEvent(event: string, data: Record<string, unknown>) {
    switch (event) {
      case 'session': {
        const newSession = {
          id: data.id as number,
          title: data.title as string,
          scope: data.scope as string,
          model: (data.model as string | undefined) ?? DEFAULT_CHAT_MODEL,
        };
        setSession(newSession);
        sessionRef.current = newSession;
        window.history.replaceState(null, '', `/chat/${newSession.id}`);
        break;
      }
      case 'done': {
        // Use ref to get the latest session (avoids stale closure)
        const currentSession = sessionRef.current;
        if (currentSession) {
          fetch(`/api/chat/${currentSession.id}`)
            .then((r) => r.json())
            .then((body) => {
              setMessages(body.messages);
            })
            .catch(() => {
              // Fallback: keep streaming content as the message
            });
        }
        break;
      }
      case 'title': {
        const title = data.title as string;
        setSession((prev) => (prev ? { ...prev, title } : prev));
        sessionRef.current = sessionRef.current ? { ...sessionRef.current, title } : null;
        break;
      }
      case 'error': {
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now(),
            role: 'assistant',
            content: `Error: ${data.error}`,
            citations: [],
            createdAt: new Date().toISOString(),
          },
        ]);
        break;
      }
    }
  }

  const refreshMessages = useCallback(() => {
    const currentSession = sessionRef.current;
    if (!currentSession) return;
    fetch(`/api/chat/${currentSession.id}`)
      .then((r) => r.json())
      .then((body) => setMessages(body.messages))
      .catch(() => {});
  }, []);

  const title = session?.title ?? 'New chat';
  const displayScope = session?.scope ?? scope;

  return (
    <div className="flex h-[calc(100vh-1px)] flex-col">
      {/* Header */}
      <div className="border-border flex shrink-0 items-center gap-1 border-b px-2 py-2">
        <HamburgerButton />
        <Link
          href="/chat"
          className="text-muted-foreground hover:text-foreground rounded p-1 transition-colors"
        >
          <ArrowLeft size={18} />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{title}</h1>
        </div>
        {displayScope !== 'all' && (
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {scopeDisplayLabel(displayScope)}
          </Badge>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.length === 0 && !isStreaming && (
            <div className="text-muted-foreground py-16 text-center">
              <p className="text-lg">Ask a question</p>
              <p className="mt-2 text-sm">
                Chat with your knowledge base — I&apos;ll search across your articles, highlights,
                and theses to find answers.
              </p>
            </div>
          )}

          {messages.map((msg) => (
            <ChatMessage
              key={msg.id}
              message={msg}
              sessionId={session?.id}
              onFiled={refreshMessages}
            />
          ))}

          {isStreaming && streamingContent && (
            <ChatMessage
              message={{
                id: -1,
                role: 'assistant',
                content: streamingContent,
                citations: [],
                createdAt: new Date().toISOString(),
              }}
              isStreaming
            />
          )}

          {isStreaming && !streamingContent && (
            <div className="flex items-center gap-2 py-2">
              <div className="bg-muted-foreground/30 h-2 w-2 animate-pulse rounded-full" />
              <span className="text-muted-foreground text-sm">Thinking...</span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-border shrink-0 border-t px-4 py-3">
        <div className="mx-auto max-w-3xl">
          {!session && (
            <div className="mb-2">
              <ScopeSelector value={scope} onChange={setScope} disabled={isStreaming} />
            </div>
          )}
          <ChatInput
            onSend={handleSend}
            disabled={isStreaming}
            model={model}
            defaultValue={initialPrefill}
            onModelChange={(m) => {
              setModel(m);
              if (session) {
                fetch(`/api/chat/${session.id}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ model: m }),
                }).catch(() => {});
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}
