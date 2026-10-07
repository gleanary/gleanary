import { describe, it, expect, beforeEach, vi } from 'vitest';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

// Partial-mock @/lib/ai: keep the real LINT_GAPS_PROMPT + parseLintGaps, stub
// only callClaude (same idiom as thesis-ai.test.ts).
vi.mock('@/lib/ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/ai')>();
  return { ...original, callClaude: vi.fn() };
});

import { collect } from './lint-test-utils';
import { callClaude } from '@/lib/ai';
import { theses } from '@/db/schema';
import { runGaps } from '@/lib/lint/gaps';
import type { LintContext } from '@/lib/lint/types';

const mockedCallClaude = vi.mocked(callClaude);

describe('runGaps', () => {
  let ctx: LintContext;
  let db: ReturnType<typeof dbMock.setup>['db'];

  beforeEach(() => {
    mockedCallClaude.mockReset();
    const testDb = dbMock.setup();
    db = testDb.db;
    ctx = { db: testDb.db, rawDb: testDb.sqlite };
  });

  it('yields a single fallback and makes no AI call when no developing/researched theses exist', async () => {
    // nascent / ready / used are all excluded from the candidate set.
    db.insert(theses).values({ title: 'Fresh idea', status: 'nascent' }).run();
    db.insert(theses).values({ title: 'Polished', status: 'ready' }).run();
    db.insert(theses).values({ title: 'Cited', status: 'used' }).run();

    const suggestions = await collect(runGaps(ctx));

    expect(mockedCallClaude).not.toHaveBeenCalled();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.type).toBe('gap');
    expect(suggestions[0]!.description).toContain('No developing or researched theses');
    expect(suggestions[0]!.relatedIds).toEqual([]);
  });

  it('warns and continues to the next thesis when a Claude call throws', async () => {
    db.insert(theses).values({ title: 'First thesis', status: 'developing' }).run();
    db.insert(theses).values({ title: 'Second thesis', status: 'researched' }).run();

    mockedCallClaude.mockImplementation(async (_systemPrompt: string, userMessage: string) => {
      if (userMessage.includes('First thesis')) throw new Error('Haiku exploded');
      return JSON.stringify({ hasGap: true, description: 'needs a counterargument' });
    });

    const suggestions = await collect(runGaps(ctx));

    // The throwing thesis is skipped; the second still produces its gap.
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.description).toContain('Second thesis');
  });

  it('emits no suggestion for a thesis when hasGap is false', async () => {
    db.insert(theses).values({ title: 'Solid thesis', status: 'developing' }).run();
    mockedCallClaude.mockResolvedValue(JSON.stringify({ hasGap: false }));

    const suggestions = await collect(runGaps(ctx));

    expect(suggestions).toHaveLength(0);
  });

  it('emits no suggestion for a thesis when the description is missing', async () => {
    db.insert(theses).values({ title: 'Vague thesis', status: 'developing' }).run();
    mockedCallClaude.mockResolvedValue(JSON.stringify({ hasGap: true }));

    const suggestions = await collect(runGaps(ctx));

    expect(suggestions).toHaveLength(0);
  });

  it('prefixes the description with the thesis title and defaults suggestedAction to "Review thesis"', async () => {
    db.insert(theses).values({ title: 'My Thesis', status: 'developing' }).run();
    // No suggestedAction returned → generator supplies the default.
    mockedCallClaude.mockResolvedValue(
      JSON.stringify({
        hasGap: true,
        gapType: 'counterargument',
        description: 'Missing an opposing view',
      }),
    );

    const suggestions = await collect(runGaps(ctx));

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.description).toBe('My Thesis: Missing an opposing view');
    expect(suggestions[0]!.suggestedAction).toBe('Review thesis');
    expect(suggestions[0]!.relatedIds).toHaveLength(1);
    expect(suggestions[0]!.relatedIds[0]).toMatchObject({ type: 'thesis' });
  });

  it('uses the suggestedAction returned by the parser when present', async () => {
    db.insert(theses).values({ title: 'Actionable thesis', status: 'researched' }).run();
    mockedCallClaude.mockResolvedValue(
      JSON.stringify({
        hasGap: true,
        gapType: 'research',
        description: 'No primary sources cited',
        suggestedAction: 'Add primary sources',
      }),
    );

    const suggestions = await collect(runGaps(ctx));

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.suggestedAction).toBe('Add primary sources');
  });
});
