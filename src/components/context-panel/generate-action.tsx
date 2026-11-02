'use client';

import { useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Loader2, RotateCcw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useArticle } from '@/components/reader/article-context';
import type { Article, AutoTagResponse, SummarizeResponse } from '@/types';

type GenerateKind = 'summary' | 'tags';

type GenerateRequest = { status: 'pending' } | { status: 'error'; message: string };

interface GenerateActionProps {
  kind: GenerateKind;
  /** Whether an Anthropic API key is configured (resolved by the server page). */
  aiAvailable: boolean;
}

interface GenerateConfig {
  endpoint: string;
  emptyHint: string;
  /** The article update for a successful response, or null when it carries nothing. */
  toUpdate: (data: unknown) => Partial<Article> | null;
  emptyError: string;
}

const CONFIG: Record<GenerateKind, GenerateConfig> = {
  summary: {
    endpoint: '/api/ai/summarize',
    emptyHint: 'No summary yet.',
    toUpdate: (data) => {
      const { summary } = data as SummarizeResponse;
      return summary ? { aiSummary: summary } : null;
    },
    emptyError: 'No summary was generated',
  },
  tags: {
    endpoint: '/api/ai/tag',
    emptyHint: 'No tags yet.',
    toUpdate: (data) => {
      const { tags } = data as AutoTagResponse;
      return tags?.length ? { aiTags: JSON.stringify(tags) } : null;
    },
    emptyError: 'No tags were suggested for this article',
  },
};

const BUTTON = {
  idle: { Icon: Sparkles, label: 'Generate' },
  pending: { Icon: Loader2, label: 'Generating…' },
  error: { Icon: RotateCcw, label: 'Retry' },
} as const;

// Requests live at module scope, not in the widget: the panel widgets remount (the
// presentation switches at 768px), and a running request must survive that, keep the
// button disabled when the widget comes back, and still apply its result. Keyed by
// `${kind}:${articleId}`; settled requests are dropped, errors stay until a retry or the
// end of the visit (`clearGenerateErrors`).
const requests = new Map<string, GenerateRequest>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setRequest(key: string, request: GenerateRequest | null): void {
  if (request) requests.set(key, request);
  else requests.delete(key);
  listeners.forEach((listener) => listener());
}

/**
 * Forgets the failed Generate requests of an article, so its next visit starts idle.
 * Running requests are kept: they still apply their result.
 * @param articleId - The article whose errors to drop
 */
export function clearGenerateErrors(articleId: number): void {
  for (const kind of Object.keys(CONFIG) as GenerateKind[]) {
    const key = `${kind}:${articleId}`;
    if (requests.get(key)?.status === 'error') setRequest(key, null);
  }
}

/**
 * Runs one Generate request and applies its result through the reader's
 * `ArticleContext`, which is never remounted. `updateArticle` is given the article id
 * the request was made for, so a result that arrives after navigating to another
 * article is dropped. Not aborted on unmount: the server caches the result anyway.
 */
async function generate(
  kind: GenerateKind,
  articleId: number,
  updateArticle: (updates: Partial<Article>, articleId?: number) => void,
): Promise<void> {
  const key = `${kind}:${articleId}`;
  if (requests.get(key)?.status === 'pending') return;
  setRequest(key, { status: 'pending' });
  try {
    const res = await fetch(CONFIG[kind].endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articleId }),
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error((data as { error?: string } | null)?.error || `Failed (${res.status})`);
    }
    const update = data ? CONFIG[kind].toUpdate(data) : null;
    if (!update) throw new Error(CONFIG[kind].emptyError);
    updateArticle(update, articleId);
    setRequest(key, null);
  } catch (err) {
    setRequest(key, {
      status: 'error',
      message: err instanceof Error ? err.message : 'Request failed',
    });
  }
}

/**
 * Empty state of the summary and tags sections: a hint and a Generate button that fills
 * the section through `ArticleContext.updateArticle` (no page refresh). Pending disables
 * the button; an error shows inline with a Retry button. Without an Anthropic API key it
 * links to Settings instead.
 * @param props.kind - Which article field to generate
 * @param props.aiAvailable - Whether an Anthropic API key is configured
 * @returns The Generate empty state
 */
export function GenerateAction({ kind, aiAvailable }: GenerateActionProps) {
  const { article, updateArticle } = useArticle();
  const key = `${kind}:${article.id}`;
  const request = useSyncExternalStore(
    subscribe,
    () => requests.get(key) ?? null,
    () => null,
  );

  if (!aiAvailable) {
    return (
      <p className="text-sidebar-foreground/60 text-sm">
        <Link
          href="/settings"
          className="hover:text-sidebar-foreground underline underline-offset-2"
        >
          Add an Anthropic API key in Settings to generate
        </Link>
      </p>
    );
  }

  const status = request?.status ?? 'idle';
  const { Icon, label } = BUTTON[status];

  return (
    <div className="flex flex-col items-start gap-2">
      {request?.status === 'error' ? (
        <p role="alert" className="text-destructive text-sm">
          {request.message}
        </p>
      ) : (
        <p className="text-sidebar-foreground/60 text-sm">{CONFIG[kind].emptyHint}</p>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={status === 'pending'}
        onClick={() => void generate(kind, article.id, updateArticle)}
      >
        <Icon className={status === 'pending' ? 'animate-spin' : undefined} />
        {label}
      </Button>
    </div>
  );
}
