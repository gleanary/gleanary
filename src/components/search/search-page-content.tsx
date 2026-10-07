'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { ArticleCard } from '@/components/inbox/article-card';
import { HighlightCard } from '@/components/library/highlight-card';
import { ThesisCard } from '@/components/theses/thesis-card';
import { DraftCard } from '@/components/drafts/draft-card';
import { Button } from '@/components/ui/button';
import { useSearchQuery } from './use-search-query';
import type {
  SearchEntityType,
  SearchResultArticle,
  SearchResultHighlight,
  SearchResultThesis,
  SearchResultDraft,
  ArticleListItem,
  HighlightWithContext,
  ThesisListItem,
  ThesisStatus,
} from '@/types';
import type { DraftListItem } from '@/lib/draft-api';

type ActiveTab = 'all' | SearchEntityType;

const TABS: { id: ActiveTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'article', label: 'Articles' },
  { id: 'highlight', label: 'Highlights' },
  { id: 'thesis', label: 'Theses' },
  { id: 'draft', label: 'Drafts' },
];

const PAGE_LIMIT = 10;

// ── Type adapters ─────────────────────────────────────────────────────────────

function toArticleListItem(r: SearchResultArticle): ArticleListItem {
  return {
    id: r.id,
    url: '',
    title: r.title,
    siteName: r.siteName,
    excerpt: null,
    wordCount: null,
    pageCount: null,
    originalFilePath: null,
    extractionTier: null,
    readingProgress: null,
    status: r.status,
    savedAt: r.savedAt,
    isFavorite: false,
  };
}

function toHighlightWithContext(r: SearchResultHighlight): HighlightWithContext {
  return {
    id: r.id,
    articleId: r.articleId,
    text: '',
    note: null,
    color: 'yellow',
    positionData: null,
    anchorStatus: 'anchored',
    createdAt: '',
    updatedAt: '',
    lastReviewed: null,
    reviewCount: null,
    reviewInterval: null,
    article: { title: r.articleTitle, url: '', siteName: null },
    tags: [],
  };
}

function toThesisListItem(r: SearchResultThesis): ThesisListItem {
  return {
    id: r.id,
    title: r.title,
    claim: null,
    status: r.status as ThesisStatus,
    highlightCount: 0,
    researchCount: 0,
    createdAt: '',
    updatedAt: '',
  };
}

function toDraftListItem(r: SearchResultDraft): DraftListItem {
  return {
    id: r.id,
    thesisId: r.thesisId,
    thesisTitle: '',
    templateId: r.templateId,
    title: r.title,
    angle: null,
    status: 'draft',
    generatedAt: null,
    lastEditedAt: null,
    publishedAt: null,
    createdAt: '',
    updatedAt: '',
  };
}

// ── Filter state ──────────────────────────────────────────────────────────────

interface Filters {
  status: string;
  dateFrom: string;
  dateTo: string;
}

const EMPTY_FILTERS: Filters = { status: '', dateFrom: '', dateTo: '' };

// ── Extra pages (load-more accumulation) ─────────────────────────────────────

interface ExtraPage {
  articles: SearchResultArticle[];
  highlights: SearchResultHighlight[];
  theses: SearchResultThesis[];
  drafts: SearchResultDraft[];
}

const EMPTY_EXTRA: ExtraPage[] = [];

// ── Main component ─────────────────────────────────────────────────────────────

/**
 * Full-text search page with URL-driven state, type tabs, filters, and load-more.
 * Reachable from the command palette's "See all N results →" footer item.
 */
export function SearchPageContent() {
  const router = useRouter();
  const sp = useSearchParams();

  // Sync initial state from URL
  const [inputValue, setInputValue] = useState(() => sp.get('q') ?? '');
  const [activeTab, setActiveTab] = useState<ActiveTab>(
    () => (sp.get('types') as SearchEntityType | null) ?? 'all',
  );
  const [filters, setFilters] = useState<Filters>(() => ({
    status: sp.get('status') ?? '',
    dateFrom: sp.get('dateFrom') ?? '',
    dateTo: sp.get('dateTo') ?? '',
  }));

  // Load-more state: extra pages accumulated by clicking "Load more"
  // Updated only in event handlers (never in effects) to avoid cascading renders.
  // extraPages holds previous pages; current page data comes from useSearchQuery.
  const [offset, setOffset] = useState(0);
  const [extraPages, setExtraPages] = useState<ExtraPage[]>(EMPTY_EXTRA);

  // Debounce URL replace
  const urlDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-focus the search input on mount so arriving on this page (e.g. the
  // mobile sidebar search redirect) lands with the cursor ready to type.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const updateUrl = useCallback(
    (q: string, tab: ActiveTab, f: Filters) => {
      if (urlDebounceRef.current) clearTimeout(urlDebounceRef.current);
      urlDebounceRef.current = setTimeout(() => {
        const params = new URLSearchParams();
        if (q) params.set('q', q);
        if (tab !== 'all') params.set('types', tab);
        if (f.status) params.set('status', f.status);
        if (f.dateFrom) params.set('dateFrom', f.dateFrom);
        if (f.dateTo) params.set('dateTo', f.dateTo);
        router.replace(`/search?${params.toString()}`);
      }, 200);
    },
    [router],
  );

  function resetPagination() {
    setOffset(0);
    setExtraPages(EMPTY_EXTRA);
  }

  function handleQueryChange(value: string) {
    setInputValue(value);
    resetPagination();
    updateUrl(value, activeTab, filters);
  }

  function handleTabChange(tab: ActiveTab) {
    setActiveTab(tab);
    resetPagination();
    updateUrl(inputValue, tab, filters);
  }

  function handleFilterChange(key: keyof Filters, value: string) {
    const next = { ...filters, [key]: value };
    setFilters(next);
    resetPagination();
    updateUrl(inputValue, activeTab, next);
  }

  function clearFilters() {
    setFilters(EMPTY_FILTERS);
    resetPagination();
    updateUrl(inputValue, activeTab, EMPTY_FILTERS);
  }

  const hasFilters = filters.status !== '' || filters.dateFrom !== '' || filters.dateTo !== '';

  const typesParam = activeTab === 'all' ? undefined : (activeTab as string);

  const queryOptions = {
    mode: 'full' as const,
    types: typesParam,
    status: filters.status || undefined,
    dateFrom: filters.dateFrom || undefined,
    dateTo: filters.dateTo || undefined,
    limit: PAGE_LIMIT,
    offset,
  };

  const { data, isLoading } = useSearchQuery(inputValue, queryOptions);

  // Build displayed results: extraPages (previous load-more pages) + current data page
  // This is computed at render time — no effect needed for accumulation.
  const allArticles = [...extraPages.flatMap((p) => p.articles), ...(data?.results.articles ?? [])];
  const allHighlights = [
    ...extraPages.flatMap((p) => p.highlights),
    ...(data?.results.highlights ?? []),
  ];
  const allTheses = [...extraPages.flatMap((p) => p.theses), ...(data?.results.theses ?? [])];
  const allDrafts = [...extraPages.flatMap((p) => p.drafts), ...(data?.results.drafts ?? [])];

  function handleLoadMore(type: SearchEntityType) {
    if (!data) return;
    // Save current data as an extra page before incrementing offset
    setExtraPages((prev) => [
      ...prev,
      {
        articles: data.results.articles,
        highlights: data.results.highlights,
        theses: data.results.theses,
        drafts: data.results.drafts,
      },
    ]);
    setOffset((prev) => prev + PAGE_LIMIT);
    void type; // offset increment triggers new fetch via useSearchQuery
  }

  const totals = data?.totals ?? { article: 0, highlight: 0, thesis: 0, draft: 0 };
  const grandTotal = Object.values(totals).reduce((s, n) => s + n, 0);

  const showStatusFilter = activeTab === 'article';
  const showDateFilter = activeTab !== 'all';

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Search input */}
      <div className="border-border bg-background flex items-center gap-2 rounded-lg border px-4 py-2.5">
        <Search size={16} className="text-muted-foreground shrink-0" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search everything…"
          value={inputValue}
          onChange={(e) => handleQueryChange(e.target.value)}
          className="placeholder:text-muted-foreground flex-1 bg-transparent text-sm outline-none"
          autoComplete="off"
          spellCheck={false}
          aria-label="Search"
        />
        {inputValue && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => handleQueryChange('')}
            aria-label="Clear search"
            className="text-muted-foreground hover:text-foreground shrink-0 hover:bg-transparent dark:hover:bg-transparent"
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>

      {/* Type tabs */}
      {inputValue.length >= 2 && data && (
        <div className="border-border flex gap-1 border-b" role="tablist" aria-label="Result type">
          {TABS.map(({ id, label }) => {
            const count = id === 'all' ? grandTotal : (totals[id as SearchEntityType] ?? 0);
            const isActive = activeTab === id;
            return (
              // Accepted raw <button> (handover §5): ARIA tablist option (role="tab" +
              // aria-selected). Kept raw to preserve tab semantics and the underline-active style.
              <button
                key={id}
                role="tab"
                aria-selected={isActive}
                onClick={() => handleTabChange(id)}
                className={`px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'text-foreground border-b-2 border-current font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {label}
                {count > 0 && (
                  <span
                    className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] ${
                      isActive
                        ? 'bg-accent text-accent-foreground'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Filter row */}
      {inputValue.length >= 2 && (showStatusFilter || showDateFilter) && (
        <div className="flex flex-wrap items-center gap-2">
          {showStatusFilter && (
            <select
              value={filters.status}
              onChange={(e) => handleFilterChange('status', e.target.value)}
              className="border-border bg-background rounded-md border px-2 py-1 text-xs"
              aria-label="Status filter"
            >
              <option value="">All statuses</option>
              <option value="inbox">Inbox</option>
              <option value="reading">Reading</option>
              <option value="archived">Archived</option>
            </select>
          )}
          {showDateFilter && (
            <>
              <input
                type="date"
                value={filters.dateFrom}
                onChange={(e) => handleFilterChange('dateFrom', e.target.value)}
                className="border-border bg-background rounded-md border px-2 py-1 text-xs"
                aria-label="From date"
              />
              <input
                type="date"
                value={filters.dateTo}
                onChange={(e) => handleFilterChange('dateTo', e.target.value)}
                className="border-border bg-background rounded-md border px-2 py-1 text-xs"
                aria-label="To date"
              />
            </>
          )}
          {hasFilters && (
            <Button
              variant="ghost"
              size="xs"
              onClick={clearFilters}
              className="text-muted-foreground hover:text-foreground hover:bg-transparent dark:hover:bg-transparent"
            >
              <X className="size-3" />
              Clear filters
            </Button>
          )}
        </div>
      )}

      {/* Results */}
      {inputValue.length < 2 ? (
        <p className="text-muted-foreground py-12 text-center text-sm">
          Enter at least 2 characters to search
        </p>
      ) : isLoading && allArticles.length === 0 && allHighlights.length === 0 ? (
        <p className="text-muted-foreground py-12 text-center text-sm">Searching…</p>
      ) : !data || grandTotal === 0 ? (
        <div className="py-12 text-center">
          <p className="text-muted-foreground text-sm">No results for &lsquo;{inputValue}&rsquo;</p>
          {hasFilters && (
            <Button variant="link" onClick={clearFilters} className="mt-2 h-auto p-0 text-sm">
              Clear filters
            </Button>
          )}
        </div>
      ) : activeTab === 'all' ? (
        <AllTabResults
          articles={allArticles}
          highlights={allHighlights}
          theses={allTheses}
          drafts={allDrafts}
          totals={totals}
          onTabChange={handleTabChange}
        />
      ) : (
        <SingleTabResults
          type={activeTab as SearchEntityType}
          articles={allArticles}
          highlights={allHighlights}
          theses={allTheses}
          drafts={allDrafts}
          totals={totals}
          shownCount={offset + PAGE_LIMIT}
          onLoadMore={handleLoadMore}
          isLoading={isLoading}
        />
      )}
    </div>
  );
}

// ── All-tab: stacked groups ───────────────────────────────────────────────────

interface AllTabResultsProps {
  articles: SearchResultArticle[];
  highlights: SearchResultHighlight[];
  theses: SearchResultThesis[];
  drafts: SearchResultDraft[];
  totals: Record<SearchEntityType, number>;
  onTabChange: (tab: ActiveTab) => void;
}

function AllTabResults({
  articles,
  highlights,
  theses,
  drafts,
  totals,
  onTabChange,
}: AllTabResultsProps) {
  return (
    <div className="space-y-6">
      {articles.length > 0 && (
        <ResultGroup
          label="Articles"
          total={totals.article}
          onShowAll={() => onTabChange('article')}
        >
          {articles.map((r) => (
            <ArticleCard key={r.id} article={toArticleListItem(r)} snippet={r.snippet} />
          ))}
        </ResultGroup>
      )}
      {highlights.length > 0 && (
        <ResultGroup
          label="Highlights"
          total={totals.highlight}
          onShowAll={() => onTabChange('highlight')}
        >
          {highlights.map((r) => (
            <HighlightCard
              key={r.id}
              highlight={toHighlightWithContext(r)}
              selected={false}
              onSelect={() => {}}
              snippet={r.snippet}
            />
          ))}
        </ResultGroup>
      )}
      {theses.length > 0 && (
        <ResultGroup label="Theses" total={totals.thesis} onShowAll={() => onTabChange('thesis')}>
          {theses.map((r) => (
            <ThesisCard key={r.id} thesis={toThesisListItem(r)} snippet={r.snippet} />
          ))}
        </ResultGroup>
      )}
      {drafts.length > 0 && (
        <ResultGroup label="Drafts" total={totals.draft} onShowAll={() => onTabChange('draft')}>
          {drafts.map((r) => (
            <DraftCard key={r.id} draft={toDraftListItem(r)} snippet={r.snippet} />
          ))}
        </ResultGroup>
      )}
    </div>
  );
}

interface ResultGroupProps {
  label: string;
  total: number;
  onShowAll: () => void;
  children: React.ReactNode;
}

function ResultGroup({ label, total, onShowAll, children }: ResultGroupProps) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{label}</h2>
        {total > 5 && (
          <Button variant="link" onClick={onShowAll} className="h-auto p-0 text-xs">
            Show all {total} →
          </Button>
        )}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

// ── Single-tab: results + load-more ──────────────────────────────────────────

interface SingleTabResultsProps {
  type: SearchEntityType;
  articles: SearchResultArticle[];
  highlights: SearchResultHighlight[];
  theses: SearchResultThesis[];
  drafts: SearchResultDraft[];
  totals: Record<SearchEntityType, number>;
  shownCount: number;
  onLoadMore: (type: SearchEntityType) => void;
  isLoading: boolean;
}

function SingleTabResults({
  type,
  articles,
  highlights,
  theses,
  drafts,
  totals,
  shownCount,
  onLoadMore,
  isLoading,
}: SingleTabResultsProps) {
  const total = totals[type];
  const hasMore = total > shownCount;

  return (
    <div className="space-y-2">
      {type === 'article' &&
        articles.map((r) => (
          <ArticleCard key={r.id} article={toArticleListItem(r)} snippet={r.snippet} />
        ))}
      {type === 'highlight' &&
        highlights.map((r) => (
          <HighlightCard
            key={r.id}
            highlight={toHighlightWithContext(r)}
            selected={false}
            onSelect={() => {}}
            snippet={r.snippet}
          />
        ))}
      {type === 'thesis' &&
        theses.map((r) => (
          <ThesisCard key={r.id} thesis={toThesisListItem(r)} snippet={r.snippet} />
        ))}
      {type === 'draft' &&
        drafts.map((r) => <DraftCard key={r.id} draft={toDraftListItem(r)} snippet={r.snippet} />)}

      {hasMore && (
        <div className="pt-2 text-center">
          <Button variant="outline" size="sm" onClick={() => onLoadMore(type)} disabled={isLoading}>
            {isLoading ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
