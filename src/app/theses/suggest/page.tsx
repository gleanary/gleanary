'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Lightbulb, Loader2, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TopBar, TopBarButton } from '@/components/layout/top-bar';
import type { ThesisSuggestion } from '@/types';

/**
 * AI-powered thesis suggestion page.
 * Fetches suggestions based on unlinked highlights and lets the user approve or dismiss them.
 */
export default function SuggestThesesPage() {
  const router = useRouter();
  const [suggestions, setSuggestions] = useState<ThesisSuggestion[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState<number | null>(null);
  const [strategy, setStrategy] = useState<'recent' | 'random' | 'diverse'>('diverse');

  const loadSuggestions = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/theses/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 5, strategy }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { suggestions: ThesisSuggestion[] };
      setSuggestions(data.suggestions);
    } finally {
      setLoading(false);
    }
  };

  const approveSuggestion = async (suggestion: ThesisSuggestion, index: number) => {
    setCreating(index);
    try {
      const createRes = await fetch('/api/theses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: suggestion.title, claim: suggestion.claim }),
      });
      if (!createRes.ok) return;
      const { thesis } = (await createRes.json()) as { thesis: { id: number } };

      if (suggestion.relevantHighlightIds.length > 0) {
        await fetch(`/api/theses/${thesis.id}/highlights`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ highlightIds: suggestion.relevantHighlightIds }),
        });
      }

      router.push(`/theses/${thesis.id}`);
    } finally {
      setCreating(null);
    }
  };

  const dismissSuggestion = (title: string) => {
    setSuggestions((prev) => (prev ? prev.filter((s) => s.title !== title) : prev));
  };

  return (
    <main className="px-4 pt-3 pb-6">
      <TopBar>
        <TopBarButton onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Back</span>
        </TopBarButton>
        <span className="text-foreground mr-1 px-2 text-sm font-semibold">Suggest Theses</span>
      </TopBar>
      <div className="mx-auto max-w-2xl py-6">
        {suggestions === null ? (
          <div className="space-y-4">
            <div className="flex gap-2">
              {(['recent', 'diverse', 'random'] as const).map((s) => (
                <Button
                  key={s}
                  type="button"
                  variant={strategy === s ? 'default' : 'secondary'}
                  size="xs"
                  onClick={() => setStrategy(s)}
                  className={`rounded-full ${strategy === s ? '' : 'text-muted-foreground'}`}
                >
                  {s === 'recent' ? 'Recent' : s === 'random' ? 'Random' : 'Diverse'}
                </Button>
              ))}
            </div>
            <Button onClick={loadSuggestions} disabled={loading}>
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Lightbulb className="mr-2 h-4 w-4" />
              )}
              {loading ? 'Analyzing highlights…' : 'Generate suggestions'}
            </Button>
          </div>
        ) : suggestions.length === 0 ? (
          <div className="text-muted-foreground py-12 text-center">
            <p>No suggestions found.</p>
            <p className="mt-1 text-sm">
              Try adding more highlights or ensure the Anthropic API key is configured.
            </p>
            <Button variant="outline" className="mt-4" onClick={loadSuggestions}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {suggestions.map((s, i) => (
              <div key={s.title} className="bg-card border-border rounded-lg border p-4">
                <h3 className="text-foreground font-medium">{s.title}</h3>
                {s.claim && (
                  <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{s.claim}</p>
                )}
                <div className="text-muted-foreground mt-2 text-xs">
                  {s.relevantHighlightIds.length} relevant highlight
                  {s.relevantHighlightIds.length !== 1 ? 's' : ''}
                  {s.confidence != null && ` · ${Math.round(s.confidence * 100)}% confidence`}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    size="sm"
                    disabled={creating === i}
                    onClick={() => approveSuggestion(s, i)}
                  >
                    {creating === i ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                      <ChevronRight className="mr-1 h-3 w-3" />
                    )}
                    Create thesis
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => dismissSuggestion(s.title)}
                    disabled={creating === i}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            ))}

            <Button
              variant="outline"
              className="w-full"
              onClick={loadSuggestions}
              disabled={loading}
            >
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Generate more suggestions
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}
