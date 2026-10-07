import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { aiUsage } from '@/db/schema';
import { GET } from '@/app/api/usage/breakdown/route';

function req(search = '') {
  return new NextRequest(new URL(`http://localhost:3000/api/usage/breakdown${search}`));
}

describe('GET /api/usage/breakdown', () => {
  beforeEach(() => {
    dbMock.setup();
  });

  it('returns empty breakdown when no rows', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.breakdown).toEqual([]);
  });

  it('groups by feature (default)', async () => {
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
        status: 'success',
        inputTokens: 500_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        webSearchCount: 0,
        durationMs: 80,
      },
    ]);

    const res = await GET(req('?groupBy=feature'));
    const body = await res.json();
    expect(body.breakdown).toHaveLength(2);
    const chatEntry = body.breakdown.find((b: { key: string }) => b.key === 'chat');
    expect(chatEntry).toBeDefined();
    expect(chatEntry.callCount).toBe(2);
    expect(chatEntry.totalUsd).toBeCloseTo(2.0, 5);
  });

  it('groups by model', async () => {
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
        model: 'claude-sonnet-4-6',
        status: 'success',
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        webSearchCount: 0,
        durationMs: 150,
      },
    ]);

    const res = await GET(req('?groupBy=model'));
    const body = await res.json();
    const sonnetEntry = body.breakdown.find((b: { key: string }) => b.key === 'claude-sonnet-4-6');
    expect(sonnetEntry).toBeDefined();
    expect(sonnetEntry.totalUsd).toBeCloseTo(3.0, 5);
  });

  it('excludes error rows', async () => {
    const db = dbMock.mock.db!;
    await db.insert(aiUsage).values({
      feature: 'tag',
      model: 'claude-haiku-4-5',
      status: 'error',
      errorKind: 'timeout',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearchCount: 0,
      durationMs: 5000,
    });

    const res = await GET(req());
    const body = await res.json();
    expect(body.breakdown).toEqual([]);
  });
});
