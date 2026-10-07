import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { aiUsage, settings } from '@/db/schema';
import { GET } from '@/app/api/usage/summary/route';
import { clearSettingsCache } from '@/lib/settings';

function req(search = '') {
  return new NextRequest(new URL(`http://localhost:3000/api/usage/summary${search}`));
}

describe('GET /api/usage/summary', () => {
  beforeEach(() => {
    dbMock.setup();
    clearSettingsCache();
  });

  it('returns zero totals when ai_usage table is empty', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalUsd).toBe(0);
    expect(body.callCount).toBe(0);
    expect(body.budgetUsd).toBeNull();
    expect(body.range).toBe('month');
  });

  it('sums cost across successful rows only', async () => {
    const db = dbMock.mock.db!;
    await db.insert(aiUsage).values([
      {
        feature: 'chat',
        model: 'claude-haiku-4-5',
        status: 'success',
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        webSearchCount: 0,
        durationMs: 100,
      },
      {
        feature: 'summarize',
        model: 'claude-haiku-4-5',
        status: 'error',
        inputTokens: 999_999,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        webSearchCount: 0,
        durationMs: 50,
        errorKind: 'api_error',
      },
    ]);

    const res = await GET(req());
    const body = await res.json();
    // Only the success row counts: 1M input tokens × $1.00/M = $1.00
    expect(body.totalUsd).toBeCloseTo(1.0, 5);
    expect(body.callCount).toBe(1);
  });

  it('returns budgetUsd when set in settings', async () => {
    const db = dbMock.mock.db!;
    await db
      .insert(settings)
      .values({ userId: 1, key: 'monthly_budget_usd', value: '25.00', isEncrypted: false });

    const res = await GET(req());
    const body = await res.json();
    expect(body.budgetUsd).toBeCloseTo(25.0, 5);
  });

  it('supports ?range=all', async () => {
    const res = await GET(req('?range=all'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.range).toBe('all');
  });

  it('rejects invalid range values with 422', async () => {
    const res = await GET(req('?range=invalid'));
    expect(res.status).toBe(422);
  });
});
