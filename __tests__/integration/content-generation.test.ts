import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';

// --- Mocks ---

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());

vi.mock('@/db', () => dbMock.mock);

vi.mock('@/lib/ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/ai')>();
  return {
    ...original,
    callClaudeStreaming: vi.fn(),
  };
});

import { callClaudeStreaming } from '@/lib/ai';
import {
  buildSystemPrompt,
  buildUserPrompt,
  selectSamples,
  truncateUserPrompt,
  generateDraft,
  type HighlightForGeneration,
  type StreamEvent,
} from '@/lib/content-generation';
import { logger } from '@/lib/logger';
import { getTemplate } from '@/lib/content-templates';
import { ExternalServiceError } from '@/lib/errors';
import {
  drafts,
  theses,
  articles,
  highlights,
  thesisHighlights,
  thesisResearch,
  voiceProfile,
  voiceSamples,
} from '@/db/schema';
import type { Thesis, VoiceSample, ThesisResearch, ThesisHighlightRole } from '@/types';

// --- Helpers ---

function makeThesis(overrides: Partial<Thesis> = {}): Thesis {
  return {
    id: 1,
    userId: 1,
    title: 'Remote work improves focus',
    claim: 'Remote work dramatically improves focus for deep work.',
    counterarguments: 'Some roles demand in-person collaboration.',
    implications:
      'Companies should redesign offices as collaboration hubs, not default workplaces.',
    status: 'ready',
    notes: null,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSample(overrides: Partial<VoiceSample> = {}): VoiceSample {
  return {
    id: 1,
    profileId: 1,
    title: 'Sample title',
    content: 'Sample content body.',
    wordCount: 4,
    channelHint: null,
    createdAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeResearch(overrides: Partial<ThesisResearch> = {}): ThesisResearch {
  return {
    id: 1,
    thesisId: 1,
    title: 'Research entry',
    content: 'Research content.',
    source: 'manual',
    createdAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeHighlight(
  role: ThesisHighlightRole,
  text: string,
  note: string | null = null,
): HighlightForGeneration {
  return { text, note, role };
}

function emptyHighlightsByRole(): Record<ThesisHighlightRole, HighlightForGeneration[]> {
  return { supporting: [], opposing: [], context: [] };
}

// =============================================================================
// Pure-assembly tests
// =============================================================================

describe('buildSystemPrompt', () => {
  const templateInstructions = 'TEMPLATE INSTRUCTIONS HERE';

  it('includes profile, samples, and instructions in order when all present', () => {
    const profile = '## Voice profile markdown';
    const samples: VoiceSample[] = [
      makeSample({ id: 1, title: 'First sample', content: 'First body.' }),
      makeSample({ id: 2, title: 'Second sample', content: 'Second body.' }),
    ];
    const out = buildSystemPrompt({ voiceProfile: profile, samples, templateInstructions });

    const profileIdx = out.indexOf(profile);
    const firstSampleIdx = out.indexOf('## Sample: First sample');
    const secondSampleIdx = out.indexOf('## Sample: Second sample');
    const instructionsIdx = out.indexOf(templateInstructions);

    expect(profileIdx).toBeGreaterThanOrEqual(0);
    expect(firstSampleIdx).toBeGreaterThan(profileIdx);
    expect(secondSampleIdx).toBeGreaterThan(firstSampleIdx);
    expect(instructionsIdx).toBeGreaterThan(secondSampleIdx);
    expect(out).toContain('First body.');
    expect(out).toContain('Second body.');
  });

  it('uses a fallback meta-instruction when the voice profile is missing', () => {
    const out = buildSystemPrompt({
      voiceProfile: null,
      samples: [],
      templateInstructions,
    });
    expect(out).toContain('No voice profile available; follow template instructions only.');
    expect(out).toContain(templateInstructions);
    expect(out).not.toContain('## Sample:');
  });

  it('renders no ## Sample: headers when samples is empty', () => {
    const out = buildSystemPrompt({
      voiceProfile: '## Profile',
      samples: [],
      templateInstructions,
    });
    expect(out).not.toContain('## Sample:');
  });
});

describe('selectSamples', () => {
  it('matches on a shared token in channel_hint', () => {
    const pool = [
      makeSample({ id: 1, channelHint: 'blog, longform', createdAt: '2026-01-01' }),
      makeSample({ id: 2, channelHint: 'tweet', createdAt: '2026-02-01' }),
    ];
    const out = selectSamples(pool, 'blog');
    expect(out.map((s) => s.id)).toEqual([1]);
  });

  it('falls back to the 2 most recent when no tokens match', () => {
    const pool = [
      makeSample({ id: 1, channelHint: 'tweet', createdAt: '2026-01-01' }),
      makeSample({ id: 2, channelHint: 'email', createdAt: '2026-03-01' }),
      makeSample({ id: 3, channelHint: 'podcast', createdAt: '2026-02-01' }),
    ];
    const out = selectSamples(pool, 'blog');
    // 2 most recent by createdAt desc → id 2 (March), id 3 (February)
    expect(out.map((s) => s.id)).toEqual([2, 3]);
  });

  it('returns an empty array when the pool is empty', () => {
    expect(selectSamples([], 'blog')).toEqual([]);
  });

  it('caps at 2 matching samples even when 5 match', () => {
    const pool = [
      makeSample({ id: 1, channelHint: 'blog', createdAt: '2026-05-01' }),
      makeSample({ id: 2, channelHint: 'blog', createdAt: '2026-04-01' }),
      makeSample({ id: 3, channelHint: 'blog', createdAt: '2026-03-01' }),
      makeSample({ id: 4, channelHint: 'blog', createdAt: '2026-02-01' }),
      makeSample({ id: 5, channelHint: 'blog', createdAt: '2026-01-01' }),
    ];
    const out = selectSamples(pool, 'blog');
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.id)).toEqual([1, 2]);
  });

  it('orders matching samples newest-first', () => {
    const pool = [
      makeSample({ id: 1, channelHint: 'blog, longform', createdAt: '2026-01-01' }),
      makeSample({ id: 2, channelHint: 'blog, longform', createdAt: '2026-06-01' }),
    ];
    const out = selectSamples(pool, 'blog');
    expect(out.map((s) => s.id)).toEqual([2, 1]);
  });

  it('tokenizes multi-token template hints and matches any overlap', () => {
    const pool = [makeSample({ id: 1, channelHint: 'social', createdAt: '2026-01-01' })];
    const out = selectSamples(pool, 'linkedin, short-form, social');
    expect(out.map((s) => s.id)).toEqual([1]);
  });
});

describe('buildUserPrompt', () => {
  it('includes claim, counterarguments, implications, highlights by role, research, and angle', () => {
    const thesis = makeThesis();
    const highlightsByRole: Record<ThesisHighlightRole, HighlightForGeneration[]> = {
      supporting: [
        makeHighlight('supporting', 'Deep work thrives in quiet.', 'Cal Newport'),
        makeHighlight('supporting', 'Open offices reduce focus.'),
      ],
      opposing: [makeHighlight('opposing', 'Collaboration needs proximity.')],
      context: [makeHighlight('context', 'Remote work rose 5x post-2020.')],
    };
    const research = [
      makeResearch({ id: 1, title: 'Focus study 2024', content: 'Deep focus requires silence.' }),
    ];
    const out = buildUserPrompt({
      thesis,
      highlightsByRole,
      research,
      angle: 'Lead with the contrarian take.',
    });

    expect(out).toContain(thesis.claim!);
    expect(out).toContain(thesis.counterarguments!);
    expect(out).toContain(thesis.implications!);
    expect(out).toContain('Supporting');
    expect(out).toContain('Deep work thrives in quiet.');
    expect(out).toContain('Cal Newport');
    expect(out).toContain('Opposing');
    expect(out).toContain('Collaboration needs proximity.');
    expect(out).toContain('Context');
    expect(out).toContain('Focus study 2024');
    expect(out).toContain('Deep focus requires silence.');
    expect(out).toContain('Angle for this piece: Lead with the contrarian take.');
  });

  it('omits optional sections when absent', () => {
    const thesis = makeThesis({
      counterarguments: null,
      implications: null,
    });
    const out = buildUserPrompt({
      thesis,
      highlightsByRole: emptyHighlightsByRole(),
      research: [],
      angle: null,
    });
    expect(out).not.toContain('Counterarguments');
    expect(out).not.toContain('Implications');
    expect(out).not.toContain('Supporting');
    expect(out).not.toContain('Opposing');
    expect(out).not.toContain('Context');
    expect(out).not.toContain('Research');
    expect(out).not.toContain('Angle for this piece');
  });

  it('groups highlights by role regardless of input order', () => {
    const highlightsByRole: Record<ThesisHighlightRole, HighlightForGeneration[]> = {
      supporting: [makeHighlight('supporting', 'SUPPORT-A')],
      opposing: [makeHighlight('opposing', 'OPPOSE-A')],
      context: [makeHighlight('context', 'CONTEXT-A')],
    };
    const out = buildUserPrompt({
      thesis: makeThesis(),
      highlightsByRole,
      research: [],
      angle: null,
    });
    const supportIdx = out.indexOf('SUPPORT-A');
    const opposeIdx = out.indexOf('OPPOSE-A');
    const contextIdx = out.indexOf('CONTEXT-A');
    expect(supportIdx).toBeLessThan(opposeIdx);
    expect(opposeIdx).toBeLessThan(contextIdx);
  });

  it('works with claim-only thesis (no highlights, no research)', () => {
    const out = buildUserPrompt({
      thesis: makeThesis(),
      highlightsByRole: emptyHighlightsByRole(),
      research: [],
      angle: null,
    });
    expect(out).toContain('Claim');
    expect(out).not.toMatch(/# Supporting\s*\n\s*\n\s*#/);
  });

  it('falls back to thesis.title when claim is null', () => {
    const thesis = makeThesis({ title: 'Bare thesis title', claim: null });
    const out = buildUserPrompt({
      thesis,
      highlightsByRole: emptyHighlightsByRole(),
      research: [],
      angle: null,
    });
    expect(out).toContain('Bare thesis title');
  });
});

describe('truncateUserPrompt', () => {
  it('returns the prompt unchanged when under budget', () => {
    const thesis = makeThesis();
    const research = [makeResearch({ id: 1, title: 'R1', content: 'short' })];
    const { prompt, truncated } = truncateUserPrompt({
      thesis,
      highlightsByRole: emptyHighlightsByRole(),
      research,
      angle: null,
      budget: 60_000,
    });
    expect(truncated).toBe(false);
    expect(prompt).toContain('R1');
  });

  it('truncates research entries (keeps thesis + highlights intact)', () => {
    const thesis = makeThesis();
    const fat = 'x'.repeat(40_000);
    const research = [
      makeResearch({ id: 1, title: 'Fat-1', content: fat }),
      makeResearch({ id: 2, title: 'Fat-2', content: fat }),
      makeResearch({ id: 3, title: 'Fat-3', content: fat }),
    ];
    const highlightsByRole: Record<ThesisHighlightRole, HighlightForGeneration[]> = {
      supporting: [makeHighlight('supporting', 'Important support')],
      opposing: [],
      context: [],
    };
    const { prompt, truncated } = truncateUserPrompt({
      thesis,
      highlightsByRole,
      research,
      angle: null,
      budget: 60_000,
    });
    expect(truncated).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(60_000);
    expect(prompt).toContain(thesis.claim!);
    expect(prompt).toContain('Important support');
  });
});

// =============================================================================
// Generator tests (full pipeline with DB + mocked streaming)
// =============================================================================

interface SeededDraft {
  draftId: number;
  thesisId: number;
  articleId: number;
  highlightIds: number[];
  researchIds: number[];
  profileId: number | null;
}

async function seed(
  options: {
    includedHighlightIds?: number[] | null;
    includedResearchIds?: number[] | null;
    voiceProfileMarkdown?: string | null;
    samplesInput?: Array<{
      title: string;
      content: string;
      channelHint?: string | null;
      createdAt?: string;
    }>;
    angle?: string | null;
    templateId?: 'blog' | 'linkedin' | 'youtube';
    lastEditedAt?: string | null;
    existingContent?: string;
    thesisClaim?: string | null;
    thesisCounter?: string | null;
    thesisImpl?: string | null;
    researchEntries?: Array<{ title: string; content: string }>;
    highlightTexts?: Array<{ text: string; role: ThesisHighlightRole }>;
  } = {},
): Promise<SeededDraft> {
  const db = dbMock.mock.db!;

  const [article] = db
    .insert(articles)
    .values({
      url: `https://example.com/a-${Math.random()}`,
      title: 'Seed article',
    })
    .returning()
    .all();
  const articleId = article!.id;

  const [thesis] = db
    .insert(theses)
    .values({
      title: 'Seed thesis',
      claim: options.thesisClaim === undefined ? 'The claim.' : options.thesisClaim,
      counterarguments: options.thesisCounter === undefined ? 'Counter.' : options.thesisCounter,
      implications: options.thesisImpl === undefined ? 'Implications.' : options.thesisImpl,
      status: 'ready',
    })
    .returning()
    .all();
  const thesisId = thesis!.id;

  const highlightTextsInput = options.highlightTexts ?? [
    { text: 'Highlight-1', role: 'supporting' as ThesisHighlightRole },
    { text: 'Highlight-2', role: 'opposing' as ThesisHighlightRole },
  ];

  const highlightIds: number[] = [];
  for (const { text, role } of highlightTextsInput) {
    const [h] = db.insert(highlights).values({ articleId, text }).returning().all();
    highlightIds.push(h!.id);
    db.insert(thesisHighlights).values({ thesisId, highlightId: h!.id, role }).run();
  }

  const researchEntriesInput = options.researchEntries ?? [
    { title: 'Research-1', content: 'Research body 1.' },
  ];
  const researchIds: number[] = [];
  for (const { title, content } of researchEntriesInput) {
    const [r] = db
      .insert(thesisResearch)
      .values({ thesisId, title, content, source: 'manual' })
      .returning()
      .all();
    researchIds.push(r!.id);
  }

  let profileId: number | null = null;
  if (options.voiceProfileMarkdown !== undefined && options.voiceProfileMarkdown !== null) {
    const [p] = db
      .insert(voiceProfile)
      .values({ profile: options.voiceProfileMarkdown, sampleCount: 0 })
      .returning()
      .all();
    profileId = p!.id;
    if (options.samplesInput) {
      for (const s of options.samplesInput) {
        db.insert(voiceSamples)
          .values({
            profileId,
            title: s.title,
            content: s.content,
            wordCount: s.content.split(/\s+/).length,
            channelHint: s.channelHint ?? null,
            createdAt: s.createdAt ?? new Date().toISOString(),
          })
          .run();
      }
    }
  }

  const snapshot = {
    highlightIds:
      options.includedHighlightIds === undefined
        ? highlightIds
        : (options.includedHighlightIds ?? []),
    researchIds:
      options.includedResearchIds === undefined ? researchIds : (options.includedResearchIds ?? []),
  };

  const [draft] = db
    .insert(drafts)
    .values({
      thesisId,
      templateId: options.templateId ?? 'blog',
      title: 'Seed draft',
      content: options.existingContent ?? '',
      angle: options.angle ?? null,
      contextSnapshot: JSON.stringify(snapshot),
      lastEditedAt: options.lastEditedAt ?? null,
    })
    .returning()
    .all();

  return {
    draftId: draft!.id,
    thesisId,
    articleId,
    highlightIds,
    researchIds,
    profileId,
  };
}

async function collect(gen: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

function stubStreamingChunks(chunks: string[]): void {
  vi.mocked(callClaudeStreaming).mockImplementation(async (params) => {
    for (const c of chunks) params.onText(c);
    return {
      text: chunks.join(''),
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  });
}

describe('generateDraft', () => {
  beforeEach(() => {
    dbMock.setup();
    vi.mocked(callClaudeStreaming).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: streams chunks, persists content, clears lastEditedAt', async () => {
    const seeded = await seed({
      voiceProfileMarkdown: '## Profile markdown',
      samplesInput: [{ title: 'Blog sample', content: 'Sample body.', channelHint: 'blog' }],
      lastEditedAt: '2026-04-01T00:00:00.000Z',
      existingContent: 'previous content',
    });
    stubStreamingChunks(['Hello ', 'world', '!']);

    const events = await collect(generateDraft(seeded.draftId));
    expect(
      events.filter((e) => e.type === 'chunk').map((e) => (e as { text: string }).text),
    ).toEqual(['Hello ', 'world', '!']);
    expect(events.at(-1)?.type).toBe('done');

    const db = dbMock.mock.db!;
    const row = db
      .select()
      .from(drafts)
      .where(sql`${drafts.id} = ${seeded.draftId}`)
      .get()!;
    expect(row.content).toBe('Hello world!');
    expect(row.generatedAt).toBeTruthy();
    expect(row.lastEditedAt).toBeNull();
  });

  it('only filtered highlights and research appear in the assembled prompt', async () => {
    const seeded = await seed({
      highlightTexts: [
        { text: 'INCLUDED-1', role: 'supporting' },
        { text: 'INCLUDED-2', role: 'context' },
        { text: 'EXCLUDED-A', role: 'supporting' },
        { text: 'EXCLUDED-B', role: 'opposing' },
      ],
      researchEntries: [
        { title: 'INCLUDED-R1', content: 'kept' },
        { title: 'EXCLUDED-R2', content: 'dropped' },
      ],
    });
    // Rewrite the snapshot to only include the first 2 highlights and the first research entry
    const db = dbMock.mock.db!;
    db.update(drafts)
      .set({
        contextSnapshot: JSON.stringify({
          highlightIds: seeded.highlightIds.slice(0, 2),
          researchIds: seeded.researchIds.slice(0, 1),
        }),
      })
      .where(sql`${drafts.id} = ${seeded.draftId}`)
      .run();

    stubStreamingChunks(['ok']);
    await collect(generateDraft(seeded.draftId));

    const mockFn = vi.mocked(callClaudeStreaming);
    const callArgs = mockFn.mock.calls[0]![0];
    const userPrompt = callArgs.messages[0]!.content;
    expect(userPrompt).toContain('INCLUDED-1');
    expect(userPrompt).toContain('INCLUDED-2');
    expect(userPrompt).toContain('INCLUDED-R1');
    expect(userPrompt).not.toContain('EXCLUDED-A');
    expect(userPrompt).not.toContain('EXCLUDED-B');
    expect(userPrompt).not.toContain('EXCLUDED-R2');
  });

  it('silently skips snapshot IDs that reference deleted content', async () => {
    const seeded = await seed();
    const db = dbMock.mock.db!;
    // Point snapshot at IDs that don't exist
    db.update(drafts)
      .set({ contextSnapshot: JSON.stringify({ highlightIds: [9999], researchIds: [9999] }) })
      .where(sql`${drafts.id} = ${seeded.draftId}`)
      .run();
    stubStreamingChunks(['ok']);

    const events = await collect(generateDraft(seeded.draftId));
    expect(events.at(-1)?.type).toBe('done');
  });

  it('generates without voice profile when none exists', async () => {
    const seeded = await seed(); // no voice profile
    stubStreamingChunks(['ok']);

    await collect(generateDraft(seeded.draftId));

    const mockFn = vi.mocked(callClaudeStreaming);
    const callArgs = mockFn.mock.calls[0]![0];
    expect(callArgs.system).not.toContain('## Sample:');
    expect(callArgs.system).toContain('No voice profile available');
    expect(callArgs.system).toContain(getTemplate('blog').instructions);
  });

  it('aborts cleanly without persisting when abortSignal fires', async () => {
    const seeded = await seed({ existingContent: 'unchanged' });
    const controller = new AbortController();

    vi.mocked(callClaudeStreaming).mockImplementation(async (_params) => {
      controller.abort();
      const err = new Error('Request was aborted');
      err.name = 'AbortError';
      throw err;
    });

    const events = await collect(generateDraft(seeded.draftId, { abortSignal: controller.signal }));
    expect(events.some((e) => e.type === 'error')).toBe(true);

    const db = dbMock.mock.db!;
    const row = db
      .select()
      .from(drafts)
      .where(sql`${drafts.id} = ${seeded.draftId}`)
      .get()!;
    expect(row.content).toBe('unchanged');
    expect(row.generatedAt).toBeNull();
  });

  it('yields error and does not write on Claude API failure', async () => {
    const seeded = await seed({ existingContent: 'unchanged' });
    vi.mocked(callClaudeStreaming).mockRejectedValue(
      new ExternalServiceError('Claude API', 'boom'),
    );

    const events = await collect(generateDraft(seeded.draftId));
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe('error');

    const db = dbMock.mock.db!;
    const row = db
      .select()
      .from(drafts)
      .where(sql`${drafts.id} = ${seeded.draftId}`)
      .get()!;
    expect(row.content).toBe('unchanged');
  });

  it('yields error when draft does not exist', async () => {
    const events = await collect(generateDraft(99999));
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe('error');
    expect(vi.mocked(callClaudeStreaming)).not.toHaveBeenCalled();
  });

  it('yields error when referenced thesis is missing (defensive branch)', async () => {
    const seeded = await seed();
    const sqlite = dbMock.mock.rawDb!;
    // Temporarily disable FKs and hard-delete the thesis, leaving the orphaned draft.
    sqlite.pragma('foreign_keys = OFF');
    sqlite.prepare('DELETE FROM theses WHERE id = ?').run(seeded.thesisId);
    sqlite.pragma('foreign_keys = ON');

    const events = await collect(generateDraft(seeded.draftId));
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe('error');
  });

  it('logs draft_prompt_truncated when the user prompt exceeds the budget', async () => {
    const fat = 'x'.repeat(30_000);
    const seeded = await seed({
      researchEntries: [
        { title: 'R1', content: fat },
        { title: 'R2', content: fat },
        { title: 'R3', content: fat },
      ],
    });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    stubStreamingChunks(['ok']);

    await collect(generateDraft(seeded.draftId));

    const truncatedCall = warnSpy.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === 'draft_prompt_truncated',
    );
    expect(truncatedCall).toBeDefined();
  });
});
