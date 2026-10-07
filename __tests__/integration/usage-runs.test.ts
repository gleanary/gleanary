import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { aiUsage } from '@/db/schema';
import { GET } from '@/app/api/usage/runs/[runId]/route';

function req(runId: string) {
  return new NextRequest(new URL(`http://localhost:3000/api/usage/runs/${runId}`));
}

function ctx(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

describe('GET /api/usage/runs/[runId]', () => {
  beforeEach(() => {
    dbMock.setup();
  });

  it('returns 404 when runId has no rows', async () => {
    const res = await GET(req('nonexistent-run'), ctx('nonexistent-run'));
    expect(res.status).toBe(404);
  });

  it('returns all calls for the run with totalUsd', async () => {
    const db = dbMock.mock.db!;
    const runId = 'test-run-123';
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
        runId,
      },
      {
        feature: 'chat_keyword_expansion',
        model: 'claude-haiku-4-5',
        status: 'success',
        inputTokens: 100_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        webSearchCount: 0,
        durationMs: 50,
        runId,
      },
    ]);

    const res = await GET(req(runId), ctx(runId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.calls).toHaveLength(2);
    // Both rows: (1M + 100K) × $1.00/M = $1.10
    expect(body.totalUsd).toBeCloseTo(1.1, 5);
    expect(body.calls[0]).toHaveProperty('costUsd');
  });

  it('does not return calls from a different runId', async () => {
    const db = dbMock.mock.db!;
    await db.insert(aiUsage).values({
      feature: 'summarize',
      model: 'claude-haiku-4-5',
      status: 'success',
      inputTokens: 500_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearchCount: 0,
      durationMs: 100,
      runId: 'other-run',
    });

    const res = await GET(req('target-run'), ctx('target-run'));
    expect(res.status).toBe(404);
  });
});
