import { describe, it, expect, beforeEach, vi } from 'vitest';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

// Partial-mock @/lib/ai: keep the real prompts + parsers, stub only the network
// call. This mirrors thesis-ai.test.ts's approach so per-test control over the
// Haiku response is deterministic.
vi.mock('@/lib/ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/ai')>();
  return { ...original, callClaude: vi.fn() };
});

import { collect } from './lint-test-utils';
import {
  callClaude,
  LINT_CONTRADICTIONS_NOTES_PROMPT,
  LINT_CONTRADICTIONS_TENSION_PROMPT,
} from '@/lib/ai';
import { articles, highlights, theses, thesisHighlights } from '@/db/schema';
import { runContradictions } from '@/lib/lint/contradictions';
import type { LintContext } from '@/lib/lint/types';

const mockedCallClaude = vi.mocked(callClaude);

/**
 * Routes the stubbed callClaude by system prompt so pass A (notes) and pass B
 * (tensions) can return different payloads in a single test.
 */
function routeClaude(byPrompt: { notes?: unknown; tension?: unknown }) {
  mockedCallClaude.mockImplementation(async (systemPrompt: string) => {
    if (systemPrompt === LINT_CONTRADICTIONS_NOTES_PROMPT) {
      return JSON.stringify(byPrompt.notes ?? []);
    }
    if (systemPrompt === LINT_CONTRADICTIONS_TENSION_PROMPT) {
      return JSON.stringify(byPrompt.tension ?? []);
    }
    return '[]';
  });
}

describe('runContradictions', () => {
  let ctx: LintContext;
  let db: ReturnType<typeof dbMock.setup>['db'];

  beforeEach(() => {
    mockedCallClaude.mockReset();
    const testDb = dbMock.setup();
    db = testDb.db;
    ctx = { db: testDb.db, rawDb: testDb.sqlite };
  });

  /** Seeds an article and returns its id. */
  function seedArticle(url = 'https://example.com/a'): number {
    return db.insert(articles).values({ url, title: 'Source Article' }).returning().get()!.id;
  }

  it('skips pass A entirely when fewer than 2 annotated highlights exist (no AI call)', async () => {
    const articleId = seedArticle();
    db.insert(highlights).values({ articleId, text: 'lonely', note: 'only note' }).run();
    routeClaude({ notes: [], tension: [] });

    const suggestions = await collect(runContradictions(ctx));

    // Pass A skipped (1 annotated < 2), pass B has no pairs → no Claude call at all.
    expect(mockedCallClaude).not.toHaveBeenCalled();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.description).toContain('No contradictions found');
  });

  it('filters out a note-contradiction whose valid highlight IDs drop below 2', async () => {
    const articleId = seedArticle();
    db.insert(highlights).values({ articleId, text: 'h1', note: 'note one' }).run();
    db.insert(highlights).values({ articleId, text: 'h2', note: 'note two' }).run();
    // Haiku references highlight 1 (real) and 999 (not in the annotated set) → 1 valid → dropped.
    routeClaude({
      notes: [{ highlightIds: [1, 999], description: 'these disagree' }],
    });

    const suggestions = await collect(runContradictions(ctx));

    expect(suggestions.some((s) => s.description === 'these disagree')).toBe(false);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.description).toContain('No contradictions found');
  });

  it('continues when the pass-A Claude call throws, treating it as an empty response', async () => {
    const articleId = seedArticle();
    db.insert(highlights).values({ articleId, text: 'h1', note: 'note one' }).run();
    db.insert(highlights).values({ articleId, text: 'h2', note: 'note two' }).run();
    mockedCallClaude.mockRejectedValue(new Error('Haiku exploded'));

    const suggestions = await collect(runContradictions(ctx));

    // The try/catch swallows the error → generator still completes with the fallback.
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.description).toContain('No contradictions found');
  });

  it('emits a tension with the thesis title and 3 relatedIds for a supporting/opposing pair', async () => {
    const articleId = seedArticle();
    const hSup = db
      .insert(highlights)
      .values({ articleId, text: 'growth is good' })
      .returning()
      .get()!;
    const hOpp = db
      .insert(highlights)
      .values({ articleId, text: 'growth is harmful' })
      .returning()
      .get()!;
    const thesis = db
      .insert(theses)
      .values({ title: 'Degrowth debate', status: 'developing' })
      .returning()
      .get()!;
    db.insert(thesisHighlights)
      .values({ thesisId: thesis.id, highlightId: hSup.id, role: 'supporting' })
      .run();
    db.insert(thesisHighlights)
      .values({ thesisId: thesis.id, highlightId: hOpp.id, role: 'opposing' })
      .run();

    routeClaude({ tension: [{ pairIndex: 0, description: 'they disagree on net benefit' }] });

    const suggestions = await collect(runContradictions(ctx));

    const tension = suggestions.find((s) => s.description.includes('they disagree on net benefit'));
    expect(tension).toBeDefined();
    expect(tension!.description).toContain('Degrowth debate');
    expect(tension!.relatedIds).toHaveLength(3);
    expect(tension!.relatedIds.map((r) => r.type).sort()).toEqual([
      'highlight',
      'highlight',
      'thesis',
    ]);
    // The fallback must NOT appear once a real tension was emitted.
    expect(suggestions.some((s) => s.description.includes('No contradictions found'))).toBe(false);
  });

  it('skips a tension whose pairIndex is out of range', async () => {
    const articleId = seedArticle();
    const hSup = db.insert(highlights).values({ articleId, text: 's' }).returning().get()!;
    const hOpp = db.insert(highlights).values({ articleId, text: 'o' }).returning().get()!;
    const thesis = db
      .insert(theses)
      .values({ title: 'Only pair', status: 'developing' })
      .returning()
      .get()!;
    db.insert(thesisHighlights)
      .values({ thesisId: thesis.id, highlightId: hSup.id, role: 'supporting' })
      .run();
    db.insert(thesisHighlights)
      .values({ thesisId: thesis.id, highlightId: hOpp.id, role: 'opposing' })
      .run();

    // Only pair index 0 exists; Haiku hallucinates index 5 → skipped.
    routeClaude({ tension: [{ pairIndex: 5, description: 'phantom tension' }] });

    const suggestions = await collect(runContradictions(ctx));

    expect(suggestions.some((s) => s.description.includes('phantom tension'))).toBe(false);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.description).toContain('No contradictions found');
  });

  it('yields exactly one fallback suggestion with empty relatedIds when nothing is found', async () => {
    routeClaude({ notes: [], tension: [] });

    const suggestions = await collect(runContradictions(ctx));

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.type).toBe('contradiction');
    expect(suggestions[0]!.description).toContain('No contradictions found');
    expect(suggestions[0]!.relatedIds).toEqual([]);
  });
});
