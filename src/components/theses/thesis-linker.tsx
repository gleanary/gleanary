'use client';

import { useState, useCallback } from 'react';
import { ChevronDown, Link2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ThesisListItem } from '@/types';

interface ThesisLinkerProps {
  highlightId: number;
  /** Called after successfully linking or creating a thesis */
  onLinked?: (thesisId: number, thesisTitle: string) => void;
}

/**
 * Reusable component for linking a highlight to a thesis.
 * Collapses to a subtle link by default to avoid cluttering the parent UI.
 * Used in the review card and highlight popover.
 * @param props - Highlight ID and optional callback after linking
 */
export function ThesisLinker({ highlightId, onLinked }: ThesisLinkerProps) {
  const [expanded, setExpanded] = useState(false);
  const [theses, setTheses] = useState<ThesisListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [linking, setLinking] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [linked, setLinked] = useState<string | null>(null);

  const loadTheses = useCallback(async () => {
    if (theses.length > 0) return;
    setLoading(true);
    try {
      const res = await fetch('/api/theses?limit=100&sort=updatedAt&order=desc');
      const data = (await res.json()) as { theses: ThesisListItem[] };
      setTheses(data.theses ?? []);
    } catch {
      // Silently degrade — user can still see theses if they retry
    } finally {
      setLoading(false);
    }
  }, [theses.length]);

  const handleExpand = async () => {
    setExpanded(true);
    await loadTheses();
  };

  const linkToThesis = async (thesisId: number, thesisTitle: string) => {
    setLinking(true);
    try {
      const res = await fetch(`/api/theses/${thesisId}/highlights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ highlightIds: [highlightId] }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        if (res.status === 409) {
          setLinked(thesisTitle);
          onLinked?.(thesisId, thesisTitle);
          return;
        }
        throw new Error(err.error ?? 'Failed to link');
      }
      setLinked(thesisTitle);
      onLinked?.(thesisId, thesisTitle);
    } catch {
      // ignore — user can retry
    } finally {
      setLinking(false);
    }
  };

  const createAndLink = async () => {
    if (newTitle.trim().length < 3) return;
    setLinking(true);
    try {
      const createRes = await fetch('/api/theses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim() }),
      });
      if (!createRes.ok) return;
      const { thesis } = (await createRes.json()) as { thesis: ThesisListItem };
      await linkToThesis(thesis.id, thesis.title);
    } catch {
      // ignore — user can retry
    } finally {
      setLinking(false);
    }
  };

  if (linked) {
    return (
      <p className="text-muted-foreground mt-2 text-xs">
        <Link2 className="mr-1 inline h-3 w-3" />
        Linked to: <span className="font-medium">{linked}</span>
      </p>
    );
  }

  if (!expanded) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={handleExpand}
        className="text-muted-foreground hover:text-foreground mt-2 font-normal hover:bg-transparent dark:hover:bg-transparent"
      >
        <Link2 size={12} />
        Link to thesis
        <ChevronDown size={12} />
      </Button>
    );
  }

  return (
    <div className="mt-2 space-y-2" data-testid="thesis-linker">
      {loading ? (
        <p className="text-muted-foreground text-xs">Loading theses…</p>
      ) : (
        <>
          {theses.length > 0 && (
            <div className="border-border max-h-40 overflow-y-auto rounded border">
              {theses.map((t) => (
                <Button
                  key={t.id}
                  type="button"
                  variant="ghost"
                  disabled={linking}
                  onClick={() => linkToThesis(t.id, t.title)}
                  className="text-foreground hover:bg-muted/50 dark:hover:bg-muted/50 h-auto w-full justify-start truncate rounded-none px-3 py-1.5 text-xs font-normal"
                >
                  {t.title}
                </Button>
              ))}
            </div>
          )}

          {!showCreate ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setShowCreate(true)}
              className="text-muted-foreground hover:text-foreground font-normal hover:bg-transparent dark:hover:bg-transparent"
            >
              <Plus size={12} />
              Create new thesis
            </Button>
          ) : (
            <div className="flex gap-1">
              <input
                autoFocus
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Thesis title…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createAndLink();
                  if (e.key === 'Escape') setShowCreate(false);
                }}
                className="border-input bg-background text-foreground placeholder:text-muted-foreground min-w-0 flex-1 rounded border px-2 py-1 text-xs"
              />
              <Button
                size="sm"
                className="h-6 px-2 text-xs"
                disabled={newTitle.trim().length < 3 || linking}
                onClick={createAndLink}
              >
                Add
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
