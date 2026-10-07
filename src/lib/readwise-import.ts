import 'server-only';
import { eq, inArray, or } from 'drizzle-orm';
import { db } from '@/db';
import { articles, highlights, sources, tags } from '@/db/schema';
import { getSetting, setSetting } from '@/lib/settings';
import { linkHighlightTags, replaceHighlightTags } from '@/lib/highlight-utils';
import { sanitizeArticleHtml } from '@/lib/sanitize';
import { postProcessHtml } from '@/lib/html-post-processor';
import { convertHtmlToMarkdown } from '@/lib/html-to-markdown';
import { stripHtml, computeWordCount, truncate } from '@/lib/text-utils';
import { logger } from '@/lib/logger';
import { ExternalServiceError } from '@/lib/errors';

// --- Readwise Reader API types ---

interface ReaderDocument {
  id: string;
  url: string;
  source_url: string | null;
  title: string | null;
  author: string | null;
  category: string;
  location: string;
  tags: Record<string, { name: string }> | null;
  site_name: string | null;
  word_count: number | null;
  created_at: string;
  updated_at: string;
  notes: string | null;
  published_date: string | number | null;
  summary: string | null;
  image_url: string | null;
  parent_id: string | null;
  reading_progress: number;
  content: string | null;
  html_content: string | null;
}

interface ReaderListPage {
  count: number;
  results: ReaderDocument[];
  nextPageCursor: string | null;
}

export interface ReadwiseImportProgress {
  phase: 'fetching' | 'importing';
  page?: number;
  current?: number;
  total?: number;
  highlights?: number;
}

export interface ReadwiseImportStats {
  articles: number;
  highlights: number;
  skippedNonArticles: number;
  duration: number;
}

export type ProgressCallback = (event: 'progress' | 'complete', data: object) => void;

const READER_LIST_URL = 'https://readwise.io/api/v3/list/';
const READER_CATEGORY_ARTICLE = 'article';
const READER_CATEGORY_HIGHLIGHT = 'highlight';
const READER_ID_PREFIX = 'rdr_';
const MAX_RETRIES = 3;

/**
 * Fetches a single page from the Readwise Reader list API.
 * Respects Retry-After on 429/503 with up to MAX_RETRIES attempts.
 * @param token - Readwise Bearer token
 * @param cursor - Pagination cursor from previous page
 * @param updatedAfter - ISO 8601 timestamp for incremental sync
 */
async function fetchReaderPage(
  token: string,
  cursor?: string,
  updatedAfter?: string,
): Promise<ReaderListPage> {
  const url = new URL(READER_LIST_URL);
  url.searchParams.set('withHtmlContent', 'true');
  if (cursor) url.searchParams.set('pageCursor', cursor);
  if (updatedAfter) url.searchParams.set('updatedAfter', updatedAfter);

  let lastError: Error | null = null;
  let delay = 1000;
  let skipBackoff = false;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0 && !skipBackoff) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
    skipBackoff = false;

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Token ${token}` },
      signal: AbortSignal.timeout(60_000),
    });

    if (resp.ok) {
      const data = await resp.json();
      return data as ReaderListPage;
    }

    if (resp.status === 429 || resp.status === 503) {
      const retryAfter = resp.headers.get('Retry-After');
      if (retryAfter) {
        const waitMs = parseInt(retryAfter, 10) * 1000;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        skipBackoff = true; // Retry-After already waited; skip exponential backoff
      }
      lastError = new Error(`Reader API returned ${resp.status}`);
      continue;
    }

    throw new ExternalServiceError(
      'Readwise',
      `Reader API returned ${resp.status}: ${resp.statusText}`,
    );
  }

  throw new ExternalServiceError(
    'Readwise',
    lastError?.message ?? 'Rate limit exceeded after retries',
  );
}

/**
 * Returns the ID of the Readwise source, creating it if it doesn't exist.
 */
export function getOrCreateReadwiseSource(): number {
  const existing = db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.type, 'readwise'))
    .get();

  if (existing) return existing.id;

  const created = db
    .insert(sources)
    .values({ type: 'readwise', name: 'Readwise Import' })
    .returning({ id: sources.id })
    .get()!;

  return created.id;
}

/**
 * Returns the ID of a tag by name (case-insensitive), creating it if needed.
 * @param name - Tag name
 */
export function findOrCreateTag(name: string): number {
  const normalized = name.trim().toLowerCase();

  const existing = db.select({ id: tags.id }).from(tags).where(eq(tags.name, normalized)).get();

  if (existing) return existing.id;

  const created = db.insert(tags).values({ name: normalized }).returning({ id: tags.id }).get()!;

  return created.id;
}

/**
 * Resolves tag IDs for a Reader API tags map, creating tags as needed.
 * @param docTags - Reader API tags object { key: { name } }
 */
function resolveTagIds(docTags: Record<string, { name: string }> | null): number[] {
  if (!docTags) return [];
  return Object.values(docTags).map((t) => findOrCreateTag(t.name));
}

/**
 * Derives contentHtml, contentText, wordCount and excerpt from a Reader document's
 * html_content field. Returns nulls when html_content is absent.
 */
function extractContent(doc: ReaderDocument): {
  contentHtml: string | null;
  contentText: string | null;
  contentMarkdown: string | null;
  wordCount: number | null;
  excerpt: string | null;
} {
  if (!doc.html_content) {
    return {
      contentHtml: null,
      contentText: null,
      contentMarkdown: null,
      wordCount: null,
      excerpt: null,
    };
  }
  const contentHtml = sanitizeArticleHtml(postProcessHtml(doc.html_content));
  const contentText = stripHtml(contentHtml);
  const contentMarkdown = convertHtmlToMarkdown(contentHtml);
  const wordCount = computeWordCount(contentText);
  const excerpt = doc.summary ?? truncate(contentText);
  return { contentHtml, contentText, contentMarkdown, wordCount, excerpt };
}

/**
 * Runs a full or incremental Readwise Reader import.
 * Fetches articles and highlights from the Reader API with inline HTML content.
 * Emits progress and complete events via the callback.
 * @param token - Readwise API token
 * @param mode - 'full' fetches all, 'incremental' fetches since last import
 * @param onProgress - Callback for SSE progress events
 */
export async function runReadwiseImport(
  token: string,
  mode: 'full' | 'incremental',
  onProgress: ProgressCallback,
): Promise<void> {
  const startTime = Date.now();

  const updatedAfter =
    mode === 'incremental' ? (getSetting('readwise_last_import') ?? undefined) : undefined;

  const sourceId = getOrCreateReadwiseSource();

  // --- Pagination: collect all documents ---
  const articleDocs: ReaderDocument[] = [];
  const highlightDocs: ReaderDocument[] = [];
  let skippedNonArticles = 0;
  let cursor: string | undefined;
  let page = 0;

  do {
    page++;
    onProgress('progress', { phase: 'fetching', page });

    const data = await fetchReaderPage(token, cursor, updatedAfter);

    for (const doc of data.results) {
      if (doc.parent_id === null && doc.category === READER_CATEGORY_ARTICLE) {
        articleDocs.push(doc);
      } else if (doc.parent_id !== null && doc.category === READER_CATEGORY_HIGHLIGHT) {
        highlightDocs.push(doc);
      } else {
        skippedNonArticles++;
      }
    }

    cursor = data.nextPageCursor ?? undefined;
  } while (cursor);

  logger.info(
    {
      event: 'readwise_fetch_complete',
      articles: articleDocs.length,
      highlights: highlightDocs.length,
      skippedNonArticles,
    },
    'Readwise fetch complete',
  );

  // --- Import: articles first, then highlights ---
  let importedArticles = 0;
  let importedHighlights = 0;
  const total = articleDocs.length + highlightDocs.length;
  // Maps Reader document id → local DB article id for linking highlights
  const readerIdToArticleId = new Map<string, number>();
  let i = 0;

  for (const doc of articleDocs) {
    const externalId = `${READER_ID_PREFIX}${doc.id}`;
    const url = doc.source_url ?? doc.url;

    const existing = db
      .select({ id: articles.id })
      .from(articles)
      .where(or(eq(articles.externalId, externalId), eq(articles.url, url)))
      .get();

    let articleId: number;

    if (!existing) {
      const { contentHtml, contentText, contentMarkdown, wordCount, excerpt } = extractContent(doc);

      const created = db
        .insert(articles)
        .values({
          externalId,
          url,
          title: doc.title ?? url,
          author: doc.author,
          contentHtml,
          contentText,
          contentMarkdown,
          excerpt,
          siteName: doc.site_name,
          imageUrl: doc.image_url,
          wordCount: wordCount ?? doc.word_count,
          publishedAt: doc.published_date
            ? new Date(doc.published_date as string | number).toISOString()
            : null,
          sourceId,
          status: 'archived',
        })
        .returning({ id: articles.id })
        .get()!;

      articleId = created.id;
      importedArticles++;

      logger.info(
        { event: 'readwise_article_created', articleId, externalId },
        'Readwise article created',
      );
    } else {
      articleId = existing.id;
    }

    readerIdToArticleId.set(doc.id, articleId);

    onProgress('progress', {
      phase: 'importing',
      current: ++i,
      total,
      highlights: importedHighlights,
    });
  }

  // Pre-fetch parent articles from DB for highlights whose parent wasn't imported this run
  // (common in incremental mode). One query instead of N.
  const missingParentIds = [
    ...new Set(
      highlightDocs.map((d) => d.parent_id!).filter((pid) => !readerIdToArticleId.has(pid)),
    ),
  ];
  if (missingParentIds.length > 0) {
    const externalIds = missingParentIds.map((pid) => `${READER_ID_PREFIX}${pid}`);
    const found = db
      .select({ id: articles.id, externalId: articles.externalId })
      .from(articles)
      .where(inArray(articles.externalId, externalIds))
      .all();
    for (const row of found) {
      readerIdToArticleId.set(row.externalId!.slice(READER_ID_PREFIX.length), row.id);
    }
  }

  for (const doc of highlightDocs) {
    const articleId = readerIdToArticleId.get(doc.parent_id!);
    if (articleId === undefined) {
      onProgress('progress', {
        phase: 'importing',
        current: ++i,
        total,
        highlights: importedHighlights,
      });
      continue;
    }

    const hlExternalId = `${READER_ID_PREFIX}${doc.id}`;
    const text =
      doc.content?.trim() ||
      (doc.html_content
        ? stripHtml(sanitizeArticleHtml(postProcessHtml(doc.html_content)))
        : null) ||
      doc.title ||
      '';

    const existingHl = db
      .select({ id: highlights.id, updatedAt: highlights.updatedAt })
      .from(highlights)
      .where(eq(highlights.externalId, hlExternalId))
      .get();

    if (!existingHl) {
      const tagIds = resolveTagIds(doc.tags);
      const created = db
        .insert(highlights)
        .values({
          externalId: hlExternalId,
          articleId,
          text,
          note: doc.notes,
          color: 'yellow',
          updatedAt: doc.updated_at,
        })
        .returning({ id: highlights.id })
        .get()!;

      linkHighlightTags(created.id, tagIds);
      importedHighlights++;
    } else {
      // Update if Reader version is newer
      const rwUpdated = new Date(doc.updated_at).getTime();
      const localUpdated = new Date(existingHl.updatedAt).getTime();

      if (rwUpdated > localUpdated) {
        const tagIds = resolveTagIds(doc.tags);
        db.update(highlights)
          .set({
            text,
            note: doc.notes,
            updatedAt: doc.updated_at,
          })
          .where(eq(highlights.id, existingHl.id))
          .run();

        replaceHighlightTags(existingHl.id, tagIds);
      }
    }

    onProgress('progress', {
      phase: 'importing',
      current: ++i,
      total,
      highlights: importedHighlights,
    });
  }

  // Save last import timestamp
  setSetting('readwise_last_import', new Date().toISOString());

  const duration = Date.now() - startTime;

  logger.info(
    { event: 'readwise_import_complete', importedArticles, importedHighlights, duration },
    'Readwise import complete',
  );

  onProgress('complete', {
    articles: importedArticles,
    highlights: importedHighlights,
    skippedNonArticles,
    duration,
  });
}

/**
 * Tests a Readwise API token by calling the auth endpoint.
 * @param token - Readwise API token
 * @returns { success, message }
 */
export async function testReadwiseToken(
  token: string,
): Promise<{ success: boolean; message: string }> {
  const resp = await fetch('https://readwise.io/api/v2/auth/', {
    headers: { Authorization: `Token ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  return {
    success: resp.ok,
    message: resp.ok
      ? 'Readwise API token is valid.'
      : `Readwise returned ${resp.status}: ${resp.statusText}`,
  };
}
