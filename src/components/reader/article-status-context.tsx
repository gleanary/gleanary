'use client';

import { createContext, useCallback, useContext, useState, useTransition } from 'react';
import { patchArticle } from '@/lib/article-api';
import type { ArticleStatus } from '@/types';

interface ArticleStatusContextValue {
  status: ArticleStatus;
  isPending: boolean;
  toggleArchive: (onSuccess?: () => void) => void;
}

const ArticleStatusContext = createContext<ArticleStatusContextValue | null>(null);

/**
 * Provides shared article status state for the reader view.
 * Ensures toolbar and footer button stay in sync.
 * @param articleId - The article's database ID
 * @param initialStatus - The article's initial status from the server
 * @param children - Child components that consume the context
 */
export function ArticleStatusProvider({
  articleId,
  initialStatus,
  children,
}: {
  articleId: number;
  initialStatus: ArticleStatus;
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<ArticleStatus>(initialStatus);
  const [isPending, startTransition] = useTransition();

  const toggleArchive = useCallback(
    (onSuccess?: () => void) => {
      startTransition(async () => {
        const newStatus: ArticleStatus = status === 'archived' ? 'inbox' : 'archived';
        try {
          const res = await patchArticle(articleId, { status: newStatus });
          if (!res.ok) throw new Error(`PATCH failed: ${res.status}`);
          setStatus(newStatus);
          if (newStatus === 'archived') onSuccess?.();
        } catch {
          // Status unchanged on failure — no optimistic update to roll back
        }
      });
    },
    [articleId, status],
  );

  return (
    <ArticleStatusContext.Provider value={{ status, isPending, toggleArchive }}>
      {children}
    </ArticleStatusContext.Provider>
  );
}

/**
 * Hook to access shared article status from the reader view context.
 * @returns The current status, pending state, and status mutation functions
 */
export function useArticleStatus(): ArticleStatusContextValue {
  const ctx = useContext(ArticleStatusContext);
  if (!ctx) throw new Error('useArticleStatus must be used within ArticleStatusProvider');
  return ctx;
}
