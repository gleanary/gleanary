import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { aiUsage } from '@/db/schema';
import { GET } from '@/app/api/usage/top-calls/route';

function req(search = '') {
  return new NextRequest(new URL(`http://localhost:3000/api/usage/top-calls${search}`));
}

describe('GET /api/usage/top-calls', () => {
  beforeEach(() => {
    dbMock.setup();
  });

  it('returns empty list when no rows', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.calls).toEqual([]);
  });

  it('includes costUsd field in each call', async () => {
    const db = dbMock.mock.db!;
    await db.insert(aiUsage).values({
      feature: 'draft_generation',
      model: 'claude-sonnet-4-6',
      status: 'success',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearchCount: 0,
      durationMs: 2000,
    });

    const res = await GET(req());
    const body = await res.json();
    expect(body.calls).toHaveLength(1);
    // 1M input × $3.00/M + 500K output × $15.00/M = $3.00 + $7.50 = $10.50
    expect(body.calls[0].costUsd).toBeCloseTo(10.5, 5);
  });

  it('rejects limit > 50 with 422', async () => {
    const res = await GET(req('?limit=51'));
    expect(res.status).toBe(422);
  });

  it('respects limit param', async () => {
    const db = dbMock.mock.db!;
    const rows = Array.from({ length: 5 }, (_, i) => ({
      feature: 'chat' as const,
      model: 'claude-haiku-4-5',
      status: 'success' as const,
      inputTokens: (5 - i) * 100_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearchCount: 0,
      durationMs: 100,
    }));
    await db.insert(aiUsage).values(rows);

    const res = await GET(req('?limit=3'));
    const body = await res.json();
    expect(body.calls).toHaveLength(3);
  });
});
