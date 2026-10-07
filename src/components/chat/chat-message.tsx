'use client';

import { memo, useMemo } from 'react';
import { renderMarkdown } from '@/lib/markdown-renderer';
import { cn } from '@/lib/utils';
import { MessageActions } from '@/components/chat/message-actions';
import type { ChatMessageDisplay, ChatCitation } from '@/types';

interface Props {
  message: ChatMessageDisplay;
  isStreaming?: boolean;
  sessionId?: number;
  onFiled?: () => void;
}

/**
 * Converts bot message content to sanitized HTML.
 * Citation markers like [article:N] are replaced with anchor links before markdown parsing.
 * @param content - Raw message content with optional citation markers
 * @param citations - Citation metadata for building link titles
 * @returns Sanitized HTML string safe for dangerouslySetInnerHTML
 */
function toSafeHtml(content: string, citations: ChatCitation[]): string {
  const citationMap = new Map(citations.map((c) => [`${c.type}:${c.id}`, c]));

  const withCitations = content.replace(
    /\[(article|highlight|thesis):(\d+)\]/g,
    (_, type: string, id: string) => {
      const citation = citationMap.get(`${type}:${id}`);
      const href =
        type === 'article'
          ? `/reader/${id}`
          : type === 'highlight'
            ? `/library?highlight=${id}`
            : `/theses/${id}`;
      const emoji = type === 'article' ? '📄' : type === 'highlight' ? '🖍' : '💡';
      const label = citation?.title?.slice(0, 40) ?? `#${id}`;
      return `<a href="${href}" class="bg-primary/10 text-primary hover:bg-primary/20 mx-0.5 inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium transition-colors">${emoji} ${label}</a>`;
    },
  );

  return renderMarkdown(withCitations);
}

/**
 * Renders a single chat message (user or assistant).
 * @param props.message - The message to render
 * @param props.isStreaming - Whether this message is still being streamed
 * @param props.sessionId - Chat session ID (for filing actions)
 * @param props.onFiled - Callback after a filing action completes
 */
export const ChatMessage = memo(function ChatMessage({
  message,
  isStreaming,
  sessionId,
  onFiled,
}: Props) {
  const isUser = message.role === 'user';
  const html = useMemo(
    () => (isUser ? null : toSafeHtml(message.content, message.citations)),
    [isUser, message.content, message.citations],
  );

  return (
    <div className={cn('group relative flex', isUser && 'justify-end')}>
      <div
        className={cn(
          'min-w-0',
          isUser
            ? 'bg-primary text-primary-foreground max-w-[85%] rounded-xl px-4 py-2.5'
            : 'max-w-full',
        )}
      >
        {isUser ? (
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="chat-content max-w-none">
            <div dangerouslySetInnerHTML={{ __html: html! }} />
            {isStreaming && (
              <span className="bg-foreground ml-0.5 inline-block h-4 w-1 animate-pulse" />
            )}
          </div>
        )}
      </div>

      {/* Filing actions menu — visible on hover for assistant messages */}
      {!isUser && !isStreaming && sessionId && message.id > 0 && (
        <div className="absolute top-0 right-0 opacity-0 transition-opacity group-hover:opacity-100">
          <MessageActions message={message} sessionId={sessionId} onFiled={onFiled} />
        </div>
      )}
    </div>
  );
});
