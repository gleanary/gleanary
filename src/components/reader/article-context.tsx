'use client';

import { createContext, useContext, useState } from 'react';
import type { Article } from '@/types';

interface ArticleContextValue {
  article: Article;
  updateArticle: (updates: Partial<Article>) => void;
  progressResetKey: number;
  triggerProgressReset: () => void;
}

const ArticleContext = createContext<ArticleContextValue | null>(null);

/**
 * Provides shared article state for the reader view.
 * Allows client-side updates to article properties like readingProgress.
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

  const updateArticle = (updates: Partial<Article>) => {
    setArticle((prev) => ({ ...prev, ...updates }));
  };

  const triggerProgressReset = () => setProgressResetKey((k) => k + 1);

  return (
    <ArticleContext.Provider
      value={{ article, updateArticle, progressResetKey, triggerProgressReset }}
    >
      {children}
    </ArticleContext.Provider>
  );
}

/**
 * Hook to access shared article data from the reader view context.
 * @returns The current article data and update function
 */
export function useArticle(): ArticleContextValue {
  const ctx = useContext(ArticleContext);
  if (!ctx) throw new Error('useArticle must be used within ArticleProvider');
  return ctx;
}
