import { describe, it, expect } from 'vitest';
import {
  idParamSchema,
  createArticleSchema,
  updateArticleSchema,
  listArticlesSchema,
  createHighlightSchema,
  updateHighlightSchema,
  createSourceSchema,
  createTagSchema,
  searchSchema,
  createDraftSchema,
  updateDraftSchema,
  generateDraftSchema,
} from '@/lib/validators';

describe('idParamSchema', () => {
  it('coerces string to positive integer', () => {
    expect(idParamSchema.parse({ id: '42' })).toEqual({ id: 42 });
  });

  it('rejects zero', () => {
    expect(() => idParamSchema.parse({ id: '0' })).toThrow();
  });

  it('rejects negative numbers', () => {
    expect(() => idParamSchema.parse({ id: '-1' })).toThrow();
  });

  it('rejects non-numeric strings', () => {
    expect(() => idParamSchema.parse({ id: 'abc' })).toThrow();
  });
});

describe('createArticleSchema', () => {
  it('accepts valid article data', () => {
    const result = createArticleSchema.parse({
      url: 'https://example.com/article',
      title: 'Test Article',
    });
    expect(result.url).toBe('https://example.com/article');
    expect(result.status).toBe('inbox');
  });

  it('rejects missing url', () => {
    expect(() => createArticleSchema.parse({ title: 'No URL' })).toThrow();
  });

  it('rejects invalid url', () => {
    expect(() => createArticleSchema.parse({ url: 'not-a-url', title: 'Bad' })).toThrow();
  });

  it('rejects empty title', () => {
    expect(() => createArticleSchema.parse({ url: 'https://example.com', title: '' })).toThrow();
  });

  it('accepts all optional fields', () => {
    const result = createArticleSchema.parse({
      url: 'https://example.com/full',
      title: 'Full Article',
      author: 'Author',
      contentHtml: '<p>Content</p>',
      contentText: 'Content',
      excerpt: 'An excerpt',
      siteName: 'Site',
      imageUrl: 'https://img.example.com/pic.jpg',
      wordCount: 100,
      sourceId: 1,
      publishedAt: '2025-01-01T00:00:00Z',
      status: 'reading',
    });
    expect(result.wordCount).toBe(100);
    expect(result.status).toBe('reading');
  });
});

describe('updateArticleSchema', () => {
  it('accepts partial update with archived status', () => {
    const result = updateArticleSchema.parse({ status: 'archived' });
    expect(result.status).toBe('archived');
  });

  it('rejects status=read', () => {
    expect(() => updateArticleSchema.parse({ status: 'read' })).toThrow();
  });

  it('rejects empty object', () => {
    expect(() => updateArticleSchema.parse({})).toThrow();
  });

  it('rejects reading progress > 1', () => {
    expect(() => updateArticleSchema.parse({ readingProgress: 1.5 })).toThrow();
  });

  it('rejects reading progress < 0', () => {
    expect(() => updateArticleSchema.parse({ readingProgress: -0.1 })).toThrow();
  });

  it('accepts reading progress at boundaries', () => {
    expect(updateArticleSchema.parse({ readingProgress: 0 })).toBeDefined();
    expect(updateArticleSchema.parse({ readingProgress: 1 })).toBeDefined();
  });
});

describe('listArticlesSchema', () => {
  it('provides defaults', () => {
    const result = listArticlesSchema.parse({});
    expect(result.sort).toBe('savedAt');
    expect(result.order).toBe('desc');
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
  });

  it('coerces string limit to number', () => {
    const result = listArticlesSchema.parse({ limit: '10' });
    expect(result.limit).toBe(10);
  });

  it('rejects limit > 200', () => {
    expect(() => listArticlesSchema.parse({ limit: '201' })).toThrow();
  });
});

describe('createHighlightSchema', () => {
  it('accepts valid highlight data', () => {
    const result = createHighlightSchema.parse({
      articleId: 1,
      text: 'Highlighted text',
    });
    expect(result.color).toBe('yellow');
  });

  it('rejects non-positive articleId', () => {
    expect(() => createHighlightSchema.parse({ articleId: 0, text: 'Test' })).toThrow();
  });

  it('accepts tagIds array', () => {
    const result = createHighlightSchema.parse({
      articleId: 1,
      text: 'Test',
      tagIds: [1, 2, 3],
    });
    expect(result.tagIds).toEqual([1, 2, 3]);
  });
});

describe('updateHighlightSchema', () => {
  it('accepts partial update', () => {
    const result = updateHighlightSchema.parse({ note: 'New note' });
    expect(result.note).toBe('New note');
  });

  it('rejects empty object', () => {
    expect(() => updateHighlightSchema.parse({})).toThrow();
  });
});

describe('createSourceSchema', () => {
  it('requires feedUrl for rss_feed type', () => {
    expect(() => createSourceSchema.parse({ type: 'rss_feed', name: 'No URL' })).toThrow();
  });

  it('allows missing feedUrl for manual type', () => {
    const result = createSourceSchema.parse({ type: 'manual', name: 'Manual' });
    expect(result.pollInterval).toBe(30);
  });

  it('accepts rss_feed with feedUrl', () => {
    const result = createSourceSchema.parse({
      type: 'rss_feed',
      name: 'Feed',
      feedUrl: 'https://example.com/feed.xml',
    });
    expect(result.feedUrl).toBe('https://example.com/feed.xml');
  });
});

describe('createTagSchema', () => {
  it('accepts valid tag', () => {
    const result = createTagSchema.parse({ name: 'important' });
    expect(result.name).toBe('important');
  });

  it('accepts hex color', () => {
    const result = createTagSchema.parse({ name: 'test', color: '#FF5733' });
    expect(result.color).toBe('#FF5733');
  });

  it('rejects non-hex color', () => {
    expect(() => createTagSchema.parse({ name: 'test', color: 'red' })).toThrow();
  });

  it('rejects empty name', () => {
    expect(() => createTagSchema.parse({ name: '' })).toThrow();
  });
});

describe('searchSchema', () => {
  it('provides defaults', () => {
    const result = searchSchema.parse({ q: 'te' });
    expect(result.types).toEqual(['article', 'highlight', 'thesis', 'draft']);
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(0);
    expect(result.mode).toBe('full');
  });

  it('rejects query shorter than 2 chars', () => {
    expect(() => searchSchema.parse({ q: 'x' })).toThrow();
    expect(() => searchSchema.parse({ q: '' })).toThrow();
  });

  it('parses types CSV', () => {
    const result = searchSchema.parse({ q: 'te', types: 'article,draft' });
    expect(result.types).toEqual(['article', 'draft']);
  });

  it('rejects invalid type in types CSV', () => {
    expect(() => searchSchema.parse({ q: 'te', types: 'article,bogus' })).toThrow();
  });
});

describe('createDraftSchema', () => {
  const valid = {
    thesisId: 1,
    templateId: 'blog',
    includedHighlightIds: [1, 2],
    includedResearchIds: [3],
  };

  it('accepts valid input', () => {
    const result = createDraftSchema.parse(valid);
    expect(result.thesisId).toBe(1);
    expect(result.templateId).toBe('blog');
  });

  it('accepts optional angle', () => {
    const result = createDraftSchema.parse({ ...valid, angle: 'Lead with the contrarian take' });
    expect(result.angle).toBe('Lead with the contrarian take');
  });

  it('rejects missing thesisId', () => {
    expect(() => createDraftSchema.parse({ ...valid, thesisId: undefined })).toThrow();
  });

  it('rejects missing includedHighlightIds', () => {
    const { includedHighlightIds: _, ...rest } = valid;
    expect(() => createDraftSchema.parse(rest)).toThrow();
  });

  it('rejects invalid templateId', () => {
    expect(() => createDraftSchema.parse({ ...valid, templateId: 'newsletter' })).toThrow();
  });

  it('rejects angle over 500 chars', () => {
    expect(() => createDraftSchema.parse({ ...valid, angle: 'a'.repeat(501) })).toThrow();
  });

  it('rejects more than 100 highlight ids', () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    expect(() => createDraftSchema.parse({ ...valid, includedHighlightIds: ids })).toThrow();
  });

  it('rejects more than 50 research ids', () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1);
    expect(() => createDraftSchema.parse({ ...valid, includedResearchIds: ids })).toThrow();
  });
});

describe('updateDraftSchema', () => {
  it('accepts a partial update with title only', () => {
    const result = updateDraftSchema.parse({ title: 'New title' });
    expect(result.title).toBe('New title');
  });

  it('accepts status change to published', () => {
    const result = updateDraftSchema.parse({ status: 'published' });
    expect(result.status).toBe('published');
  });

  it('accepts nullable angle to clear it', () => {
    const result = updateDraftSchema.parse({ angle: null });
    expect(result.angle).toBeNull();
  });

  it('rejects empty object (no fields provided)', () => {
    expect(() => updateDraftSchema.parse({})).toThrow();
  });

  it('rejects title over 300 chars', () => {
    expect(() => updateDraftSchema.parse({ title: 'a'.repeat(301) })).toThrow();
  });

  it('rejects content over 50 000 chars', () => {
    expect(() => updateDraftSchema.parse({ content: 'a'.repeat(50001) })).toThrow();
  });
});

describe('generateDraftSchema', () => {
  it('defaults force to false', () => {
    const result = generateDraftSchema.parse({});
    expect(result.force).toBe(false);
  });

  it('accepts force: true', () => {
    const result = generateDraftSchema.parse({ force: true });
    expect(result.force).toBe(true);
  });

  it('rejects non-boolean force', () => {
    expect(() => generateDraftSchema.parse({ force: 'yes' })).toThrow();
  });
});
