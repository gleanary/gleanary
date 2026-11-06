import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- DB Mock ---
const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { db } from '@/db';
import { articles, sources } from '@/db/schema';
import { insertTestArticle } from './setup';
import { eq } from 'drizzle-orm';

describe('reader-view data layer', () => {
  beforeEach(() => {
    dbMock.setup();
  });

  describe('article fetching for reader', () => {
    it('fetches article with content_html for rendering', () => {
      insertTestArticle(db, {
        url: 'https://example.com/article',
        title: 'Test Article',
        contentHtml: '<p>Article content</p>',
        contentText: 'Article content',
        wordCount: 100,
        status: 'inbox',
      });

      const [article] = db.select().from(articles).where(eq(articles.id, 1)).all();

      expect(article).toBeDefined();
      expect(article!.contentHtml).toBe('<p>Article content</p>');
      expect(article!.title).toBe('Test Article');
      expect(article!.wordCount).toBe(100);
    });

    it('returns article with null content_html gracefully', () => {
      insertTestArticle(db, {
        url: 'https://example.com/no-content',
        title: 'No Content Article',
      });

      const [article] = db.select().from(articles).where(eq(articles.id, 1)).all();

      expect(article).toBeDefined();
      expect(article!.contentHtml).toBeNull();
    });

    it('returns undefined for non-existent article', () => {
      const [article] = db.select().from(articles).where(eq(articles.id, 999)).all();
      expect(article).toBeUndefined();
    });
  });

  describe('reading progress updates', () => {
    it('updates reading progress via PATCH fields', () => {
      insertTestArticle(db, {
        url: 'https://example.com/article',
        title: 'Test Article',
        readingProgress: 0,
        status: 'inbox',
      });

      db.update(articles).set({ readingProgress: 0.42 }).where(eq(articles.id, 1)).run();

      const [article] = db.select().from(articles).where(eq(articles.id, 1)).all();
      expect(article!.readingProgress).toBe(0.42);
    });

    it('updates status from inbox to reading', () => {
      insertTestArticle(db, {
        url: 'https://example.com/article',
        title: 'Test Article',
        status: 'inbox',
      });

      db.update(articles).set({ status: 'reading' }).where(eq(articles.id, 1)).run();

      const [article] = db.select().from(articles).where(eq(articles.id, 1)).all();
      expect(article!.status).toBe('reading');
    });

    it('toggles favorite', () => {
      insertTestArticle(db, {
        url: 'https://example.com/article',
        title: 'Test Article',
        isFavorite: false,
      });

      db.update(articles).set({ isFavorite: true }).where(eq(articles.id, 1)).run();

      const [article] = db.select().from(articles).where(eq(articles.id, 1)).all();
      expect(article!.isFavorite).toBe(true);
    });

    it('archives an article', () => {
      insertTestArticle(db, {
        url: 'https://example.com/article',
        title: 'Test Article',
        status: 'reading',
      });

      db.update(articles).set({ status: 'archived' }).where(eq(articles.id, 1)).run();

      const [article] = db.select().from(articles).where(eq(articles.id, 1)).all();
      expect(article!.status).toBe('archived');
    });

    it('unarchives an article back to inbox', () => {
      insertTestArticle(db, {
        url: 'https://example.com/article',
        title: 'Test Article',
        status: 'archived',
      });

      db.update(articles).set({ status: 'inbox' }).where(eq(articles.id, 1)).run();

      const [article] = db.select().from(articles).where(eq(articles.id, 1)).all();
      expect(article!.status).toBe('inbox');
    });

    it('toggles between archived and inbox states', () => {
      insertTestArticle(db, {
        url: 'https://example.com/article',
        title: 'Test Article',
        status: 'inbox',
      });

      // Archive
      db.update(articles).set({ status: 'archived' }).where(eq(articles.id, 1)).run();
      let [article] = db.select().from(articles).where(eq(articles.id, 1)).all();
      expect(article!.status).toBe('archived');

      // Unarchive back to inbox
      db.update(articles).set({ status: 'inbox' }).where(eq(articles.id, 1)).run();
      [article] = db.select().from(articles).where(eq(articles.id, 1)).all();
      expect(article!.status).toBe('inbox');
    });
  });

  describe('article with source', () => {
    it('includes source association for display', () => {
      const sourceId = db
        .insert(sources)
        .values({
          type: 'rss_feed',
          name: 'Tech Blog',
          feedUrl: 'https://techblog.com/feed.xml',
        })
        .returning()
        .get()!.id;

      insertTestArticle(db, {
        url: 'https://techblog.com/article',
        title: 'Tech Article',
        siteName: 'Tech Blog',
        sourceId,
        status: 'inbox',
      });

      const [article] = db.select().from(articles).where(eq(articles.id, 1)).all();
      expect(article!.sourceId).toBe(sourceId);
      expect(article!.siteName).toBe('Tech Blog');
    });
  });
});
