'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MessageSquare } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/text-utils';
import type { HighlightWithContext } from '@/types';

interface HighlightCardProps {
  highlight: HighlightWithContext;
  selected: boolean;
  onSelect: (id: number, selected: boolean) => void;
  snippet?: string;
}

/**
 * Renders a single highlight in the library with article context, tags, and selection.
 * @param props - Highlight data, selection state, and selection callback
 * @returns Card component for a highlight
 */
export function HighlightCard({ highlight, selected, onSelect, snippet }: HighlightCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isLong = highlight.text.length > 280;
  const displayText = isLong && !expanded ? `${highlight.text.slice(0, 280)}...` : highlight.text;
  const [renderedHtml, setRenderedHtml] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void import('katex/contrib/auto-render').then(({ default: renderMathInElement }) => {
      if (!mounted) return;
      // Use an off-screen element so React reconciliation doesn't revert KaTeX's DOM changes
      const scratch = document.createElement('span');
      scratch.textContent = displayText;
      renderMathInElement(scratch, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false },
        ],
        output: 'html',
        throwOnError: false,
      });
      if (mounted) setRenderedHtml(scratch.innerHTML);
    });
    return () => {
      mounted = false;
    };
  }, [displayText]);

  return (
    <div
      className={`border-border bg-card rounded-lg border border-l-4 border-l-yellow-400 p-4 pl-5 transition-colors ${
        selected ? 'ring-ring ring-2' : ''
      }`}
    >
      <div className="flex items-start gap-3">
        <Checkbox
          checked={selected}
          onCheckedChange={(checked) => onSelect(highlight.id, !!checked)}
          aria-label={`Select highlight: ${highlight.text.slice(0, 50)}`}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1">
          {renderedHtml !== null ? (
            // Safe: renderedHtml comes from KaTeX applied to a textContent-escaped scratch
            // element (see effect above), so the raw highlight text is already HTML-escaped.
            <p
              className="text-sm leading-relaxed"
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          ) : (
            // First paint (before the KaTeX effect resolves): render as plain React text so
            // unsanitized highlight text can never be parsed as HTML.
            <p className="text-sm leading-relaxed">{displayText}</p>
          )}
          {isLong && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setExpanded(!expanded)}
              className="text-muted-foreground hover:text-foreground mt-0.5 font-normal hover:bg-transparent dark:hover:bg-transparent"
            >
              {expanded ? 'Show less' : 'Show more'}
            </Button>
          )}

          {snippet && (
            // Safe: server-guaranteed escaped HTML containing only <mark> tags — see docs/modules/global-search.md §6.1
            <p
              className="text-muted-foreground mt-2 text-xs [&_mark]:rounded-sm [&_mark]:bg-[rgba(253,224,71,0.4)] [&_mark]:dark:bg-[rgba(253,224,71,0.25)]"
              dangerouslySetInnerHTML={{ __html: snippet }}
            />
          )}
          {highlight.note && (
            <p className="text-muted-foreground mt-2 text-xs italic">{highlight.note}</p>
          )}

          <div className="mt-3 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Link
                href={`/reader/${highlight.articleId}`}
                className="text-muted-foreground hover:text-foreground truncate text-xs"
              >
                {highlight.article.title}
              </Link>
              {highlight.article.siteName && (
                <span className="text-muted-foreground/60 shrink-0 text-xs">
                  {highlight.article.siteName}
                </span>
              )}
            </div>

            {highlight.anchorStatus === 'orphaned' && (
              <Badge
                variant="outline"
                className="border-destructive/40 text-destructive shrink-0 text-xs"
              >
                Needs re-anchoring
              </Badge>
            )}
            <span className="text-muted-foreground/60 shrink-0 text-xs">
              {formatDate(highlight.createdAt)}
            </span>
            <Link
              href={`/chat/new?scope=article:${highlight.articleId}&prefill=${encodeURIComponent(`What does this highlight from '${highlight.article.title}' mean in context: '${highlight.text.slice(0, 200)}'`)}`}
              className="text-muted-foreground hover:text-foreground shrink-0 p-0.5"
              title="Chat about this"
            >
              <MessageSquare size={14} />
            </Link>
          </div>

          {highlight.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
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
        </div>
      </div>
    </div>
  );
}
