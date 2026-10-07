import 'server-only';
import { rawDb } from '@/db';
import { buildSnippet } from '@/lib/search-snippets';
import type {
  SearchResultArticle,
  SearchResultHighlight,
  SearchResultThesis,
  SearchResultDraft,
  SearchArticleRow,
  SearchHighlightRow,
  SearchThesisRow,
  SearchDraftRow,
} from '@/types';

/**
 * Shared inputs for the four entity searches. `ftsQuery` is the escaped (and,
 * in palette mode, prefix-starred) MATCH string; `cap`/`off` are the resolved
 * LIMIT/OFFSET; the optional filters are applied only when `isPalette` is false.
 */
export interface SearchQueryInput {
  /** Escaped FTS5 MATCH string (prefix-starred in palette mode) */
  ftsQuery: string;
  /** When true, all secondary filters are skipped and paging is caller-capped */
  isPalette: boolean;
  /** Row LIMIT */
  cap: number;
  /** Row OFFSET */
  off: number;
  /** Article status filter (non-palette only) */
  status?: string;
  /** Article source filter (non-palette only) */
  sourceId?: number;
  /** Inclusive lower date bound, YYYY-MM-DD (non-palette only) */
  dateFrom?: string;
  /** Inclusive upper date bound, YYYY-MM-DD (non-palette only) */
  dateTo?: string;
}

/** Structured parts of a single FTS row+count query pair. */
interface FtsQuerySpec {
  /** SELECT column list, excluding the trailing snippet() expression */
  selectColumns: string;
  /** FTS virtual table name, e.g. `articles_fts` */
  fts: string;
  /** Base join binding the base table to `fts.rowid` */
  baseJoin: string;
  /** Additional joins applied to the row query only (never the count query) */
  extraJoins?: string;
  /** Column index passed to snippet() */
  snippetColumn: number;
  /** bm25() ranking expression used in ORDER BY */
  bm25: string;
  /** WHERE clause (already AND-joined) shared by row and count queries */
  where: string;
  /** Bound params for the WHERE clause, in order; count reuses these verbatim */
  params: (string | number)[];
  /** Row LIMIT */
  cap: number;
  /** Row OFFSET */
  off: number;
}

/**
 * Appends `date(column) >= ?` / `date(column) <= ?` conditions (and their
 * bound params) when the corresponding bound is set. Shared by all four
 * entity searches, which differ only in which date column they filter on.
 * @param conditions - WHERE clause fragments, mutated in place
 * @param params - Bound params matching `conditions`, mutated in place
 * @param dateColumn - Qualified column expression, e.g. `a.saved_at`
 * @param dateFrom - Inclusive lower date bound, YYYY-MM-DD
 * @param dateTo - Inclusive upper date bound, YYYY-MM-DD
 */
function applyDateFilters(
  conditions: string[],
  params: (string | number)[],
  dateColumn: string,
  dateFrom?: string,
  dateTo?: string,
): void {
  if (dateFrom) {
    conditions.push(`date(${dateColumn}) >= ?`);
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push(`date(${dateColumn}) <= ?`);
    params.push(dateTo);
  }
}

/**
 * Runs the row query (bm25-ordered, paginated, snippet-annotated) plus the
 * matching unpaginated COUNT(*) query that reuses the same WHERE and params.
 * @param spec - Structured query parts (SQL text, params, paging)
 * @returns The raw rows and the total unpaginated match count
 */
function runFtsQuery<TRow>(spec: FtsQuerySpec): { rows: TRow[]; total: number } {
  const { selectColumns, fts, baseJoin, extraJoins, snippetColumn, bm25, where, params, cap, off } =
    spec;

  const rows = rawDb
    .prepare(
      `SELECT ${selectColumns},
              snippet(${fts}, ${snippetColumn}, char(1), char(2), '…', 12) AS raw_snippet
         FROM ${fts} fts
         ${baseJoin}${extraJoins ? `\n         ${extraJoins}` : ''}
         WHERE ${where}
         ORDER BY ${bm25}
         LIMIT ? OFFSET ?`,
    )
    .all(...params, cap, off) as TRow[];

  const { n } = rawDb
    .prepare(
      `SELECT COUNT(*) AS n
         FROM ${fts} fts
         ${baseJoin}
         WHERE ${where}`,
    )
    .get(...params) as { n: number };

  return { rows, total: n };
}

/**
 * Full-text search over articles. The `pending_review` exclusion is always
 * applied (even in palette mode); status/source/date filters are non-palette only.
 * @param input - Shared search inputs and filters
 * @returns Mapped article results and the unpaginated total
 */
export function searchArticles(input: SearchQueryInput): {
  results: SearchResultArticle[];
  total: number;
} {
  const conditions = [`articles_fts MATCH ?`, `a.status != 'pending_review'`];
  const params: (string | number)[] = [input.ftsQuery];

  if (!input.isPalette) {
    if (input.status) {
      conditions.push(`a.status = ?`);
      params.push(input.status);
    }
    if (input.sourceId) {
      conditions.push(`a.source_id = ?`);
      params.push(input.sourceId);
    }
    applyDateFilters(conditions, params, 'a.saved_at', input.dateFrom, input.dateTo);
  }

  const { rows, total } = runFtsQuery<SearchArticleRow>({
    selectColumns: 'a.id, a.title, a.site_name, a.status, a.saved_at',
    fts: 'articles_fts',
    baseJoin: 'JOIN articles a ON a.id = fts.rowid',
    snippetColumn: 1,
    bm25: 'bm25(articles_fts, 3.0, 1.0, 1.0, 1.0, 1.0)',
    where: conditions.join(' AND '),
    params,
    cap: input.cap,
    off: input.off,
  });

  const results: SearchResultArticle[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    siteName: r.site_name,
    status: r.status as SearchResultArticle['status'],
    snippet: buildSnippet(r.raw_snippet),
    savedAt: r.saved_at,
  }));

  return { results, total };
}

/**
 * Full-text search over highlights, joining the parent article for its title.
 * Date filters are applied only outside palette mode.
 * @param input - Shared search inputs and filters
 * @returns Mapped highlight results and the unpaginated total
 */
export function searchHighlights(input: SearchQueryInput): {
  results: SearchResultHighlight[];
  total: number;
} {
  const conditions = ['highlights_fts MATCH ?'];
  const params: (string | number)[] = [input.ftsQuery];

  if (!input.isPalette) {
    applyDateFilters(conditions, params, 'h.created_at', input.dateFrom, input.dateTo);
  }

  const { rows, total } = runFtsQuery<SearchHighlightRow>({
    selectColumns: 'h.id, h.article_id, a.title AS article_title',
    fts: 'highlights_fts',
    baseJoin: 'JOIN highlights h ON h.id = fts.rowid',
    extraJoins: 'JOIN articles a ON a.id = h.article_id',
    snippetColumn: -1,
    bm25: 'bm25(highlights_fts)',
    where: conditions.join(' AND '),
    params,
    cap: input.cap,
    off: input.off,
  });

  const results: SearchResultHighlight[] = rows.map((r) => ({
    id: r.id,
    articleId: r.article_id,
    articleTitle: r.article_title,
    snippet: buildSnippet(r.raw_snippet),
  }));

  return { results, total };
}

/**
 * Full-text search over theses. Date filters are applied only outside palette mode.
 * @param input - Shared search inputs and filters
 * @returns Mapped thesis results and the unpaginated total
 */
export function searchTheses(input: SearchQueryInput): {
  results: SearchResultThesis[];
  total: number;
} {
  const conditions = ['theses_fts MATCH ?'];
  const params: (string | number)[] = [input.ftsQuery];

  if (!input.isPalette) {
    applyDateFilters(conditions, params, 't.created_at', input.dateFrom, input.dateTo);
  }

  const { rows, total } = runFtsQuery<SearchThesisRow>({
    selectColumns: 't.id, t.title, t.status',
    fts: 'theses_fts',
    baseJoin: 'JOIN theses t ON t.id = fts.rowid',
    snippetColumn: -1,
    bm25: 'bm25(theses_fts)',
    where: conditions.join(' AND '),
    params,
    cap: input.cap,
    off: input.off,
  });

  const results: SearchResultThesis[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status as SearchResultThesis['status'],
    snippet: buildSnippet(r.raw_snippet),
  }));

  return { results, total };
}

/**
 * Full-text search over drafts. Date filters are applied only outside palette mode.
 * @param input - Shared search inputs and filters
 * @returns Mapped draft results and the unpaginated total
 */
export function searchDrafts(input: SearchQueryInput): {
  results: SearchResultDraft[];
  total: number;
} {
  const conditions = ['drafts_fts MATCH ?'];
  const params: (string | number)[] = [input.ftsQuery];

  if (!input.isPalette) {
    applyDateFilters(conditions, params, 'd.created_at', input.dateFrom, input.dateTo);
  }

  const { rows, total } = runFtsQuery<SearchDraftRow>({
    selectColumns: 'd.id, d.title, d.template_id, d.thesis_id',
    fts: 'drafts_fts',
    baseJoin: 'JOIN drafts d ON d.id = fts.rowid',
    snippetColumn: -1,
    bm25: 'bm25(drafts_fts)',
    where: conditions.join(' AND '),
    params,
    cap: input.cap,
    off: input.off,
  });

  const results: SearchResultDraft[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    templateId: r.template_id as SearchResultDraft['templateId'],
    thesisId: r.thesis_id,
    snippet: buildSnippet(r.raw_snippet),
  }));

  return { results, total };
}
