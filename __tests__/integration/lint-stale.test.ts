import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { articles, highlights, theses } from '@/db/schema';
import { runStale } from '@/lib/lint/stale';
import type { LintContext } from '@/lib/lint/types';
import { collect } from './lint-test-utils';

describe('runStale', () => {
  let ctx: LintContext;

  beforeEach(() => {
    const { db, sqlite } = dbMock.setup();
    ctx = { db, rawDb: sqlite };
  });

  describe('stale theses', () => {
    it('surfaces theses not updated in 30+ days', async () => {
      // Fresh thesis — should NOT surface
      ctx.db.insert(theses).values({ title: 'Fresh idea', status: 'developing' }).run();
      // Stale thesis — should surface
      ctx.db
        .insert(theses)
        .values({
          title: 'Forgotten idea',
          status: 'developing',
          updatedAt: sql`datetime('now', '-45 days')`,
        })
        .run();

      const suggestions = await collect(runStale(ctx));
      const staleThesisSuggestions = suggestions.filter(
        (s) => s.type === 'stale' && s.relatedIds.some((r) => r.type === 'thesis'),
      );
      expect(staleThesisSuggestions).toHaveLength(1);
      expect(staleThesisSuggestions[0]!.description).toContain('Forgotten idea');
    });

    it('excludes theses with status=used', async () => {
      ctx.db
        .insert(theses)
        .values({
          title: 'Already cited',
          status: 'used',
          updatedAt: sql`datetime('now', '-90 days')`,
        })
        .run();

      const suggestions = await collect(runStale(ctx));
      const thesisStale = suggestions.filter((s) => s.relatedIds.some((r) => r.type === 'thesis'));
      expect(thesisStale).toHaveLength(0);
    });

    it('includes theses with status=ready that have gone stale', async () => {
      ctx.db
        .insert(theses)
        .values({
          title: 'Ready but forgotten',
          status: 'ready',
          updatedAt: sql`datetime('now', '-60 days')`,
        })
        .run();

      const suggestions = await collect(runStale(ctx));
      const thesisStale = suggestions.filter((s) => s.relatedIds.some((r) => r.type === 'thesis'));
      expect(thesisStale).toHaveLength(1);
      expect(thesisStale[0]!.description).toContain('Ready but forgotten');
    });

    it('caps stale theses at 10 rows', async () => {
      for (let i = 0; i < 15; i++) {
        ctx.db
          .insert(theses)
          .values({
            title: `Stale thesis ${i}`,
            status: 'developing',
            updatedAt: sql`datetime('now', '-60 days')`,
          })
          .run();
      }

      const suggestions = await collect(runStale(ctx));
      const thesisStale = suggestions.filter((s) => s.relatedIds.some((r) => r.type === 'thesis'));
      expect(thesisStale.length).toBeLessThanOrEqual(10);
    });
  });

  describe('stale articles', () => {
    it('surfaces articles in reading status not updated in 14+ days', async () => {
      ctx.db
        .insert(articles)
        .values({
          url: 'https://example.com/stuck',
          title: 'Stuck mid-read',
          status: 'reading',
          updatedAt: sql`datetime('now', '-20 days')`,
        })
        .run();
      ctx.db
        .insert(articles)
        .values({
          url: 'https://example.com/fresh',
          title: 'Freshly opened',
          status: 'reading',
        })
        .run();

      const suggestions = await collect(runStale(ctx));
      const articleStale = suggestions.filter((s) =>
        s.relatedIds.some((r) => r.type === 'article'),
      );
      expect(articleStale).toHaveLength(1);
      expect(articleStale[0]!.description).toContain('Stuck mid-read');
    });

    it('ignores non-reading articles', async () => {
      ctx.db
        .insert(articles)
        .values({
          url: 'https://example.com/archived',
          title: 'Archived old',
          status: 'archived',
          updatedAt: sql`datetime('now', '-90 days')`,
        })
        .run();
      ctx.db
        .insert(articles)
        .values({
          url: 'https://example.com/inbox',
          title: 'Inbox old',
          status: 'inbox',
          updatedAt: sql`datetime('now', '-90 days')`,
        })
        .run();

      const suggestions = await collect(runStale(ctx));
      const articleStale = suggestions.filter((s) =>
        s.relatedIds.some((r) => r.type === 'article'),
      );
      expect(articleStale).toHaveLength(0);
    });
  });

  describe('stale highlights', () => {
    let articleId: number;

    beforeEach(() => {
      const a = ctx.db
        .insert(articles)
        .values({ url: 'https://example.com/hl', title: 'Highlights source' })
        .returning()
        .get()!;
      articleId = a.id;
    });

    it('surfaces highlights with reviewInterval > 30 that are overdue', async () => {
      ctx.db
        .insert(highlights)
        .values({
          articleId,
          text: 'Mature memory gone stale',
          reviewInterval: 60,
          lastReviewed: sql`datetime('now', '-90 days')` as unknown as string,
        })
        .run();

      const suggestions = await collect(runStale(ctx));
      const hlStale = suggestions.filter((s) => s.relatedIds.some((r) => r.type === 'highlight'));
      expect(hlStale).toHaveLength(1);
      expect(hlStale[0]!.description).toContain('Mature memory gone stale');
    });

    it('ignores highlights with reviewInterval <= 30', async () => {
      ctx.db
        .insert(highlights)
        .values({
          articleId,
          text: 'Still learning',
          reviewInterval: 14,
          lastReviewed: sql`datetime('now', '-30 days')` as unknown as string,
        })
        .run();

      const suggestions = await collect(runStale(ctx));
      const hlStale = suggestions.filter((s) => s.relatedIds.some((r) => r.type === 'highlight'));
      expect(hlStale).toHaveLength(0);
    });

    it('ignores mature highlights that are not yet overdue', async () => {
      ctx.db
        .insert(highlights)
        .values({
          articleId,
          text: 'Fresh review',
          reviewInterval: 60,
          lastReviewed: sql`datetime('now', '-1 days')` as unknown as string,
        })
        .run();

      const suggestions = await collect(runStale(ctx));
      const hlStale = suggestions.filter((s) => s.relatedIds.some((r) => r.type === 'highlight'));
      expect(hlStale).toHaveLength(0);
    });
  });

  describe('empty database', () => {
    it('yields no suggestions when nothing is stale', async () => {
      const suggestions = await collect(runStale(ctx));
      expect(suggestions).toHaveLength(0);
    });
  });
});
