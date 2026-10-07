import { describe, it, expect } from 'vitest';
import {
  CLAUDE_PRICING,
  ANTHROPIC_MODELS,
  DEFAULT_CHAT_MODEL,
  DRAFT_MODEL_IDS,
  DEFAULT_DRAFT_MODEL,
  DRAFT_MODELS,
  UTILITY_MODEL,
  getModelBudget,
} from '@/lib/models';
import { computeCost } from '@/lib/pricing';

/**
 * A model id is priced when the production cost path resolves it — computeCost
 * normalizes date-suffixed API ids and returns 0 for unknown models.
 */
function isPriced(modelId: string): boolean {
  return (
    computeCost({
      model: modelId,
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearchCount: 0,
    }) > 0
  );
}

describe('CLAUDE_PRICING rate card', () => {
  it('has positive finite values for all four rates of every model', () => {
    for (const [id, pricing] of Object.entries(CLAUDE_PRICING)) {
      for (const rate of [pricing.input, pricing.output, pricing.cacheRead, pricing.cacheWrite]) {
        expect(rate, `rate for ${id}`).toBeGreaterThan(0);
        expect(Number.isFinite(rate), `rate for ${id} is finite`).toBe(true);
      }
    }
  });

  it('keeps the standard rate relationships (output > input, cacheRead < input < cacheWrite)', () => {
    for (const [id, pricing] of Object.entries(CLAUDE_PRICING)) {
      expect(pricing.output, `output vs input for ${id}`).toBeGreaterThan(pricing.input);
      expect(pricing.cacheRead, `cacheRead vs input for ${id}`).toBeLessThan(pricing.input);
      expect(pricing.cacheWrite, `cacheWrite vs input for ${id}`).toBeGreaterThan(pricing.input);
    }
  });

  it('pins the current rates for the three active models (verified June 2026)', () => {
    expect(CLAUDE_PRICING['claude-haiku-4-5']).toEqual({
      input: 1.0,
      output: 5.0,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    });
    expect(CLAUDE_PRICING['claude-sonnet-4-6']).toEqual({
      input: 3.0,
      output: 15.0,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
    expect(CLAUDE_PRICING['claude-opus-4-8']).toEqual({
      input: 5.0,
      output: 25.0,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    });
  });
});

describe('model selectors', () => {
  it('every chat model is priced through the production cost path', () => {
    expect(ANTHROPIC_MODELS.length).toBeGreaterThan(0);
    for (const model of ANTHROPIC_MODELS) {
      expect(isPriced(model.id), `pricing for ${model.id}`).toBe(true);
    }
  });

  it('every draft model is priced and has matching display metadata', () => {
    expect(DRAFT_MODEL_IDS.length).toBeGreaterThan(0);
    for (const id of DRAFT_MODEL_IDS) {
      expect(isPriced(id), `pricing for ${id}`).toBe(true);
    }
    expect(DRAFT_MODELS.map((m) => m.id)).toEqual([...DRAFT_MODEL_IDS]);
  });

  it('the default and utility models are selectable and priced', () => {
    expect(ANTHROPIC_MODELS.map((m) => m.id)).toContain(DEFAULT_CHAT_MODEL);
    expect(DRAFT_MODEL_IDS).toContain(DEFAULT_DRAFT_MODEL);
    expect(ANTHROPIC_MODELS.map((m) => m.id)).toContain(UTILITY_MODEL);
    expect(isPriced(UTILITY_MODEL)).toBe(true);
  });
});

describe('claude-sonnet-5 registry entry', () => {
  it('prices Sonnet 5 at the standard rate card', () => {
    expect(CLAUDE_PRICING['claude-sonnet-5']).toEqual({
      input: 3.0,
      output: 15.0,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
  });

  it('is selectable for chat with its dateless API id', () => {
    expect(ANTHROPIC_MODELS).toContainEqual(
      expect.objectContaining({
        id: 'claude-sonnet-5',
        name: 'Sonnet 5',
        contextWindow: 1_000_000,
      }),
    );
  });

  it('is selectable for drafts with matching id and display metadata', () => {
    expect(DRAFT_MODEL_IDS).toContain('claude-sonnet-5');
    expect(DRAFT_MODELS).toContainEqual({ id: 'claude-sonnet-5', name: 'Sonnet 5' });
  });

  it('does not become the default chat or draft model', () => {
    expect(DEFAULT_CHAT_MODEL).toBe('claude-sonnet-4-6');
    expect(DEFAULT_DRAFT_MODEL).toBe('claude-sonnet-4-6');
  });

  it('is priced through the production cost path', () => {
    expect(isPriced('claude-sonnet-5')).toBe(true);
  });
});

describe('getModelBudget', () => {
  it('scales Sonnet 5 budgets to its 1M context window', () => {
    expect(getModelBudget('claude-sonnet-5')).toEqual({
      contextBudgetChars: 1_600_000,
      historyBudgetChars: 300_000,
      maxResponseTokens: 4_096,
    });
  });

  it('scales budgets to a 200k context window (Haiku, via dated API id or normalized id)', () => {
    const expected = {
      contextBudgetChars: 320_000,
      historyBudgetChars: 60_000,
      maxResponseTokens: 4_000,
    };
    expect(getModelBudget('claude-haiku-4-5-20251001')).toEqual(expected);
    expect(getModelBudget('claude-haiku-4-5')).toEqual(expected);
  });

  it('scales budgets to a 1M context window and caps the response at 4096 tokens', () => {
    expect(getModelBudget('claude-sonnet-4-6')).toEqual({
      contextBudgetChars: 1_600_000,
      historyBudgetChars: 300_000,
      maxResponseTokens: 4_096,
    });
  });

  it('falls back to the 200k window for an unrecognized model id', () => {
    expect(getModelBudget('some-unknown-model')).toEqual(getModelBudget('claude-haiku-4-5'));
  });
});
