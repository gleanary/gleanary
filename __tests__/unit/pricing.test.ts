import { describe, it, expect, vi } from 'vitest';
import {
  computeCost,
  aggregateCost,
  estimateCost,
  MODEL_PRICING,
  WEB_SEARCH_COST_USD,
} from '@/lib/pricing';
import type { UsageRow } from '@/lib/pricing';
import { logger } from '@/lib/logger';

describe('computeCost', () => {
  it('computes cost correctly for known model', () => {
    const row: UsageRow = {
      model: 'claude-sonnet-4-6',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      webSearchCount: 0,
    };
    const pricing = MODEL_PRICING['claude-sonnet-4-6'];
    const expected = pricing.input + pricing.output + pricing.cacheRead + pricing.cacheWrite;
    expect(computeCost(row)).toBeCloseTo(expected, 6);
  });

  it('adds web search cost', () => {
    const row: UsageRow = {
      model: 'claude-haiku-4-5',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearchCount: 10,
    };
    expect(computeCost(row)).toBeCloseTo(10 * WEB_SEARCH_COST_USD, 6);
  });

  it('returns 0 and logs warning for unknown model', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const row: UsageRow = {
      model: 'claude-unknown-99',
      inputTokens: 500_000,
      outputTokens: 500_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearchCount: 0,
    };
    expect(computeCost(row)).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-unknown-99' }),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });

  it('prices a claude-sonnet-5 row without the unknown-model warning path', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const row: UsageRow = {
      model: 'claude-sonnet-5',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      webSearchCount: 0,
    };
    expect(computeCost(row)).toBeCloseTo(3.0 + 15.0 + 0.3 + 3.75, 6);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(MODEL_PRICING['claude-sonnet-5']).toEqual({
      input: 3.0,
      output: 15.0,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
    warnSpy.mockRestore();
  });

  it('computes zero cost for all-zero tokens', () => {
    const row: UsageRow = {
      model: 'claude-opus-4-7',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearchCount: 0,
    };
    expect(computeCost(row)).toBe(0);
  });
});

describe('computeCost — page-based models', () => {
  it('computes cost for mistral-ocr-4-0 at $0.004/page', () => {
    const row: UsageRow = {
      model: 'mistral-ocr-4-0',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearchCount: 0,
      pagesProcessed: 10,
    };
    expect(computeCost(row)).toBeCloseTo(0.04, 6);
  });

  it('preserves historical rate for mistral-ocr-latest at $0.002/page', () => {
    const row: UsageRow = {
      model: 'mistral-ocr-latest',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearchCount: 0,
      pagesProcessed: 10,
    };
    expect(computeCost(row)).toBeCloseTo(0.02, 6);
  });
});

describe('aggregateCost', () => {
  it('sums cost across mixed-model rows', () => {
    const rows: UsageRow[] = [
      {
        model: 'claude-sonnet-4-6',
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        webSearchCount: 0,
      },
      {
        model: 'claude-haiku-4-5',
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        webSearchCount: 0,
      },
    ];
    const expected =
      MODEL_PRICING['claude-sonnet-4-6'].input + MODEL_PRICING['claude-haiku-4-5'].input;
    expect(aggregateCost(rows)).toBeCloseTo(expected, 6);
  });

  it('returns 0 for empty array', () => {
    expect(aggregateCost([])).toBe(0);
  });
});

describe('estimateCost', () => {
  it('returns min/max bounds without subagents', () => {
    const result = estimateCost({
      model: 'claude-sonnet-4-6',
      maxInputTokens: 10_000,
      minOutputTokens: 100,
      maxOutputTokens: 1_000,
      maxWebSearches: 5,
    });
    expect(result.minUsd).toBeLessThan(result.maxUsd);
    expect(result.minUsd).toBeGreaterThan(0);
    expect(result.maxUsd).toBeGreaterThan(0);
  });

  it('includes subagent cost in max bounds', () => {
    const withoutSubagents = estimateCost({
      model: 'claude-opus-4-7',
      maxInputTokens: 10_000,
      minOutputTokens: 100,
      maxOutputTokens: 1_000,
      maxWebSearches: 0,
    });
    const withSubagents = estimateCost({
      model: 'claude-opus-4-7',
      maxInputTokens: 10_000,
      minOutputTokens: 100,
      maxOutputTokens: 1_000,
      maxWebSearches: 0,
      subagents: {
        model: 'claude-sonnet-4-6',
        count: 3,
        maxInputTokens: 5_000,
        maxOutputTokens: 500,
        maxWebSearches: 2,
      },
    });
    expect(withSubagents.maxUsd).toBeGreaterThan(withoutSubagents.maxUsd);
  });

  it('zero searches produce no search cost', () => {
    const result = estimateCost({
      model: 'claude-haiku-4-5',
      maxInputTokens: 1_000,
      minOutputTokens: 10,
      maxOutputTokens: 100,
      maxWebSearches: 0,
    });
    // max cost should only be token-based
    const tokenOnlyMax =
      (MODEL_PRICING['claude-haiku-4-5'].input * 1_000 +
        MODEL_PRICING['claude-haiku-4-5'].output * 100) /
      1_000_000;
    expect(result.maxUsd).toBeCloseTo(tokenOnlyMax, 6);
  });
});
