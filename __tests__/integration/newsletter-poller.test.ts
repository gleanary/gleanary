import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  validNewsletterEmail,
  plainTextOnlyEmail,
  largeEmail,
  multiRecipientEmail,
} from '../mocks/fixtures/newsletter-emails';

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

// Mock imapflow — we test the processing logic, not IMAP protocol
const mockFetchOne = vi.fn();
const mockMessageFlagsAdd = vi.fn();
const mockMailboxOpen = vi.fn();
const mockConnect = vi.fn();
const mockLogout = vi.fn();
vi.mock('imapflow', () => ({
  ImapFlow: vi.fn().mockImplementation(function () {
    return {
      on: vi.fn(),
      connect: mockConnect,
      logout: mockLogout,
      mailboxOpen: mockMailboxOpen,
      search: vi.fn().mockResolvedValue([1]),
      fetchOne: mockFetchOne,
      messageFlagsAdd: mockMessageFlagsAdd,
    };
  }),
}));

// Mock mailparser
const mockSimpleParser = vi.fn();
vi.mock('mailparser', () => ({
  simpleParser: (...args: unknown[]) => mockSimpleParser(...args),
}));

import { createTestDb } from './setup';
import { db } from '@/db';
import { sources, articles } from '@/db/schema';
import { pollNewsletters } from '@/lib/newsletter-poller';
import { setSetting, clearSettingsCache } from '@/lib/settings';

describe('newsletter-poller', () => {
  beforeAll(() => {
    // No MSW needed — we mock IMAP directly
  });

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.setup();

    // Set up IMAP configuration in the test database
    setSetting('imap_host', 'imap.example.com', { encrypted: false });
    setSetting('imap_user', 'user@example.com', { encrypted: false });
    setSetting('imap_password', 'password123', { encrypted: false });
    setSetting('imap_port', '993', { encrypted: false });
    setSetting('imap_tls', 'true', { encrypted: false });
    setSetting('imap_mailbox', 'INBOX', { encrypted: false });
    clearSettingsCache();

    // Reset IMAP mocks to defaults (clearAllMocks doesn't reset implementations)
    mockConnect.mockResolvedValue(undefined);
    mockLogout.mockResolvedValue(undefined);
    mockMailboxOpen.mockResolvedValue(undefined);
    mockMessageFlagsAdd.mockResolvedValue(undefined);

    // Default: fetchOne returns a single message
    mockFetchOne.mockResolvedValue({ uid: 1, source: Buffer.from('raw email bytes'), size: 100 });
  });

  it('creates new source with pending status (isBlocked=null) for unknown sender', async () => {
    mockSimpleParser.mockResolvedValue(validNewsletterEmail);

    await pollNewsletters();

    const savedSources = (db as ReturnType<typeof createTestDb>['db']).select().from(sources).all();
    expect(savedSources).toHaveLength(1);
    expect(savedSources[0]!.type).toBe('newsletter');
    expect(savedSources[0]!.name).toBe('Ben Thompson');
    expect(savedSources[0]!.senderAddress).toBe('ben@stratechery.com');
    expect(savedSources[0]!.isBlocked).toBeNull();
  });

  it('saves articles from new (pending) senders with pending_review status', async () => {
    mockSimpleParser.mockResolvedValue(validNewsletterEmail);

    const result = await pollNewsletters();

    expect(result.newArticles).toBe(1);
    expect(result.errors).toHaveLength(0);

    const savedArticles = (db as ReturnType<typeof createTestDb>['db'])
      .select()
      .from(articles)
      .all();
    expect(savedArticles).toHaveLength(1);
    expect(savedArticles[0]!.title).toBe('The Latest Tech Analysis');
    expect(savedArticles[0]!.externalId).toBe('<abc123@mail.example.com>');
    expect(savedArticles[0]!.status).toBe('pending_review');

    expect(mockMessageFlagsAdd).toHaveBeenCalledWith('1', ['\\Seen'], { uid: true });
  });

  it('saves articles from approved senders with inbox status', async () => {
    // Create an approved source
    (db as ReturnType<typeof createTestDb>['db'])
      .insert(sources)
      .values({
        type: 'newsletter',
        name: 'Ben Thompson',
        senderAddress: 'ben@stratechery.com',
        isBlocked: false,
      })
      .run();

    mockSimpleParser.mockResolvedValue(validNewsletterEmail);

    const result = await pollNewsletters();

    expect(result.newArticles).toBe(1);

    const savedArticles = (db as ReturnType<typeof createTestDb>['db'])
      .select()
      .from(articles)
      .all();
    expect(savedArticles[0]!.status).toBe('inbox');
  });

  it('skips emails from blocked senders', async () => {
    // Create a blocked source
    (db as ReturnType<typeof createTestDb>['db'])
      .insert(sources)
      .values({
        type: 'newsletter',
        name: 'Ben Thompson',
        senderAddress: 'ben@stratechery.com',
        isBlocked: true,
      })
      .run();

    mockSimpleParser.mockResolvedValue(validNewsletterEmail);

    const result = await pollNewsletters();

    expect(result.newArticles).toBe(0);
    expect(result.skipped).toBe(1);

    expect(mockMessageFlagsAdd).toHaveBeenCalledWith('1', ['\\Seen'], { uid: true });
  });

  it('handles plain text-only emails by wrapping in <p> tags', async () => {
    mockSimpleParser.mockResolvedValue(plainTextOnlyEmail);

    const result = await pollNewsletters();

    expect(result.newArticles).toBe(1);

    const savedArticles = (db as ReturnType<typeof createTestDb>['db'])
      .select()
      .from(articles)
      .all();
    expect(savedArticles[0]!.contentHtml).toContain('<p>');
  });

  it('skips duplicate emails with same Message-ID', async () => {
    mockSimpleParser.mockResolvedValue(validNewsletterEmail);
    await pollNewsletters();

    const result = await pollNewsletters();

    expect(result.newArticles).toBe(0);
    expect(result.skipped).toBe(1);

    const savedArticles = (db as ReturnType<typeof createTestDb>['db'])
      .select()
      .from(articles)
      .all();
    expect(savedArticles).toHaveLength(1);
  });

  it('skips very large emails (>5MB)', async () => {
    mockFetchOne.mockResolvedValue({
      uid: 1,
      source: Buffer.alloc(6 * 1024 * 1024),
      size: 6 * 1024 * 1024,
    });
    mockSimpleParser.mockResolvedValue(largeEmail);

    const result = await pollNewsletters();

    expect(result.newArticles).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('processes emails from multiple recipients', async () => {
    mockSimpleParser.mockResolvedValue(multiRecipientEmail);

    const result = await pollNewsletters();

    expect(result.newArticles).toBe(1);
  });

  it('reuses existing source for known senders', async () => {
    (db as ReturnType<typeof createTestDb>['db'])
      .insert(sources)
      .values({
        type: 'newsletter',
        name: 'Ben Thompson',
        senderAddress: 'ben@stratechery.com',
        isBlocked: false,
      })
      .run();

    mockSimpleParser.mockResolvedValue(validNewsletterEmail);

    await pollNewsletters();

    const savedSources = (db as ReturnType<typeof createTestDb>['db']).select().from(sources).all();
    expect(savedSources).toHaveLength(1);
  });

  it('handles IMAP connection failure gracefully', async () => {
    mockConnect.mockRejectedValue(new Error('Connection refused'));

    const result = await pollNewsletters();

    expect(result.newArticles).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Connection refused');
  });

  // --- Content pipeline: preprocessing + storage ---

  it('stores raw email HTML in contentOriginalHtml before preprocessing', async () => {
    const trackingPixelHtml =
      '<p>Newsletter content</p><img src="https://track.mailchimp.com/open.php?id=1" width="1" height="1">';
    const emailWithTracker = {
      ...validNewsletterEmail,
      messageId: '<tracking@mail.example.com>',
      html: trackingPixelHtml,
      headers: new Map([['message-id', '<tracking@mail.example.com>']]),
    };
    mockSimpleParser.mockResolvedValue(emailWithTracker);

    await pollNewsletters();

    const savedArticles = (db as ReturnType<typeof createTestDb>['db'])
      .select()
      .from(articles)
      .all();
    expect(savedArticles[0]!.contentOriginalHtml).toContain('track.mailchimp.com');
    expect(savedArticles[0]!.contentHtml).not.toContain('track.mailchimp.com');
  });

  it('populates contentMarkdown for HTML emails', async () => {
    mockSimpleParser.mockResolvedValue(validNewsletterEmail);

    await pollNewsletters();

    const savedArticles = (db as ReturnType<typeof createTestDb>['db'])
      .select()
      .from(articles)
      .all();
    expect(savedArticles[0]!.contentMarkdown).toBeTruthy();
    expect(typeof savedArticles[0]!.contentMarkdown).toBe('string');
  });

  it('stores null contentOriginalHtml for plain-text-only emails', async () => {
    mockSimpleParser.mockResolvedValue(plainTextOnlyEmail);

    await pollNewsletters();

    const savedArticles = (db as ReturnType<typeof createTestDb>['db'])
      .select()
      .from(articles)
      .all();
    expect(savedArticles[0]!.contentOriginalHtml).toBeNull();
  });

  it('sanitizes HTML content through DOMPurify', async () => {
    const emailWithScript = {
      ...validNewsletterEmail,
      messageId: '<xss@mail.example.com>',
      html: '<p>Safe content</p><script>alert("xss")</script><img onerror="alert(1)" src="x.jpg">',
      headers: new Map([['message-id', '<xss@mail.example.com>']]),
    };

    mockFetchOne.mockResolvedValue({ uid: 1, source: Buffer.from('raw email bytes'), size: 100 });
    mockSimpleParser.mockResolvedValue(emailWithScript);

    const result = await pollNewsletters();
    expect(result.newArticles).toBe(1);

    const savedArticles = (db as ReturnType<typeof createTestDb>['db'])
      .select()
      .from(articles)
      .all();
    expect(savedArticles[0]!.contentHtml).not.toContain('<script>');
    expect(savedArticles[0]!.contentHtml).not.toContain('onerror');
  });
});
