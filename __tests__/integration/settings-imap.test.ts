import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// --- DB mock ---
const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

// --- ImapFlow mock ---
const mockConnect = vi.fn();
const mockList = vi.fn();
const mockLogout = vi.fn();
vi.mock('imapflow', () => ({
  ImapFlow: vi.fn().mockImplementation(function () {
    return {
      on: vi.fn(),
      connect: mockConnect,
      list: mockList,
      logout: mockLogout,
    };
  }),
}));

// --- DNS mock (block SSRF) ---
const mockResolve4 = vi.fn().mockResolvedValue(['93.184.216.34']); // public IP by default
const mockResolve6 = vi.fn().mockResolvedValue([]);
vi.mock('dns/promises', () => ({
  default: { resolve4: mockResolve4, resolve6: mockResolve6 },
  resolve4: mockResolve4,
  resolve6: mockResolve6,
}));

// --- Scheduler mocks ---
const mockStartNewsletter = vi.fn();
const mockStartFeed = vi.fn();
vi.mock('@/lib/newsletter-scheduler', () => ({
  startNewsletterScheduler: (...args: unknown[]) => mockStartNewsletter(...args),
  stopNewsletterScheduler: vi.fn(),
  initNewsletterScheduler: vi.fn(),
}));
vi.mock('@/lib/feed-scheduler', () => ({
  startFeedScheduler: (...args: unknown[]) => mockStartFeed(...args),
  stopFeedScheduler: vi.fn(),
  initFeedScheduler: vi.fn(),
}));

// --- Logger mock ---
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// --- Audit mock ---
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));

import { clearSettingsCache, setSetting } from '@/lib/settings';
import bcrypt from 'bcryptjs';

function jsonReq(method: string, url: string, body?: object) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
      : {}),
  });
}

describe('POST /api/settings/test-imap', () => {
  beforeEach(() => {
    dbMock.setup();
    clearSettingsCache();
    vi.stubEnv(
      'SETTINGS_ENCRYPTION_KEY',
      'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344',
    );
    vi.clearAllMocks();
    // Reset DNS mock to public IP after clearing
    mockResolve4.mockResolvedValue(['93.184.216.34']);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 422 when IMAP settings are incomplete', async () => {
    // No settings stored
    const { POST } = await import('@/app/api/settings/test-imap/route');
    const req = jsonReq('POST', 'http://localhost:3000/api/settings/test-imap');
    const res = await POST(req as NextRequest);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('IMAP not configured');
  });

  it('returns success with mailbox list when connection succeeds', async () => {
    setSetting('imap_host', 'imap.example.com', { encrypted: false });
    setSetting('imap_user', 'user@example.com', { encrypted: false });
    setSetting('imap_password', 'password123', { encrypted: false });
    clearSettingsCache();

    mockConnect.mockResolvedValue(undefined);
    mockList.mockResolvedValue([{ path: 'INBOX' }, { path: 'Sent' }]);
    mockLogout.mockResolvedValue(undefined);

    const { POST } = await import('@/app/api/settings/test-imap/route');
    const req = jsonReq('POST', 'http://localhost:3000/api/settings/test-imap');
    const res = await POST(req as NextRequest);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.mailboxes).toContain('INBOX');
  });

  it('rejects private IP hosts (SSRF prevention)', async () => {
    // Update the DNS mock to return a private IP
    mockResolve4.mockResolvedValue(['192.168.1.1']);

    setSetting('imap_host', 'internal.local', { encrypted: false });
    setSetting('imap_user', 'user@example.com', { encrypted: false });
    setSetting('imap_password', 'password123', { encrypted: false });
    clearSettingsCache();

    const { POST } = await import('@/app/api/settings/test-imap/route');
    const req = jsonReq('POST', 'http://localhost:3000/api/settings/test-imap');
    const res = await POST(req as NextRequest);
    const body = await res.json();

    expect(body.success).toBe(false);
    expect(body.error).toContain('private network');
  });
});

describe('PATCH /api/settings — scheduler restart', () => {
  let passwordHash: string;

  beforeEach(async () => {
    dbMock.setup();
    clearSettingsCache();
    passwordHash = await bcrypt.hash('test-pw', 4);
    vi.stubEnv('SETTINGS_AUTH_HASH', passwordHash);
    vi.stubEnv(
      'SETTINGS_ENCRYPTION_KEY',
      'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344',
    );
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('restarts newsletter scheduler when imap_poll_interval is saved', async () => {
    const { PATCH } = await import('@/app/api/settings/route');
    const req = jsonReq('PATCH', 'http://localhost:3000/api/settings', {
      settings: { imap_poll_interval: '10' },
    });
    const res = await PATCH(req as NextRequest);
    expect(res.status).toBe(200);
    expect(mockStartNewsletter).toHaveBeenCalledWith(10);
  });

  it('restarts feed scheduler when rss_poll_interval is saved', async () => {
    const { PATCH } = await import('@/app/api/settings/route');
    const req = jsonReq('PATCH', 'http://localhost:3000/api/settings', {
      settings: { rss_poll_interval: '15' },
    });
    const res = await PATCH(req as NextRequest);
    expect(res.status).toBe(200);
    expect(mockStartFeed).toHaveBeenCalledWith(15);
  });
});
