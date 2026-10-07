'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Link2,
  AlertTriangle,
  HelpCircle,
  Clock,
  Loader2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { LintCheck, LintSuggestion, LintRelatedRef } from '@/types';

interface CheckMeta {
  id: LintCheck;
  title: string;
  description: string;
  icon: typeof Link2;
}

const CHECKS: CheckMeta[] = [
  {
    id: 'connections',
    title: 'Find Connections',
    description: 'Cluster unlinked highlights that share concepts across articles.',
    icon: Link2,
  },
  {
    id: 'contradictions',
    title: 'Find Contradictions',
    description: 'Surface notes and highlights that disagree with each other.',
    icon: AlertTriangle,
  },
  {
    id: 'gaps',
    title: 'Check Gaps',
    description:
      'Identify weaknesses in developing theses: missing counterarguments, vague claims.',
    icon: HelpCircle,
  },
  {
    id: 'stale',
    title: 'Find Stale',
    description: 'Neglected theses, stuck articles, and overdue highlight reviews.',
    icon: Clock,
  },
];

const STORAGE_KEY = 'lint-panel-open';

/**
 * Knowledge Health panel — runs lint checks and renders streamed suggestions.
 * Collapsible, client-only, mounted above the chat session list.
 */
export function KnowledgeHealthPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [activeCheck, setActiveCheck] = useState<LintCheck | null>(null);
  const [lastCheck, setLastCheck] = useState<LintCheck | null>(null);
  const [suggestions, setSuggestions] = useState<LintSuggestion[]>([]);
  const [status, setStatus] = useState<'idle' | 'streaming' | 'done' | 'empty' | 'error'>('idle');
  const [emptyReason, setEmptyReason] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Hydrate isOpen from localStorage after mount to avoid SSR mismatch.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === 'true') setIsOpen(true);
    } catch {
      // localStorage unavailable — ignore
    }
  }, []);

  // Cancel any in-flight lint request on unmount so we don't leak the
  // connection or try to setState after the component is gone.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const toggleOpen = useCallback(() => {
    setIsOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  async function runCheck(check: LintCheck) {
    if (activeCheck) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setActiveCheck(check);
    setLastCheck(check);
    setSuggestions([]);
    setStatus('streaming');
    setEmptyReason(null);
    setErrorMessage(null);

    try {
      const response = await fetch('/api/chat/lint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ check }),
        signal: ctrl.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Lint request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';

      const processLines = (lines: string[]) => {
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7);
          } else if (line.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(line.slice(6));
              if (currentEvent === 'suggestion') {
                setSuggestions((prev) => [...prev, parsed as LintSuggestion]);
              } else if (currentEvent === 'empty') {
                setStatus('empty');
                setEmptyReason((parsed as { reason: string }).reason);
              } else if (currentEvent === 'done') {
                setStatus((prev) => (prev === 'empty' || prev === 'error' ? prev : 'done'));
              } else if (currentEvent === 'error') {
                setStatus('error');
                setErrorMessage((parsed as { error: string }).error);
              }
            } catch {
              // incomplete JSON — next chunk will complete it
            }
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        processLines(lines);
      }
      if (buffer.trim()) processLines(buffer.split('\n'));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setActiveCheck(null);
    }
  }

  return (
    <div className="border-border bg-card mb-4 rounded-lg border">
      <Button
        type="button"
        variant="ghost"
        onClick={toggleOpen}
        className="hover:bg-accent/50 h-auto w-full justify-start gap-2 rounded-lg px-4 py-3 font-normal"
        aria-expanded={isOpen}
      >
        {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <Activity size={16} className="text-muted-foreground" />
        <span className="flex-1 text-left text-sm font-medium">Knowledge Health</span>
        {lastCheck && status === 'done' && (
          <Badge variant="secondary" className="text-[10px]">
            {suggestions.length} suggestion{suggestions.length === 1 ? '' : 's'}
          </Badge>
        )}
      </Button>

      {isOpen && (
        <div className="border-border border-t p-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {CHECKS.map((check) => {
              const Icon = check.icon;
              const isRunning = activeCheck === check.id;
              return (
                <Button
                  key={check.id}
                  type="button"
                  variant="outline"
                  onClick={() => runCheck(check.id)}
                  disabled={activeCheck !== null}
                  className="hover:bg-accent/50 h-auto items-start justify-start gap-3 p-3 whitespace-normal"
                >
                  {isRunning ? (
                    <Loader2 size={18} className="text-muted-foreground mt-0.5 animate-spin" />
                  ) : (
                    <Icon size={18} className="text-muted-foreground mt-0.5" />
                  )}
                  <div className="min-w-0 flex-1 text-left">
                    <div className="text-sm font-medium">{check.title}</div>
                    <div className="text-muted-foreground mt-0.5 text-xs leading-snug">
                      {check.description}
                    </div>
                  </div>
                </Button>
              );
            })}
          </div>

          {/* Results area */}
          <div className="mt-4">
            {status === 'empty' && emptyReason && (
              <div className="border-border bg-muted/30 text-muted-foreground rounded-md border p-3 text-sm">
                {emptyReason}
              </div>
            )}
            {status === 'error' && errorMessage && (
              <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm">
                {errorMessage}
              </div>
            )}
            {status === 'done' && suggestions.length === 0 && (
              <div className="border-border bg-muted/30 text-muted-foreground rounded-md border p-3 text-sm">
                Nothing to report — your knowledge base looks healthy.
              </div>
            )}
            {suggestions.length > 0 && (
              <div className="space-y-2">
                {suggestions.map((s, i) => (
                  <SuggestionCard key={`${lastCheck}-${i}`} suggestion={s} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Tailwind color classes for the small type dot on each suggestion card. */
const TYPE_DOT_CLASS: Record<LintSuggestion['type'], string> = {
  connection: 'bg-tint-blue-fg',
  contradiction: 'bg-tint-amber-fg',
  gap: 'bg-tint-purple-fg',
  stale: 'bg-tint-slate-fg',
};

function SuggestionCard({ suggestion }: { suggestion: LintSuggestion }) {
  return (
    <div className="border-border bg-background rounded-md border p-3">
      <div className="flex items-start gap-3">
        <span
          className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${TYPE_DOT_CLASS[suggestion.type]}`}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm">{suggestion.description}</p>
          {suggestion.relatedIds.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {suggestion.relatedIds.map((ref, i) => (
                <RelatedChip key={`${ref.type}-${ref.id}-${i}`} relatedRef={ref} />
              ))}
            </div>
          )}
        </div>
        <SuggestionAction suggestion={suggestion} />
      </div>
    </div>
  );
}

function RelatedChip({ relatedRef }: { relatedRef: LintRelatedRef }) {
  const href =
    relatedRef.type === 'article'
      ? `/reader/${relatedRef.id}`
      : relatedRef.type === 'thesis'
        ? `/theses/${relatedRef.id}`
        : `/library?focus=highlight-${relatedRef.id}`;
  return (
    <Link
      href={href}
      className="border-border bg-muted/50 hover:bg-muted text-muted-foreground inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] transition-colors"
    >
      {relatedRef.type} #{relatedRef.id}
    </Link>
  );
}

function SuggestionAction({ suggestion }: { suggestion: LintSuggestion }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const createThesisFromConnection = useCallback(async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const highlightIds = suggestion.relatedIds
        .filter((r) => r.type === 'highlight')
        .map((r) => r.id);
      const title = suggestion.description.replace(/^Potential thesis:\s*/i, '').slice(0, 200);
      const res = await fetch('/api/theses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, status: 'developing', highlightIds }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setCreateError(body?.error ?? `Failed (${res.status})`);
        return;
      }
      const body = (await res.json()) as { thesis: { id: number } };
      router.push(`/theses/${body.thesis.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setCreating(false);
    }
  }, [suggestion, router]);

  if (suggestion.type === 'connection' && suggestion.relatedIds.length > 0) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          size="sm"
          variant="outline"
          onClick={createThesisFromConnection}
          disabled={creating}
        >
          {creating ? 'Creating…' : 'Create thesis'}
        </Button>
        {createError && <span className="text-destructive text-[10px]">{createError}</span>}
      </div>
    );
  }

  if (suggestion.type === 'gap') {
    const thesisRef = suggestion.relatedIds.find((r) => r.type === 'thesis');
    if (thesisRef) {
      return (
        <Button size="sm" variant="outline" asChild>
          <Link href={`/theses/${thesisRef.id}`}>{suggestion.suggestedAction ?? 'Review'}</Link>
        </Button>
      );
    }
  }

  if (suggestion.type === 'stale') {
    const primary = suggestion.relatedIds[0];
    if (primary?.type === 'thesis') {
      return (
        <Button size="sm" variant="outline" asChild>
          <Link href={`/theses/${primary.id}`}>Review thesis</Link>
        </Button>
      );
    }
    if (primary?.type === 'article') {
      return (
        <Button size="sm" variant="outline" asChild>
          <Link href={`/reader/${primary.id}`}>Resume</Link>
        </Button>
      );
    }
    if (primary?.type === 'highlight') {
      return (
        <Button size="sm" variant="outline" asChild>
          <Link href="/review">Review</Link>
        </Button>
      );
    }
  }

  return null;
}
