import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RateLimitError,
  APIConnectionTimeoutError,
  APIConnectionError,
} from '@anthropic-ai/sdk/error';
const insertValues = vi.fn().mockResolvedValue(undefined);
const insertFn = vi.fn().mockReturnValue({ values: insertValues });
const mockDb = { insert: insertFn };

vi.mock('@/db', () => ({
  get db() {
    return mockDb;
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { trackAiCall, newRunId } from '@/lib/ai-usage';

function fakeHeaders(): ConstructorParameters<typeof RateLimitError>[3] {
  return new Headers() as unknown as ConstructorParameters<typeof RateLimitError>[3];
}

function getInsertedRow(): Record<string, unknown> {
  const call = insertValues.mock.calls[0];
  if (!call) throw new Error('No insert call recorded');
  return call[0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-dummy');
  insertFn.mockClear();
  insertValues.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('trackAiCall', () => {
  it('writes a row on success with all usage fields populated', async () => {
    const result = await trackAiCall(
      { feature: 'summarize', resourceType: 'article', resourceId: 1 },
      async () => ({
        result: 'output text',
        usage: {
          model: 'claude-sonnet-4-6',
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
          webSearchCount: 0,
        },
      }),
    );

    expect(result).toBe('output text');
    expect(insertFn).toHaveBeenCalledTimes(1);
    const row = getInsertedRow();
    expect(row.status).toBe('success');
    expect(row.feature).toBe('summarize');
    expect(row.inputTokens).toBe(100);
    expect(row.outputTokens).toBe(50);
    expect(row.cacheReadTokens).toBe(10);
    expect(row.cacheWriteTokens).toBe(5);
    expect(row.resourceType).toBe('article');
    expect(row.resourceId).toBe(1);
    expect(row.errorKind).toBeNull();
    expect(typeof row.durationMs).toBe('number');
  });

  it('writes a row on throw with status=error and classified errorKind', async () => {
    const err = new RateLimitError(
      429,
      { error: { message: 'rate limit' } },
      'rate limit',
      fakeHeaders(),
    );

    await expect(
      trackAiCall({ feature: 'chat' }, async () => {
        throw err;
      }),
    ).rejects.toThrow();

    expect(insertFn).toHaveBeenCalledTimes(1);
    const row = getInsertedRow();
    expect(row.status).toBe('error');
    expect(row.errorKind).toBe('rate_limit');
  });

  it('rethrows the original error after writing the row', async () => {
    const originalError = new Error('something broke');
    await expect(
      trackAiCall({ feature: 'tag' }, async () => {
        throw originalError;
      }),
    ).rejects.toThrow('something broke');

    expect(insertFn).toHaveBeenCalledTimes(1);
  });

  it('writes a row on throw with partial usage when error carries usage data', async () => {
    // Some Anthropic rate-limit responses include token counts in the error body
    const errWithUsage = new RateLimitError(
      429,
      { error: { message: 'rate limit' }, usage: { input_tokens: 200, output_tokens: 0 } },
      'rate limit',
      fakeHeaders(),
    );

    await expect(
      trackAiCall({ feature: 'explain' }, async () => {
        throw errWithUsage;
      }),
    ).rejects.toThrow();

    const row = getInsertedRow();
    expect(row.status).toBe('error');
    expect(row.inputTokens).toBe(200);
  });

  it('classifies timeout as timeout errorKind', async () => {
    await expect(
      trackAiCall({ feature: 'lint_gaps' }, async () => {
        throw new APIConnectionTimeoutError();
      }),
    ).rejects.toThrow();

    const row = getInsertedRow();
    expect(row.errorKind).toBe('timeout');
  });

  it('classifies APIConnectionError as network errorKind', async () => {
    await expect(
      trackAiCall({ feature: 'lint_connections' }, async () => {
        throw new APIConnectionError({ message: 'ECONNREFUSED' });
      }),
    ).rejects.toThrow();

    const row = getInsertedRow();
    expect(row.errorKind).toBe('network');
  });
});

describe('newRunId', () => {
  it('returns distinct UUIDs', () => {
    const ids = Array.from({ length: 5 }, () => newRunId());
    const unique = new Set(ids);
    expect(unique.size).toBe(5);
  });

  it('returns UUID v4 format', () => {
    const id = newRunId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
