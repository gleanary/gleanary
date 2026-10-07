'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ThesisLinker } from '@/components/theses/thesis-linker';
import { truncate } from '@/lib/text-utils';
import type { HighlightWithContext } from '@/types';

interface ReviewCardProps {
  highlight: HighlightWithContext;
  onAction: (action: 'got_it' | 'review_again') => void;
  disabled: boolean;
}

/** Max chars for highlight snippet in /chat/new URL (≈100 tokens). Keeps URL under 2KB. */
const EXPLORE_SNIPPET_MAX = 300;

/**
 * A single review card that shows a highlight and allows the user to
 * reveal the source context, then rate their recall.
 * @param props - Highlight data, action callback, and disabled state
 */
export function ReviewCard({ highlight, onAction, disabled }: ReviewCardProps) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div
      data-testid="review-card"
      className="border-border bg-card mx-auto max-w-2xl rounded-lg border border-l-4 border-l-yellow-400 p-6"
    >
      <p className="text-foreground text-lg leading-relaxed">{highlight.text}</p>

      {highlight.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {highlight.tags.map((tag) => (
            <Badge key={tag.id} variant="secondary" className="text-xs">
              {tag.color && (
                <span
                  className="mr-1 inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: tag.color }}
                />
              )}
              {tag.name}
            </Badge>
          ))}
        </div>
      )}

      {!revealed ? (
        <div className="mt-6 text-center">
          <Button
            variant="outline"
            size="sm"
            data-testid="reveal-source"
            onClick={() => setRevealed(true)}
          >
            Reveal source
          </Button>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          <div className="border-border bg-muted/50 rounded-md border p-4">
            {highlight.note && (
              <p className="text-muted-foreground mb-2 text-sm italic">{highlight.note}</p>
            )}
            <Link
              href={`/reader/${highlight.articleId}`}
              className="text-foreground text-sm font-medium hover:underline"
            >
              {highlight.article.title}
            </Link>
            {highlight.article.siteName && (
              <span className="text-muted-foreground ml-2 text-xs">
                {highlight.article.siteName}
              </span>
            )}
          </div>

          <div className="flex justify-center gap-3">
            <Button
              variant="outline"
              data-testid="review-again"
              onClick={() => onAction('review_again')}
              disabled={disabled}
            >
              Review again
            </Button>
            <Button data-testid="got-it" onClick={() => onAction('got_it')} disabled={disabled}>
              Got it
            </Button>
          </div>

          <div className="mt-3 flex justify-center gap-2">
            <ThesisLinker highlightId={highlight.id} />
            <Button asChild variant="outline" size="sm">
              <Link href={exploreHref(highlight.articleId, highlight.text)}>Explore</Link>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Builds a `/chat/new` URL that opens a new chat scoped to the highlight's
 * parent article, with a prefilled question about the highlight passage.
 */
function exploreHref(articleId: number, highlightText: string): string {
  const snippet = truncate(highlightText, EXPLORE_SNIPPET_MAX);
  const prefill = `What are the key arguments around this passage? "${snippet}"`;
  return `/chat/new?scope=article:${articleId}&prefill=${encodeURIComponent(prefill)}`;
}
