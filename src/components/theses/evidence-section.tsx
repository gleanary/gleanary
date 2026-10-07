'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Trash2, Lightbulb, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ThesisLinkedHighlight, HighlightSuggestion, ThesisHighlightRole } from '@/types';

const ROLE_COLORS: Record<ThesisHighlightRole, string> = {
  supporting: 'bg-tint-green text-tint-green-fg',
  opposing: 'bg-tint-red text-tint-red-fg',
  context: 'bg-tint-blue text-tint-blue-fg',
};

interface EvidenceSectionProps {
  thesisId: number;
  highlights: ThesisLinkedHighlight[];
  onUnlink: (highlightId: number) => void;
  hasAiKey: boolean;
}

/**
 * Shows linked highlights with roles and allows unlinking and AI-powered suggestions.
 * @param props - Thesis ID, linked highlights, unlink handler, and AI availability flag
 */
export function EvidenceSection({
  thesisId,
  highlights,
  onUnlink,
  hasAiKey,
}: EvidenceSectionProps) {
  const router = useRouter();
  const [suggestions, setSuggestions] = useState<
    (HighlightSuggestion & { text: string; articleTitle: string })[]
  >([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [linking, setLinking] = useState<number | null>(null);

  const loadSuggestions = async () => {
    setLoadingSuggestions(true);
    try {
      const res = await fetch(`/api/theses/${thesisId}/suggest-highlights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 10 }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { suggestions: typeof suggestions };
      setSuggestions(data.suggestions);
    } finally {
      setLoadingSuggestions(false);
    }
  };

  const acceptSuggestion = async (s: (typeof suggestions)[number]) => {
    setLinking(s.highlightId);
    try {
      await fetch(`/api/theses/${thesisId}/highlights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          highlightIds: [s.highlightId],
          role: s.suggestedRole,
        }),
      });
      setSuggestions((prev) => prev.filter((x) => x.highlightId !== s.highlightId));
      router.refresh();
    } finally {
      setLinking(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-foreground font-medium">Evidence ({highlights.length})</h3>
        {hasAiKey && (
          <Button
            variant="outline"
            size="sm"
            onClick={loadSuggestions}
            disabled={loadingSuggestions}
          >
            {loadingSuggestions ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Lightbulb className="mr-1 h-3 w-3" />
            )}
            Suggest highlights
          </Button>
        )}
      </div>

      {highlights.length === 0 && suggestions.length === 0 && (
        <p className="text-muted-foreground text-sm">
          No highlights linked yet. Use the &ldquo;Link to thesis&rdquo; option when reviewing or
          reading.
        </p>
      )}

      {highlights.map((h) => (
        <div
          key={h.id}
          className="bg-muted/30 border-border rounded-md border p-3"
          data-testid="evidence-highlight"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-foreground text-sm leading-relaxed">{h.text}</p>
              {h.linkNote && (
                <p className="text-muted-foreground mt-1 text-xs italic">{h.linkNote}</p>
              )}
              <div className="mt-2 flex items-center gap-2">
                <Badge className={`text-xs ${ROLE_COLORS[h.role]}`}>{h.role}</Badge>
                <Link
                  href={`/reader/${h.article.id}`}
                  className="text-muted-foreground hover:text-foreground truncate text-xs hover:underline"
                >
                  {h.article.title}
                  {h.article.siteName && ` · ${h.article.siteName}`}
                </Link>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => onUnlink(h.id)}
              className="text-muted-foreground hover:text-destructive mt-0.5 shrink-0 hover:bg-transparent dark:hover:bg-transparent"
              title="Unlink highlight"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>
      ))}

      {suggestions.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            AI Suggestions
          </p>
          {suggestions.map((s) => (
            <div
              key={s.highlightId}
              className="border-border bg-muted/10 rounded-md border border-dashed p-3"
            >
              <p className="text-foreground text-sm">{s.text}</p>
              <p className="text-muted-foreground mt-1 text-xs italic">{s.reason}</p>
              <div className="mt-2 flex items-center gap-2">
                <Badge className={`text-xs ${ROLE_COLORS[s.suggestedRole]}`}>
                  {s.suggestedRole}
                </Badge>
                <span className="text-muted-foreground text-xs">{s.articleTitle}</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-6 px-2 text-xs"
                  disabled={linking === s.highlightId}
                  onClick={() => acceptSuggestion(s)}
                >
                  {linking === s.highlightId ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Add'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
