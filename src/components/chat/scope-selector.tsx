'use client';

import { useState, useEffect, useMemo } from 'react';
import { Globe, BookOpen, Tag, Clock, ChevronDown, Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ThesisOption {
  id: number;
  title: string;
}

interface TagOption {
  id: number;
  name: string;
}

interface Props {
  value: string;
  onChange: (scope: string) => void;
  disabled?: boolean;
}

/**
 * Scope selector for new chat sessions. Allows choosing from All, Thesis, Tag, or Recent scopes.
 * Thesis and Tag options are fetched from the API and searchable.
 * @param props.value - Current scope string
 * @param props.onChange - Callback when scope changes
 * @param props.disabled - Whether selector is disabled
 */
export function ScopeSelector({ value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [theses, setTheses] = useState<ThesisOption[]>([]);
  const [tags, setTags] = useState<TagOption[]>([]);
  const [search, setSearch] = useState('');
  const [recentDays, setRecentDays] = useState(7);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const { signal } = controller;
    fetch('/api/theses?limit=100', { signal })
      .then((r) => r.json())
      .then((body) =>
        setTheses(body.theses?.map((t: ThesisOption) => ({ id: t.id, title: t.title })) ?? []),
      )
      .catch(() => {});
    fetch('/api/tags', { signal })
      .then((r) => r.json())
      .then((body) => setTags(body.tags?.map((t: TagOption) => ({ id: t.id, name: t.name })) ?? []))
      .catch(() => {});
    return () => controller.abort();
  }, [open]);

  const filteredTheses = useMemo(
    () =>
      search ? theses.filter((t) => t.title.toLowerCase().includes(search.toLowerCase())) : theses,
    [theses, search],
  );

  const filteredTags = useMemo(
    () => (search ? tags.filter((t) => t.name.toLowerCase().includes(search.toLowerCase())) : tags),
    [tags, search],
  );

  function select(scope: string) {
    onChange(scope);
    setOpen(false);
    setSearch('');
  }

  const label = scopeDisplayLabel(value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          disabled={disabled}
          className="text-muted-foreground hover:text-foreground font-normal hover:bg-transparent dark:hover:bg-transparent"
        >
          {scopeIcon(value)}
          <span>{label}</span>
          <ChevronDown size={12} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        {/* Search */}
        <div className="border-border flex items-center gap-2 border-b px-3 py-2">
          <Search size={14} className="text-muted-foreground shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search theses or tags..."
            className="placeholder:text-muted-foreground w-full bg-transparent text-sm outline-none"
          />
        </div>

        <div className="max-h-64 overflow-y-auto p-1">
          {/* Fixed options */}
          <ScopeItem
            icon={<Globe size={14} />}
            label="All — entire knowledge base"
            selected={value === 'all'}
            onClick={() => select('all')}
          />

          {/* Recent */}
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              onClick={() => select(`recent:${recentDays}`)}
              className={cn(
                'h-auto flex-1 justify-start gap-2 px-2 py-1.5 text-sm font-normal',
                value.startsWith('recent:') && 'bg-accent hover:bg-accent dark:hover:bg-accent',
              )}
            >
              <Clock size={14} className="text-muted-foreground shrink-0" />
              <span>Recent</span>
            </Button>
            <select
              value={recentDays}
              onChange={(e) => {
                const d = parseInt(e.target.value);
                setRecentDays(d);
                if (value.startsWith('recent:')) select(`recent:${d}`);
              }}
              className="bg-muted h-7 rounded px-1 text-xs"
            >
              {[7, 14, 30, 60, 90].map((d) => (
                <option key={d} value={d}>
                  {d}d
                </option>
              ))}
            </select>
          </div>

          {/* Theses */}
          {filteredTheses.length > 0 && (
            <>
              <div className="text-muted-foreground px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wide uppercase">
                Theses
              </div>
              {filteredTheses.map((t) => (
                <ScopeItem
                  key={`thesis:${t.id}`}
                  icon={<BookOpen size={14} />}
                  label={t.title}
                  selected={value === `thesis:${t.id}`}
                  onClick={() => select(`thesis:${t.id}`)}
                />
              ))}
            </>
          )}

          {/* Tags */}
          {filteredTags.length > 0 && (
            <>
              <div className="text-muted-foreground px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wide uppercase">
                Tags
              </div>
              {filteredTags.map((t) => (
                <ScopeItem
                  key={`tag:${t.name}`}
                  icon={<Tag size={14} />}
                  label={t.name}
                  selected={value === `tag:${t.name}`}
                  onClick={() => select(`tag:${t.name}`)}
                />
              ))}
            </>
          )}

          {search && filteredTheses.length === 0 && filteredTags.length === 0 && (
            <p className="text-muted-foreground px-2 py-3 text-center text-xs">
              No matching theses or tags
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ScopeItem({
  icon,
  label,
  selected,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className={cn(
        'h-auto w-full justify-start gap-2 px-2 py-1.5 text-sm font-normal',
        selected && 'bg-accent hover:bg-accent dark:hover:bg-accent',
      )}
    >
      <span className="text-muted-foreground shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </Button>
  );
}

function scopeIcon(scope: string) {
  if (scope.startsWith('thesis:')) return <BookOpen size={12} />;
  if (scope.startsWith('tag:')) return <Tag size={12} />;
  if (scope.startsWith('recent:')) return <Clock size={12} />;
  return <Globe size={12} />;
}

/**
 * Returns a human-readable label for a scope string.
 * @param scope - Scope string
 * @returns Display label
 */
export function scopeDisplayLabel(scope: string): string {
  if (scope === 'all') return 'All';
  if (scope.startsWith('article:')) return 'Article';
  if (scope.startsWith('thesis:')) return 'Thesis';
  if (scope.startsWith('tag:')) return `Tag: ${scope.slice(4)}`;
  if (scope.startsWith('recent:')) return `Recent ${scope.slice(7)}d`;
  return scope;
}
