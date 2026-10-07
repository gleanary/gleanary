import { describe, it, expect, beforeEach, vi } from 'vitest';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import {
  getArticleOrThrow,
  getHighlightOrThrow,
  getSourceOrThrow,
  getThesisOrThrow,
  getChatSessionOrThrow,
  getDraftOrThrow,
  assertHighlightsExist,
  assertHighlightsBelongToThesis,
  assertResearchBelongToThesis,
  getThesisDetail,
  getDraftSummaries,
  getDraftsForThesis,
  toChatMessageDisplay,
  autoAdvanceThesisOnResearch,
  articlesBySourceType,
  articlesExcludingSourceType,
} from '@/lib/db-helpers';
import { NotFoundError, ValidationError } from '@/lib/errors';
import {
  articles,
  sources,
  highlights,
  theses,
  thesisHighlights,
  thesisResearch,
  chatSessions,
  drafts,
} from '@/db/schema';
import type { ChatMessage, ThesisStatus } from '@/types';

function db() {
  return dbMock.mock.db!;
}

// --- Seed helpers ---

let urlCounter = 0;

function seedArticle(overrides: Partial<typeof articles.$inferInsert> = {}) {
  urlCounter += 1;
  const [row] = db()
    .insert(articles)
    .values({ url: `https://example.com/a-${urlCounter}`, title: 'Seed article', ...overrides })
    .returning()
    .all();
  return row!;
}

function seedSource(overrides: Partial<typeof sources.$inferInsert> = {}) {
  const [row] = db()
    .insert(sources)
    .values({ type: 'rss_feed', name: 'Seed source', ...overrides })
    .returning()
    .all();
  return row!;
}

function seedHighlight(articleId: number, text = 'Seed highlight') {
  const [row] = db().insert(highlights).values({ articleId, text }).returning().all();
  return row!;
}

function seedThesis(overrides: Partial<typeof theses.$inferInsert> = {}) {
  const [row] = db()
    .insert(theses)
    .values({ title: 'Seed thesis', ...overrides })
    .returning()
    .all();
  return row!;
}

beforeEach(() => {
  dbMock.setup();
});

// =============================================================================
// Fetch-or-throw helpers
// =============================================================================

describe('get*OrThrow helpers', () => {
  it('getArticleOrThrow returns the full row when the article exists', () => {
    const article = seedArticle({ title: 'Found me' });

    const result = getArticleOrThrow(article.id);

    expect(result.id).toBe(article.id);
    expect(result.title).toBe('Found me');
  });

  it('getArticleOrThrow throws NotFoundError with the id for a missing article', () => {
    const act = () => getArticleOrThrow(999);

    expect(act).toThrow(NotFoundError);
    expect(act).toThrow('Article with id 999 not found');
  });

  it('getHighlightOrThrow returns the row when found and throws NotFoundError otherwise', () => {
    const article = seedArticle();
    const highlight = seedHighlight(article.id, 'A highlight');

    expect(getHighlightOrThrow(highlight.id).text).toBe('A highlight');
    expect(() => getHighlightOrThrow(999)).toThrow(NotFoundError);
  });

  it('getSourceOrThrow returns the row when found and throws NotFoundError otherwise', () => {
    const source = seedSource({ name: 'My feed' });

    expect(getSourceOrThrow(source.id).name).toBe('My feed');
    expect(() => getSourceOrThrow(999)).toThrow(NotFoundError);
  });

  it('getThesisOrThrow returns the row when found and throws NotFoundError otherwise', () => {
    const thesis = seedThesis({ title: 'My thesis' });

    expect(getThesisOrThrow(thesis.id).title).toBe('My thesis');
    expect(() => getThesisOrThrow(999)).toThrow(NotFoundError);
  });

  it('getChatSessionOrThrow returns the row when found and throws NotFoundError otherwise', () => {
    const [session] = db().insert(chatSessions).values({}).returning().all();

    expect(getChatSessionOrThrow(session!.id).title).toBe('New chat');
    expect(() => getChatSessionOrThrow(999)).toThrow('Chat session with id 999 not found');
  });

  it('getDraftOrThrow returns the row when found and throws NotFoundError otherwise', () => {
    const thesis = seedThesis();
    const [draft] = db()
      .insert(drafts)
      .values({ thesisId: thesis.id, templateId: 'blog', title: 'My draft' })
      .returning()
      .all();

    expect(getDraftOrThrow(draft!.id).title).toBe('My draft');
    expect(() => getDraftOrThrow(999)).toThrow(NotFoundError);
  });
});

// =============================================================================
// Membership assertions
// =============================================================================

describe('assertHighlightsExist', () => {
  it('is a no-op for an empty id list', () => {
    expect(() => assertHighlightsExist([])).not.toThrow();
  });

  it('passes when every id exists', () => {
    const article = seedArticle();
    const h1 = seedHighlight(article.id);
    const h2 = seedHighlight(article.id);

    expect(() => assertHighlightsExist([h1.id, h2.id])).not.toThrow();
  });

  it('throws NotFoundError naming the first missing id', () => {
    const article = seedArticle();
    const h1 = seedHighlight(article.id);

    expect(() => assertHighlightsExist([h1.id, 998, 999])).toThrow(
      'Highlight with id 998 not found',
    );
  });
});

describe('assertHighlightsBelongToThesis', () => {
  it('is a no-op for an empty id list', () => {
    expect(() => assertHighlightsBelongToThesis(1, [])).not.toThrow();
  });

  it('passes when every highlight is linked to the thesis', () => {
    const article = seedArticle();
    const thesis = seedThesis();
    const h1 = seedHighlight(article.id);
    db()
      .insert(thesisHighlights)
      .values({ thesisId: thesis.id, highlightId: h1.id, role: 'supporting' })
      .run();

    expect(() => assertHighlightsBelongToThesis(thesis.id, [h1.id])).not.toThrow();
  });

  it('throws ValidationError naming the first unlinked highlight', () => {
    const article = seedArticle();
    const thesis = seedThesis();
    const linked = seedHighlight(article.id);
    const unlinked = seedHighlight(article.id);
    db()
      .insert(thesisHighlights)
      .values({ thesisId: thesis.id, highlightId: linked.id, role: 'supporting' })
      .run();

    const act = () => assertHighlightsBelongToThesis(thesis.id, [linked.id, unlinked.id]);

    expect(act).toThrow(ValidationError);
    expect(act).toThrow(`Highlight ${unlinked.id} does not belong to thesis ${thesis.id}`);
  });
});

describe('assertResearchBelongToThesis', () => {
  it('is a no-op for an empty id list', () => {
    expect(() => assertResearchBelongToThesis(1, [])).not.toThrow();
  });

  it('passes when every research entry belongs to the thesis', () => {
    const thesis = seedThesis();
    const [research] = db()
      .insert(thesisResearch)
      .values({ thesisId: thesis.id, title: 'R1', content: 'Body.' })
      .returning()
      .all();

    expect(() => assertResearchBelongToThesis(thesis.id, [research!.id])).not.toThrow();
  });

  it('throws ValidationError when a research entry belongs to another thesis', () => {
    const thesisA = seedThesis();
    const thesisB = seedThesis();
    const [research] = db()
      .insert(thesisResearch)
      .values({ thesisId: thesisB.id, title: 'R1', content: 'Body.' })
      .returning()
      .all();

    expect(() => assertResearchBelongToThesis(thesisA.id, [research!.id])).toThrow(
      `Research ${research!.id} does not belong to thesis ${thesisA.id}`,
    );
  });
});

// =============================================================================
// getThesisDetail
// =============================================================================

describe('getThesisDetail', () => {
  it('returns null when the thesis does not exist', () => {
    expect(getThesisDetail(999)).toBeNull();
  });

  it('returns the thesis with linked highlights (incl. article info) and research summaries', () => {
    const article = seedArticle({ title: 'Article title', siteName: 'Example Site' });
    const thesis = seedThesis({ title: 'Detailed thesis' });
    const highlight = seedHighlight(article.id, 'Linked text');
    db()
      .insert(thesisHighlights)
      .values({ thesisId: thesis.id, highlightId: highlight.id, role: 'opposing', note: 'why' })
      .run();
    db()
      .insert(thesisResearch)
      .values({ thesisId: thesis.id, title: 'R1', content: 'three word body', source: 'manual' })
      .run();

    const detail = getThesisDetail(thesis.id);

    expect(detail).not.toBeNull();
    expect(detail!.thesis.title).toBe('Detailed thesis');
    expect(detail!.highlights).toHaveLength(1);
    expect(detail!.highlights[0]).toMatchObject({
      id: highlight.id,
      text: 'Linked text',
      role: 'opposing',
      linkNote: 'why',
      article: { id: article.id, title: 'Article title', siteName: 'Example Site' },
    });
    expect(detail!.research).toHaveLength(1);
    expect(detail!.research[0]).toMatchObject({ title: 'R1', source: 'manual', wordCount: 3 });
  });

  it('excludes highlights and research linked to other theses', () => {
    const article = seedArticle();
    const thesis = seedThesis();
    const other = seedThesis();
    const highlight = seedHighlight(article.id);
    db()
      .insert(thesisHighlights)
      .values({ thesisId: other.id, highlightId: highlight.id, role: 'context' })
      .run();
    db().insert(thesisResearch).values({ thesisId: other.id, title: 'R', content: 'x' }).run();

    const detail = getThesisDetail(thesis.id);

    expect(detail!.highlights).toHaveLength(0);
    expect(detail!.research).toHaveLength(0);
  });
});

// =============================================================================
// Draft summaries
// =============================================================================

describe('getDraftSummaries / getDraftsForThesis', () => {
  it('lists all drafts with thesis title and without the content field', () => {
    const thesis = seedThesis({ title: 'Parent thesis' });
    db()
      .insert(drafts)
      .values({ thesisId: thesis.id, templateId: 'blog', title: 'D1', content: 'BIG BODY' })
      .run();

    const summaries = getDraftSummaries();

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ title: 'D1', thesisTitle: 'Parent thesis' });
    expect(summaries[0]).not.toHaveProperty('content');
  });

  it('filters to one thesis when thesisId is provided, newest created first', () => {
    const thesisA = seedThesis();
    const thesisB = seedThesis();
    db()
      .insert(drafts)
      .values([
        {
          thesisId: thesisA.id,
          templateId: 'blog',
          title: 'A-old',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          thesisId: thesisA.id,
          templateId: 'linkedin',
          title: 'A-new',
          createdAt: '2026-02-01T00:00:00.000Z',
        },
        { thesisId: thesisB.id, templateId: 'blog', title: 'B-only' },
      ])
      .run();

    const forA = getDraftsForThesis(thesisA.id);

    expect(forA.map((d) => d.title)).toEqual(['A-new', 'A-old']);
  });
});

// =============================================================================
// toChatMessageDisplay (pure transform)
// =============================================================================

describe('toChatMessageDisplay', () => {
  function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
      id: 1,
      sessionId: 1,
      role: 'assistant',
      content: 'Hello',
      citations: null,
      contextTokens: null,
      bookmarkedAt: null,
      createdAt: '2026-04-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('parses the citations JSON string into an array', () => {
    const citations = [{ articleId: 1, title: 'Cited', quote: 'q' }];
    const display = toChatMessageDisplay(makeMessage({ citations: JSON.stringify(citations) }));

    expect(display.citations).toEqual(citations);
  });

  it('maps null citations to an empty array and preserves scalar fields', () => {
    const display = toChatMessageDisplay(makeMessage({ bookmarkedAt: undefined }));

    expect(display).toEqual({
      id: 1,
      role: 'assistant',
      content: 'Hello',
      citations: [],
      createdAt: '2026-04-01T00:00:00.000Z',
      bookmarkedAt: null,
    });
  });
});

// =============================================================================
// autoAdvanceThesisOnResearch
// =============================================================================

describe('autoAdvanceThesisOnResearch', () => {
  it('advances a developing thesis to researched', () => {
    const thesis = seedThesis({ status: 'developing' });

    autoAdvanceThesisOnResearch(thesis.id, 'developing');

    expect(getThesisOrThrow(thesis.id).status).toBe('researched');
  });

  it.each(['nascent', 'researched', 'ready', 'used'] satisfies ThesisStatus[])(
    'is a no-op when the current status is %s',
    (status) => {
      const thesis = seedThesis({ status });

      autoAdvanceThesisOnResearch(thesis.id, status);

      expect(getThesisOrThrow(thesis.id).status).toBe(status);
    },
  );
});

// =============================================================================
// Source-type subquery builders
// =============================================================================

describe('articlesBySourceType / articlesExcludingSourceType', () => {
  beforeEach(() => {
    const rss = seedSource({ type: 'rss_feed' });
    const newsletter = seedSource({ type: 'newsletter' });
    seedArticle({ sourceId: rss.id, title: 'From RSS' });
    seedArticle({ sourceId: newsletter.id, title: 'From newsletter' });
    seedArticle({ title: 'No source' });
  });

  it('articlesBySourceType matches only articles whose source has the given type', () => {
    const rows = db().select().from(articles).where(articlesBySourceType('rss_feed')).all();

    expect(rows.map((a) => a.title)).toEqual(['From RSS']);
  });

  it('articlesExcludingSourceType keeps other source types and NULL-source articles', () => {
    const rows = db()
      .select()
      .from(articles)
      .where(articlesExcludingSourceType('newsletter'))
      .all();

    expect(rows.map((a) => a.title).sort()).toEqual(['From RSS', 'No source']);
  });
});
