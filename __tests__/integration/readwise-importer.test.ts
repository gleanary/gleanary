import { describe, it, expect, beforeEach, vi } from 'vitest';

// DB mock — hoisted so vi.mock works
const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

// Settings mock — return null by default, overridable per test
const mockGetSetting = vi.hoisted(() => vi.fn().mockReturnValue(null));
const mockSetSetting = vi.hoisted(() => vi.fn());
vi.mock('@/lib/settings', () => ({
  getSetting: mockGetSetting,
  setSetting: mockSetSetting,
  getConfig: vi.fn().mockReturnValue('test-token'),
}));

// highlight-utils mock
const mockLinkHighlightTags = vi.hoisted(() => vi.fn());
const mockReplaceHighlightTags = vi.hoisted(() => vi.fn());
vi.mock('@/lib/highlight-utils', () => ({
  linkHighlightTags: mockLinkHighlightTags,
  replaceHighlightTags: mockReplaceHighlightTags,
}));

import { createTestDb } from './setup';
import { db } from '@/db';
import { sources, articles, highlights, tags } from '@/db/schema';
import { eq } from 'drizzle-orm';
import {
  runReadwiseImport,
  findOrCreateTag,
  getOrCreateReadwiseSource,
} from '@/lib/readwise-import';

// --- Fixtures ---

function makeArticleDoc(
  overrides?: Partial<{
    id: string;
    url: string;
    source_url: string | null;
    title: string | null;
    author: string | null;
    category: string;
    tags: Record<string, { name: string }>;
    content: string | null;
    html_content: string | null;
    summary: string | null;
    image_url: string | null;
    site_name: string | null;
    word_count: number | null;
    published_date: string | number | null;
    notes: string | null;
    parent_id: string | null;
    updated_at: string;
  }>,
) {
  return {
    id: 'doc-article-1',
    url: 'https://example.com/article',
    source_url: 'https://example.com/article',
    title: 'Test Article',
    author: 'Test Author',
    category: 'article',
    location: 'archive',
    tags: {} as Record<string, { name: string }>,
    site_name: null,
    word_count: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    notes: null,
    published_date: null,
    summary: null,
    image_url: null,
    parent_id: null,
    reading_progress: 1,
    content: null,
    html_content: '<p>Article content here.</p>',
    ...overrides,
  };
}

function makeHighlightDoc(
  overrides?: Partial<{
    id: string;
    parent_id: string;
    title: string | null;
    content: string | null;
    html_content: string | null;
    notes: string | null;
    tags: Record<string, { name: string }>;
    updated_at: string;
  }>,
) {
  return {
    id: 'doc-highlight-1',
    url: 'https://readwise.io/reader/read/doc-highlight-1',
    source_url: null,
    // Real Reader API: title is null for highlights; text is in `content`
    title: null as string | null,
    author: null,
    category: 'highlight',
    location: 'archive',
    tags: {} as Record<string, { name: string }>,
    site_name: null,
    word_count: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    notes: null,
    published_date: null,
    summary: null,
    image_url: null,
    parent_id: 'doc-article-1',
    reading_progress: 0,
    content: 'Great insight from the article',
    html_content: '',
    ...overrides,
  };
}

function makeListPage(results: unknown[], nextPageCursor: string | null = null) {
  return { count: results.length, results, nextPageCursor };
}

function mockFetch(pages: unknown[]) {
  let call = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const page = pages[call] ?? { count: 0, results: [], nextPageCursor: null };
    call++;
    return { ok: true, json: async () => page } as Response;
  });
}

// --- findOrCreateTag ---

describe('findOrCreateTag', () => {
  beforeEach(() => {
    dbMock.setup();
  });

  it('creates a new tag and returns its id', () => {
    const id = findOrCreateTag('Philosophy');
    expect(id).toBeTypeOf('number');
    const tag = (db as ReturnType<typeof createTestDb>['db'])
      .select()
      .from(tags)
      .where(eq(tags.name, 'philosophy'))
      .get();
    expect(tag?.name).toBe('philosophy');
  });

  it('normalizes tag names to lowercase', () => {
    const id1 = findOrCreateTag('Science');
    const id2 = findOrCreateTag('science');
    const id3 = findOrCreateTag('SCIENCE');
    expect(id1).toBe(id2);
    expect(id2).toBe(id3);
  });

  it('trims whitespace', () => {
    const id1 = findOrCreateTag('  economics  ');
    const id2 = findOrCreateTag('economics');
    expect(id1).toBe(id2);
  });

  it('returns existing tag id without duplicate insert', () => {
    findOrCreateTag('history');
    findOrCreateTag('history');
    const allTags = (db as ReturnType<typeof createTestDb>['db']).select().from(tags).all();
    const historyTags = allTags.filter((t) => t.name === 'history');
    expect(historyTags).toHaveLength(1);
  });
});

// --- getOrCreateReadwiseSource ---

describe('getOrCreateReadwiseSource', () => {
  beforeEach(() => {
    dbMock.setup();
  });

  it('creates a readwise source on first call', () => {
    const id = getOrCreateReadwiseSource();
    expect(id).toBeTypeOf('number');
    const source = (db as ReturnType<typeof createTestDb>['db'])
      .select()
      .from(sources)
      .where(eq(sources.type, 'readwise'))
      .get();
    expect(source?.name).toBe('Readwise Import');
    expect(source?.type).toBe('readwise');
  });

  it('returns the same id on subsequent calls', () => {
    const id1 = getOrCreateReadwiseSource();
    const id2 = getOrCreateReadwiseSource();
    expect(id1).toBe(id2);
  });
});

// --- runReadwiseImport ---

describe('runReadwiseImport', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    dbMock.setup();
    mockGetSetting.mockReturnValue(null);
    mockLinkHighlightTags.mockClear();
    mockReplaceHighlightTags.mockClear();
  });

  it('imports article and highlight from a single page', async () => {
    const article = makeArticleDoc();
    const highlight = makeHighlightDoc();
    mockFetch([makeListPage([article, highlight])]);

    const events: unknown[] = [];
    await runReadwiseImport('test-token', 'full', (event, data) => {
      events.push({ event, data });
    });

    const testDb = db as ReturnType<typeof createTestDb>['db'];
    const savedArticle = testDb
      .select()
      .from(articles)
      .where(eq(articles.externalId, 'rdr_doc-article-1'))
      .get();
    expect(savedArticle).toBeDefined();
    expect(savedArticle?.title).toBe('Test Article');
    expect(savedArticle?.url).toBe('https://example.com/article');
    expect(savedArticle?.status).toBe('archived');

    const savedHighlight = testDb
      .select()
      .from(highlights)
      .where(eq(highlights.externalId, 'rdr_doc-highlight-1'))
      .get();
    expect(savedHighlight).toBeDefined();
    expect(savedHighlight?.text).toBe('Great insight from the article');

    const completeEvent = events.find((e) => (e as { event: string }).event === 'complete');
    expect((completeEvent as { data: { articles: number } }).data.articles).toBe(1);
    expect((completeEvent as { data: { highlights: number } }).data.highlights).toBe(1);
  });

  it('stores sanitized html_content on the article', async () => {
    mockFetch([
      makeListPage([makeArticleDoc({ html_content: '<p>Hello <script>bad</script></p>' })]),
    ]);
    await runReadwiseImport('test-token', 'full', () => {});

    const testDb = db as ReturnType<typeof createTestDb>['db'];
    const article = testDb
      .select()
      .from(articles)
      .where(eq(articles.externalId, 'rdr_doc-article-1'))
      .get();
    expect(article?.contentHtml).not.toContain('<script>');
    expect(article?.contentHtml).toContain('<p>');
  });

  it('uses source_url as article url, falling back to url', async () => {
    mockFetch([
      makeListPage([
        makeArticleDoc({
          source_url: 'https://original.com/post',
          url: 'https://reader.readwise.io/read/xyz',
        }),
      ]),
    ]);
    await runReadwiseImport('test-token', 'full', () => {});

    const testDb = db as ReturnType<typeof createTestDb>['db'];
    const article = testDb
      .select()
      .from(articles)
      .where(eq(articles.externalId, 'rdr_doc-article-1'))
      .get();
    expect(article?.url).toBe('https://original.com/post');
  });

  it('falls back to reader url when source_url is null', async () => {
    mockFetch([
      makeListPage([
        makeArticleDoc({ source_url: null, url: 'https://reader.readwise.io/read/xyz' }),
      ]),
    ]);
    await runReadwiseImport('test-token', 'full', () => {});

    const testDb = db as ReturnType<typeof createTestDb>['db'];
    const article = testDb
      .select()
      .from(articles)
      .where(eq(articles.externalId, 'rdr_doc-article-1'))
      .get();
    expect(article?.url).toBe('https://reader.readwise.io/read/xyz');
  });

  it('skips non-article, non-highlight documents and counts them as skipped', async () => {
    const book = makeArticleDoc({
      id: 'doc-book-1',
      category: 'book',
      source_url: 'https://book.com',
    });
    const article = makeArticleDoc();
    const highlight = makeHighlightDoc();
    mockFetch([makeListPage([book, article, highlight])]);

    const events: unknown[] = [];
    await runReadwiseImport('test-token', 'full', (event, data) => events.push({ event, data }));

    const testDb = db as ReturnType<typeof createTestDb>['db'];
    expect(testDb.select().from(articles).all()).toHaveLength(1);

    const completeEvent = events.find((e) => (e as { event: string }).event === 'complete')!;
    expect(
      (completeEvent as { data: { skippedNonArticles: number } }).data.skippedNonArticles,
    ).toBe(1);
  });

  it('deduplicates articles by externalId on re-run', async () => {
    const article = makeArticleDoc();
    mockFetch([makeListPage([article])]);
    await runReadwiseImport('test-token', 'full', () => {});

    mockFetch([makeListPage([article])]);
    await runReadwiseImport('test-token', 'full', () => {});

    const testDb = db as ReturnType<typeof createTestDb>['db'];
    expect(testDb.select().from(articles).all()).toHaveLength(1);
  });

  it('deduplicates articles by url when externalId differs', async () => {
    const article1 = makeArticleDoc({ id: 'doc-v1', source_url: 'https://example.com/article' });
    mockFetch([makeListPage([article1])]);
    await runReadwiseImport('test-token', 'full', () => {});

    const article2 = makeArticleDoc({ id: 'doc-v2', source_url: 'https://example.com/article' });
    mockFetch([makeListPage([article2])]);
    await runReadwiseImport('test-token', 'full', () => {});

    const testDb = db as ReturnType<typeof createTestDb>['db'];
    expect(testDb.select().from(articles).all()).toHaveLength(1);
  });

  it('deduplicates highlights by externalId on re-run', async () => {
    const article = makeArticleDoc();
    const highlight = makeHighlightDoc();
    mockFetch([makeListPage([article, highlight])]);
    await runReadwiseImport('test-token', 'full', () => {});

    mockFetch([makeListPage([article, highlight])]);
    await runReadwiseImport('test-token', 'full', () => {});

    const testDb = db as ReturnType<typeof createTestDb>['db'];
    expect(testDb.select().from(highlights).all()).toHaveLength(1);
  });

  it('paginates through multiple pages', async () => {
    const article1 = makeArticleDoc({ id: 'doc-1', source_url: 'https://example.com/1' });
    const highlight1 = makeHighlightDoc({ id: 'hl-1', parent_id: 'doc-1' });
    const article2 = makeArticleDoc({ id: 'doc-2', source_url: 'https://example.com/2' });
    const highlight2 = makeHighlightDoc({ id: 'hl-2', parent_id: 'doc-2' });
    mockFetch([
      makeListPage([article1, highlight1], 'cursor-page-2'),
      makeListPage([article2, highlight2]),
    ]);

    await runReadwiseImport('test-token', 'full', () => {});

    const testDb = db as ReturnType<typeof createTestDb>['db'];
    expect(testDb.select().from(articles).all()).toHaveLength(2);
    expect(testDb.select().from(highlights).all()).toHaveLength(2);
  });

  it('passes updatedAfter for incremental mode', async () => {
    const lastImport = '2024-06-01T00:00:00.000Z';
    mockGetSetting.mockReturnValue(lastImport);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => makeListPage([]),
    } as Response);

    await runReadwiseImport('test-token', 'incremental', () => {});

    const calledUrl = (fetchSpy.mock.calls[0]?.[0] as string) ?? '';
    expect(calledUrl).toContain(`updatedAfter=${encodeURIComponent(lastImport)}`);
  });

  it('requests withHtmlContent=true', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => makeListPage([]),
    } as Response);

    await runReadwiseImport('test-token', 'full', () => {});

    const calledUrl = (fetchSpy.mock.calls[0]?.[0] as string) ?? '';
    expect(calledUrl).toContain('withHtmlContent=true');
  });

  it('saves readwise_last_import after a successful import', async () => {
    mockFetch([makeListPage([])]);
    await runReadwiseImport('test-token', 'full', () => {});
    expect(mockSetSetting).toHaveBeenCalledWith('readwise_last_import', expect.any(String));
  });

  it('creates and links tags from highlight document tags', async () => {
    const article = makeArticleDoc();
    const highlight = makeHighlightDoc({
      tags: { t1: { name: 'philosophy' }, t2: { name: 'ethics' } },
    });
    mockFetch([makeListPage([article, highlight])]);

    await runReadwiseImport('test-token', 'full', () => {});

    expect(mockLinkHighlightTags).toHaveBeenCalledWith(
      expect.any(Number),
      expect.arrayContaining([expect.any(Number), expect.any(Number)]),
    );
  });

  it('uses notes field as highlight note', async () => {
    const article = makeArticleDoc();
    const highlight = makeHighlightDoc({ notes: 'My annotation' });
    mockFetch([makeListPage([article, highlight])]);

    await runReadwiseImport('test-token', 'full', () => {});

    const testDb = db as ReturnType<typeof createTestDb>['db'];
    const saved = testDb
      .select()
      .from(highlights)
      .where(eq(highlights.externalId, 'rdr_doc-highlight-1'))
      .get();
    expect(saved?.note).toBe('My annotation');
  });

  it('links highlights to articles imported in a previous run (incremental)', async () => {
    // First run: import article
    const article = makeArticleDoc();
    mockFetch([makeListPage([article])]);
    await runReadwiseImport('test-token', 'full', () => {});

    // Second run (incremental): only new highlight, article already in DB
    const highlight = makeHighlightDoc({ parent_id: 'doc-article-1' });
    mockFetch([makeListPage([highlight])]);
    await runReadwiseImport('test-token', 'incremental', () => {});

    const testDb = db as ReturnType<typeof createTestDb>['db'];
    expect(testDb.select().from(highlights).all()).toHaveLength(1);
  });

  it('emits fetching and importing progress events', async () => {
    const article = makeArticleDoc();
    const highlight = makeHighlightDoc();
    mockFetch([makeListPage([article, highlight])]);

    const events: unknown[] = [];
    await runReadwiseImport('test-token', 'full', (event, data) => events.push({ event, data }));

    const phases = events
      .filter((e) => (e as { event: string }).event === 'progress')
      .map((e) => (e as { data: { phase: string } }).data.phase);

    expect(phases).toContain('fetching');
    expect(phases).toContain('importing');
    expect(phases).not.toContain('fetching_content');
  });

  it('updates highlight text and note when Reader version is newer', async () => {
    const article = makeArticleDoc();
    const highlight = makeHighlightDoc({ updated_at: '2024-01-01T00:00:00Z' });
    mockFetch([makeListPage([article, highlight])]);
    await runReadwiseImport('test-token', 'full', () => {});

    const newerHighlight = makeHighlightDoc({
      updated_at: '2024-06-01T00:00:00Z',
      content: 'Updated text',
      notes: 'Updated note',
    });
    mockFetch([makeListPage([article, newerHighlight])]);
    await runReadwiseImport('test-token', 'full', () => {});

    const testDb = db as ReturnType<typeof createTestDb>['db'];
    const saved = testDb
      .select()
      .from(highlights)
      .where(eq(highlights.externalId, 'rdr_doc-highlight-1'))
      .get();
    expect(saved?.text).toBe('Updated text');
    expect(saved?.note).toBe('Updated note');
  });
});
