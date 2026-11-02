'use client';

import Link from 'next/link';
import { Loader2, RotateCcw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useArticle } from '@/components/reader/article-context';
import type { GenerateKind } from '@/types';

interface GenerateActionProps {
  kind: GenerateKind;
  /** Whether an Anthropic API key is configured (resolved by the server page). */
  aiAvailable: boolean;
}

const EMPTY_HINTS: Record<GenerateKind, string> = {
  summary: 'No summary yet.',
  tags: 'No tags yet.',
};

const BUTTON = {
  idle: { Icon: Sparkles, label: 'Generate' },
  pending: { Icon: Loader2, label: 'Generating…' },
  error: { Icon: RotateCcw, label: 'Retry' },
} as const;

/**
 * Empty state of the summary and tags sections: a hint and a Generate button that fills
 * the section through `ArticleContext` (no page refresh). The request is owned by
 * `ArticleProvider`, so it survives this widget remounting. Pending disables
 * the button; an error shows inline with a Retry button. Without an Anthropic API key it
 * links to Settings instead.
 * @param props.kind - Which article field to generate
 * @param props.aiAvailable - Whether an Anthropic API key is configured
 * @returns The Generate empty state
 */
export function GenerateAction({ kind, aiAvailable }: GenerateActionProps) {
  const { generateRequests, generate } = useArticle();
  const request = generateRequests[kind];

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
        <p className="text-sidebar-foreground/60 text-sm">{EMPTY_HINTS[kind]}</p>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={status === 'pending'}
        onClick={() => generate(kind)}
      >
        <Icon className={status === 'pending' ? 'animate-spin' : undefined} />
        {label}
      </Button>
    </div>
  );
}
