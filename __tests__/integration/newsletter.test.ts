import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- DB Mock ---
const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

// Mock logger
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock newsletter-poller
const mockPollNewsletters = vi.fn();
vi.mock('@/lib/newsletter-poller', () => ({
  pollNewsletters: (...args: unknown[]) => mockPollNewsletters(...args),
}));

import { createTestDb } from './setup';
import { db } from '@/db';
import { sources, articles } from '@/db/schema';
import { NextRequest } from 'next/server';

// Import route handlers after mocks
import { GET } from '@/app/api/newsletters/route';
import { POST } from '@/app/api/newsletters/poll/route';
import { PATCH } from '@/app/api/newsletters/[id]/route';

function createRequest(method: string, url: string, body?: unknown): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
      : {}),
  });
}

describe('Newsletter API routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.setup();
  });

  describe('GET /api/newsletters', () => {
    it('returns empty list when no newsletter sources exist', async () => {
      const req = createRequest('GET', '/api/newsletters');
      const res = await GET(req);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.newsletters).toEqual([]);
      expect(data.pendingCount).toBe(0);
    });

    it('returns newsletter sources with article counts and status', async () => {
      (db as ReturnType<typeof createTestDb>['db'])
        .insert(sources)
        .values({
          type: 'newsletter',
          name: 'Test Newsletter',
          senderAddress: 'test@example.com',
          isBlocked: false,
          lastReceivedAt: '2026-03-10T08:00:00Z',
        })
        .run();

      const req = createRequest('GET', '/api/newsletters');
      const res = await GET(req);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.newsletters).toHaveLength(1);
      expect(data.newsletters[0].name).toBe('Test Newsletter');
      expect(data.newsletters[0].senderAddress).toBe('test@example.com');
      expect(data.newsletters[0].isBlocked).toBe(false);
      expect(data.newsletters[0].status).toBe('approved');
    });

    it('returns pending status for sources with isBlocked=null', async () => {
      (db as ReturnType<typeof createTestDb>['db'])
        .insert(sources)
        .values({
          type: 'newsletter',
          name: 'New Sender',
          senderAddress: 'new@example.com',
        })
        .run();

      const req = createRequest('GET', '/api/newsletters');
      const res = await GET(req);
      const data = await res.json();

      expect(data.newsletters[0].status).toBe('pending');
      expect(data.pendingCount).toBe(1);
    });

    it('filters by status query param', async () => {
      (db as ReturnType<typeof createTestDb>['db'])
        .insert(sources)
        .values([
          { type: 'newsletter' as const, name: 'Pending', senderAddress: 'p@x.com' },
          {
            type: 'newsletter' as const,
            name: 'Approved',
            senderAddress: 'a@x.com',
            isBlocked: false,
          },
          {
            type: 'newsletter' as const,
            name: 'Blocked',
            senderAddress: 'b@x.com',
            isBlocked: true,
          },
        ])
        .run();

      const reqPending = createRequest('GET', '/api/newsletters?status=pending');
      const pending = await (await GET(reqPending)).json();
      expect(pending.newsletters).toHaveLength(1);
      expect(pending.newsletters[0].name).toBe('Pending');

      const reqApproved = createRequest('GET', '/api/newsletters?status=approved');
      const approved = await (await GET(reqApproved)).json();
      expect(approved.newsletters).toHaveLength(1);
      expect(approved.newsletters[0].name).toBe('Approved');

      const reqBlocked = createRequest('GET', '/api/newsletters?status=blocked');
      const blocked = await (await GET(reqBlocked)).json();
      expect(blocked.newsletters).toHaveLength(1);
      expect(blocked.newsletters[0].name).toBe('Blocked');
    });

    it('only returns newsletter-type sources', async () => {
      (db as ReturnType<typeof createTestDb>['db'])
        .insert(sources)
        .values({
          type: 'rss_feed',
          name: 'RSS Feed',
          feedUrl: 'https://example.com/feed.xml',
        })
        .run();

      (db as ReturnType<typeof createTestDb>['db'])
        .insert(sources)
        .values({
          type: 'newsletter',
          name: 'Newsletter',
          senderAddress: 'news@example.com',
        })
        .run();

      const req = createRequest('GET', '/api/newsletters');
      const res = await GET(req);
      const data = await res.json();

      expect(data.newsletters).toHaveLength(1);
      expect(data.newsletters[0].name).toBe('Newsletter');
    });
  });

  describe('POST /api/newsletters/poll', () => {
    it('triggers newsletter polling and returns results', async () => {
      mockPollNewsletters.mockResolvedValue({
        newArticles: 3,
        skipped: 1,
        errors: [],
      });

      const req = createRequest('POST', '/api/newsletters/poll');
      const res = await POST(req);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.polled).toBe(true);
      expect(data.newArticles).toBe(3);
      expect(data.errors).toEqual([]);
      expect(mockPollNewsletters).toHaveBeenCalledTimes(1);
    });

    it('returns errors from the poller', async () => {
      mockPollNewsletters.mockResolvedValue({
        newArticles: 0,
        skipped: 0,
        errors: ['IMAP connection failed'],
      });

      const req = createRequest('POST', '/api/newsletters/poll');
      const res = await POST(req);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.polled).toBe(true);
      expect(data.errors).toEqual(['IMAP connection failed']);
    });
  });

  describe('PATCH /api/newsletters/[id]', () => {
    it('approves a pending sender and moves articles to inbox', async () => {
      // Create pending source with a pending_review article
      (db as ReturnType<typeof createTestDb>['db'])
        .insert(sources)
        .values({
          type: 'newsletter',
          name: 'Pending Newsletter',
          senderAddress: 'pending@example.com',
        })
        .run();

      (db as ReturnType<typeof createTestDb>['db'])
        .insert(articles)
        .values({
          url: 'newsletter://test',
          title: 'Pending Article',
          sourceId: 1,
          status: 'pending_review',
        })
        .run();

      const req = createRequest('PATCH', '/api/newsletters/1', { isBlocked: false });
      const res = await PATCH(req, { params: Promise.resolve({ id: '1' }) });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.source.isBlocked).toBe(false);

      // Verify article moved to inbox
      const savedArticles = (db as ReturnType<typeof createTestDb>['db'])
        .select()
        .from(articles)
        .all();
      expect(savedArticles[0]!.status).toBe('inbox');
    });

    it('blocks a pending sender and deletes their articles', async () => {
      // Create pending source with an article
      (db as ReturnType<typeof createTestDb>['db'])
        .insert(sources)
        .values({
          type: 'newsletter',
          name: 'Spam Newsletter',
          senderAddress: 'spam@example.com',
        })
        .run();

      (db as ReturnType<typeof createTestDb>['db'])
        .insert(articles)
        .values({
          url: 'newsletter://spam',
          title: 'Spam Article',
          sourceId: 1,
          status: 'pending_review',
        })
        .run();

      const req = createRequest('PATCH', '/api/newsletters/1', { isBlocked: true });
      const res = await PATCH(req, { params: Promise.resolve({ id: '1' }) });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.source.isBlocked).toBe(true);

      // Verify article was deleted
      const savedArticles = (db as ReturnType<typeof createTestDb>['db'])
        .select()
        .from(articles)
        .all();
      expect(savedArticles).toHaveLength(0);
    });

    it('blocks an approved newsletter source', async () => {
      (db as ReturnType<typeof createTestDb>['db'])
        .insert(sources)
        .values({
          type: 'newsletter',
          name: 'Test Newsletter',
          senderAddress: 'test@example.com',
          isBlocked: false,
        })
        .run();

      const req = createRequest('PATCH', '/api/newsletters/1', { isBlocked: true });
      const res = await PATCH(req, { params: Promise.resolve({ id: '1' }) });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.source.isBlocked).toBe(true);
    });

    it('unblocks a blocked newsletter source', async () => {
      (db as ReturnType<typeof createTestDb>['db'])
        .insert(sources)
        .values({
          type: 'newsletter',
          name: 'Test Newsletter',
          senderAddress: 'test@example.com',
          isBlocked: true,
        })
        .run();

      const req = createRequest('PATCH', '/api/newsletters/1', { isBlocked: false });
      const res = await PATCH(req, { params: Promise.resolve({ id: '1' }) });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.source.isBlocked).toBe(false);
    });

    it('returns 404 for non-existent source', async () => {
      const req = createRequest('PATCH', '/api/newsletters/999', { isBlocked: true });
      const res = await PATCH(req, { params: Promise.resolve({ id: '999' }) });

      expect(res.status).toBe(404);
    });

    it('returns 422 for invalid body', async () => {
      (db as ReturnType<typeof createTestDb>['db'])
        .insert(sources)
        .values({
          type: 'newsletter',
          name: 'Test Newsletter',
          senderAddress: 'test@example.com',
        })
        .run();

      const req = createRequest('PATCH', '/api/newsletters/1', { invalid: 'field' });
      const res = await PATCH(req, { params: Promise.resolve({ id: '1' }) });

      expect(res.status).toBe(422);
    });

    it('returns 422 when trying to patch a non-newsletter source', async () => {
      (db as ReturnType<typeof createTestDb>['db'])
        .insert(sources)
        .values({
          type: 'rss_feed',
          name: 'RSS Feed',
          feedUrl: 'https://example.com/feed.xml',
        })
        .run();

      const req = createRequest('PATCH', '/api/newsletters/1', { isBlocked: true });
      const res = await PATCH(req, { params: Promise.resolve({ id: '1' }) });

      expect(res.status).toBe(422);
    });
  });
});
