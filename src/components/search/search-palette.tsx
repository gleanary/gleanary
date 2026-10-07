'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { isMobileDevice } from '@/lib/is-mobile';
import { useSidebar } from '@/components/layout/sidebar-context';
import { SearchPaletteInput } from './search-palette-input';
import { useSearchQuery } from './use-search-query';
import {
  paletteReducer,
  buildFlatItems,
  activeItemId,
  itemDomId,
  type FlatItem,
} from './search-palette-results';
import type { SearchResponse } from '@/types';

// ── Group / result rendering (local, palette-specific) ──────────────────────

const SNIPPET_CLASSES =
  'text-muted-foreground mt-0.5 line-clamp-1 text-xs [&_mark]:bg-[rgba(253,224,71,0.4)] [&_mark]:dark:bg-[rgba(253,224,71,0.25)] [&_mark]:rounded-sm';

const GROUP_LABELS: Record<string, string> = {
  article: 'Articles',
  highlight: 'Highlights',
  thesis: 'Theses',
  draft: 'Drafts',
};

interface ResultsProps {
  data: SearchResponse | null;
  query: string;
  activeIndex: number;
  items: FlatItem[];
  onHover: (index: number) => void;
  onActivate: (item: FlatItem) => void;
}

function PaletteResults({ data, query, activeIndex, items, onHover, onActivate }: ResultsProps) {
  if (!data) return null;

  const isEmpty =
    data.results.articles.length === 0 &&
    data.results.highlights.length === 0 &&
    data.results.theses.length === 0 &&
    data.results.drafts.length === 0;

  if (isEmpty) {
    return (
      <div className="px-4 py-8 text-center">
        <p className="text-muted-foreground text-sm">No results for &lsquo;{query}&rsquo;</p>
      </div>
    );
  }

  // Build groups for rendering
  const groups: { kind: string; entries: Array<{ item: FlatItem; globalIndex: number }> }[] = [];
  let currentKind = '';
  let flatIndex = 0;

  for (const item of items) {
    if (item.kind === 'footer') break;
    if (item.kind !== currentKind) {
      currentKind = item.kind;
      groups.push({ kind: currentKind, entries: [] });
    }
    groups[groups.length - 1]!.entries.push({ item, globalIndex: flatIndex });
    flatIndex++;
  }

  const footerIndex = items.length - 1;
  const footerItem = items[footerIndex];

  return (
    <div
      role="listbox"
      id="search-palette-listbox"
      data-testid="search-listbox"
      className="max-h-[60vh] overflow-y-auto py-2"
    >
      {groups.map((group) => {
        const headerId = `search-group-header-${group.kind}`;
        return (
          <div key={group.kind} role="group" aria-labelledby={headerId}>
            <p
              id={headerId}
              role="presentation"
              className="text-muted-foreground px-4 py-1 text-[10px] font-semibold tracking-wider uppercase"
            >
              {GROUP_LABELS[group.kind]}
            </p>
            {group.entries.map(({ item, globalIndex }) => {
              const id = itemDomId(item, globalIndex);
              const isActive = globalIndex === activeIndex;
              return (
                <div
                  key={id}
                  id={id}
                  data-testid={
                    item.kind === 'footer'
                      ? undefined
                      : `search-option-${item.kind}-${item.result.id}`
                  }
                  role="option"
                  aria-selected={isActive}
                  onMouseEnter={() => onHover(globalIndex)}
                  onClick={() => onActivate(item)}
                  className={`cursor-pointer px-4 py-2 ${isActive ? 'bg-accent' : 'hover:bg-accent/50'}`}
                >
                  {item.kind === 'article' && (
                    <>
                      <p className="truncate text-sm font-medium">{item.result.title}</p>
                      {item.result.siteName && (
                        <p className="text-muted-foreground truncate text-xs">
                          {item.result.siteName}
                        </p>
                      )}
                      {item.result.snippet && (
                        // Safe: server-guaranteed escaped HTML containing only <mark> tags — see docs/modules/global-search.md §6.1
                        <p
                          className={SNIPPET_CLASSES}
                          dangerouslySetInnerHTML={{ __html: item.result.snippet }}
                        />
                      )}
                    </>
                  )}
                  {item.kind === 'highlight' && (
                    <>
                      {/* Safe: server-guaranteed escaped HTML — see docs/modules/global-search.md §6.1 */}
                      <p
                        className={SNIPPET_CLASSES}
                        dangerouslySetInnerHTML={{ __html: item.result.snippet }}
                      />
                      <p className="text-muted-foreground truncate text-xs">
                        {item.result.articleTitle}
                      </p>
                    </>
                  )}
                  {item.kind === 'thesis' && (
                    <>
                      <p className="truncate text-sm font-medium">{item.result.title}</p>
                      {item.result.snippet && (
                        // Safe: server-guaranteed escaped HTML — see docs/modules/global-search.md §6.1
                        <p
                          className={SNIPPET_CLASSES}
                          dangerouslySetInnerHTML={{ __html: item.result.snippet }}
                        />
                      )}
                    </>
                  )}
                  {item.kind === 'draft' && (
                    <>
                      <p className="truncate text-sm font-medium">{item.result.title}</p>
                      {item.result.snippet && (
                        // Safe: server-guaranteed escaped HTML — see docs/modules/global-search.md §6.1
                        <p
                          className={SNIPPET_CLASSES}
                          dangerouslySetInnerHTML={{ __html: item.result.snippet }}
                        />
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      {footerItem?.kind === 'footer' && (
        <div
          id="search-option-footer"
          data-testid="search-footer"
          role="option"
          aria-selected={footerIndex === activeIndex}
          onMouseEnter={() => onHover(footerIndex)}
          onClick={() => onActivate(footerItem)}
          className={`border-border mt-1 cursor-pointer border-t px-4 py-2 text-sm ${footerIndex === activeIndex ? 'bg-accent' : 'hover:bg-accent/50'}`}
        >
          See all {footerItem.total} results →
        </div>
      )}
    </div>
  );
}

// ── Shell ────────────────────────────────────────────────────────────────────

interface SearchPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Global search command palette built on Radix Dialog primitives.
 * Implements WAI-ARIA combobox + listbox pattern per spec §4.5.
 */
export function SearchPalette({ open, onOpenChange }: SearchPaletteProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const { close: closeSidebar } = useSidebar();

  const { data, isLoading } = useSearchQuery(query, { mode: 'palette' });

  const [state, dispatch] = useReducer(paletteReducer, { items: [], activeIndex: -1 });

  // Rebuild flat list whenever data changes
  useEffect(() => {
    dispatch({ type: 'SET_ITEMS', items: buildFlatItems(data) });
  }, [data]);

  // Scroll active item into view on every activeIndex change
  useEffect(() => {
    const id = activeItemId(state.items, state.activeIndex);
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'nearest' });
  }, [state.activeIndex, state.items]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      // rAF ensures the Dialog animation has started and the input is mounted
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) setQuery('');
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  const close = useCallback(() => handleOpenChange(false), [handleOpenChange]);

  const activateItem = useCallback(
    (item: FlatItem) => {
      close();
      // On mobile, also retract the sidebar so the destination isn't covered (mirrors sidebar nav)
      if (isMobileDevice) closeSidebar();
      if (item.kind === 'footer') {
        router.push(`/search?q=${encodeURIComponent(query)}`);
      } else if (item.kind === 'article') {
        router.push(`/reader/${item.result.id}`);
      } else if (item.kind === 'highlight') {
        router.push(`/reader/${item.result.articleId}?highlight=${item.result.id}`);
      } else if (item.kind === 'thesis') {
        router.push(`/theses/${item.result.id}`);
      } else if (item.kind === 'draft') {
        router.push(`/drafts/${item.result.id}`);
      }
    },
    [close, closeSidebar, query, router],
  );

  function handleKeyDown(key: string) {
    if (key === 'ArrowDown') dispatch({ type: 'MOVE', delta: 1 });
    else if (key === 'ArrowUp') dispatch({ type: 'MOVE', delta: -1 });
    else if (key === 'Home') dispatch({ type: 'HOME' });
    else if (key === 'End') dispatch({ type: 'END' });
    else if (key === 'Enter') {
      const item = state.items[state.activeIndex];
      if (item) activateItem(item);
    }
  }

  const curActiveId = activeItemId(state.items, state.activeIndex);
  const hasResults = state.items.length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="gap-0 overflow-hidden p-0 max-sm:inset-0 max-sm:top-0 max-sm:h-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:content-start max-sm:rounded-none sm:top-[20%] sm:max-w-xl sm:translate-y-0"
        aria-label="Search"
      >
        {/* Screen-reader-only title satisfies Radix's DialogTitle requirement */}
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">
          Type to search articles, highlights, theses, and drafts
        </DialogDescription>

        <SearchPaletteInput
          ref={inputRef}
          value={query}
          onChange={setQuery}
          hasResults={hasResults}
          activeItemId={curActiveId}
          isLoading={isLoading}
          onClose={close}
          onKeyNav={handleKeyDown}
        />

        <PaletteResults
          data={data}
          query={query}
          activeIndex={state.activeIndex}
          items={state.items}
          onHover={(index) => dispatch({ type: 'SET_HOVER', index })}
          onActivate={activateItem}
        />
      </DialogContent>
    </Dialog>
  );
}
