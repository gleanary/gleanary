'use client';

import { createContext, useContext, useRef, useState } from 'react';
import { generateArticleAi } from '@/lib/article-api';
import type { Article, GenerateKind, GenerateRequest } from '@/types';

interface ArticleContextValue {
  article: Article;
  /** Merges `updates` into the article. */
  updateArticle: (updates: Partial<Article>) => void;
  progressResetKey: number;
  triggerProgressReset: () => void;
  /** Running or failed Generate requests by kind; a missing kind is idle. */
  generateRequests: Partial<Record<GenerateKind, GenerateRequest>>;
  /** Generates the article's AI summary or tags and applies the result to the article. */
  generate: (kind: GenerateKind) => void;
}

const ArticleContext = createContext<ArticleContextValue | null>(null);

/**
 * Provides shared article state for the reader view.
 * Allows client-side updates to article properties like readingProgress.
 * Also owns the article's Generate requests, so they survive their consumers
 * remounting. The provider itself remounts per article (the reader page keys it by id),
 * so a result that
 * settles after navigating away reaches an unmounted provider and is dropped.
 * @param initialArticle - The article data from the server
 * @param children - Child components that consume the context
 */
export function ArticleProvider({
  initialArticle,
  children,
}: {
  initialArticle: Article;
  children: React.ReactNode;
}) {
  const [article, setArticle] = useState<Article>(initialArticle);
  const [progressResetKey, setProgressResetKey] = useState(0);
  const [generateRequests, setGenerateRequests] = useState<
    Partial<Record<GenerateKind, GenerateRequest>>
  >({});

  const updateArticle = (updates: Partial<Article>) => {
    setArticle((prev) => ({ ...prev, ...updates }));
  };

  const triggerProgressReset = () => setProgressResetKey((k) => k + 1);

  const setRequest = (kind: GenerateKind, request: GenerateRequest | null) =>
    setGenerateRequests((prev) => {
      const next = { ...prev };
      if (request) next[kind] = request;
      else delete next[kind];
      return next;
    });

  // Only the id is captured, so a request left running after navigating away does not
  // keep this article's content alive. Not aborted on unmount: the server stores the
  // result on the article anyway.
  const articleId = article.id;
  // Synchronous guard: two calls before the pending state renders must not send two
  // (paid) requests
  const pendingRef = useRef(new Set<GenerateKind>());
  const generate = async (kind: GenerateKind) => {
    if (pendingRef.current.has(kind)) return;
    pendingRef.current.add(kind);
    setRequest(kind, { status: 'pending' });
    try {
      updateArticle(await generateArticleAi(kind, articleId));
      setRequest(kind, null);
    } catch (err) {
      setRequest(kind, {
        status: 'error',
        message: err instanceof Error ? err.message : 'Request failed',
      });
    } finally {
      pendingRef.current.delete(kind);
    }
  };

  return (
    <ArticleContext.Provider
      value={{
        article,
        updateArticle,
        progressResetKey,
        triggerProgressReset,
        generateRequests,
        generate,
      }}
    >
      {children}
    </ArticleContext.Provider>
  );
}

/**
 * Hook to access shared article data from the reader view context.
 * @returns The current article data, update function and Generate requests
 */
export function useArticle(): ArticleContextValue {
  const ctx = useContext(ArticleContext);
  if (!ctx) throw new Error('useArticle must be used within ArticleProvider');
  return ctx;
}
