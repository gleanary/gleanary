import { describe, it, expect, vi, beforeEach } from 'vitest';

const { callClaudeMock } = vi.hoisted(() => ({ callClaudeMock: vi.fn() }));
vi.mock('@/lib/ai', () => ({ callClaude: callClaudeMock }));

import { generateChatTitle } from '@/lib/chat-title';
import { UTILITY_MODEL } from '@/lib/models';

const ctx = {
  feature: 'chat_title_generation',
  resourceType: 'chat_session',
  resourceId: 1,
} as const;

/** The exact 200-char answer-like title observed in production. */
const ANSWER_LIKE =
  'I don\'t have access to your library or any previous conversation context. To answer what spaced repetition is "according to your library," I would need you to share what your library says about it.\n\nC';

describe('generateChatTitle', () => {
  beforeEach(() => {
    callClaudeMock.mockReset();
  });

  it('falls back to the first user message when the model answers instead of titling', async () => {
    callClaudeMock.mockResolvedValue(ANSWER_LIKE);

    const title = await generateChatTitle(
      'What is spaced repetition according to my library?',
      ctx,
    );

    expect(title).toBe('What is spaced repetition according to my library?');
    expect(title).not.toContain('\n');
    expect(title).not.toMatch(/^I don't/);
  });

  it('returns a good title unchanged', async () => {
    callClaudeMock.mockResolvedValue('Testing Patterns Discussion');

    const title = await generateChatTitle('What articles discuss testing patterns?', ctx);

    expect(title).toBe('Testing Patterns Discussion');
  });

  it('sends only the first user message, delimited, with a small token budget', async () => {
    callClaudeMock.mockResolvedValue('Testing Patterns Discussion');

    await generateChatTitle('What articles discuss testing patterns?', ctx);

    expect(callClaudeMock).toHaveBeenCalledTimes(1);
    const [system, user, passedCtx, model, maxTokens] = callClaudeMock.mock.calls[0]!;
    expect(system).toContain('3-8 word title');
    expect(system).toMatch(/do not answer/i);
    expect(user).toBe('<message>\nWhat articles discuss testing patterns?\n</message>');
    expect(user).not.toContain('Assistant:');
    expect(passedCtx).toEqual(ctx);
    expect(model).toBe(UTILITY_MODEL);
    expect(maxTokens).toBe(30);
  });

  it.each([
    ['"Testing Patterns Discussion"', 'Testing Patterns Discussion'],
    ["'Testing Patterns Discussion'", 'Testing Patterns Discussion'],
    ['`Testing Patterns Discussion`', 'Testing Patterns Discussion'],
    ['Title: Testing Patterns Discussion', 'Testing Patterns Discussion'],
    ['Testing Patterns Discussion.', 'Testing Patterns Discussion'],
    ['  Testing   Patterns\tDiscussion!  ', 'Testing Patterns Discussion'],
    ['Testing Patterns Discussion\nSome trailing explanation', 'Testing Patterns Discussion'],
  ])('cleans %j', async (raw, expected) => {
    callClaudeMock.mockResolvedValue(raw);

    expect(await generateChatTitle('anything', ctx)).toBe(expected);
  });

  it.each([
    ['empty output', ''],
    ['too long', 'A'.repeat(81)],
    ['too many words', 'one two three four five six seven eight nine ten eleven twelve thirteen'],
    ["answer opener I'm", "I'm happy to help with that"],
    ['answer opener Sorry', 'Sorry I cannot do that'],
    ['answer opener Sure', 'Sure here is a title'],
    ['answer opener As an AI', 'As an AI I cannot'],
    ["answer opener I don't", "I don't have access to your library"],
    ["answer opener Here's", "Here's a title for you"],
  ])('rejects %s and falls back', async (_label, raw) => {
    callClaudeMock.mockResolvedValue(raw);

    expect(await generateChatTitle('Short question', ctx)).toBe('Short question');
  });

  it.each([
    'I Ching divination basics',
    'Surety bonds explained',
    'Hereditary disease genetics',
    'Sorrento travel guide',
  ])('accepts the title %j (answer openers are word-bounded)', async (title) => {
    callClaudeMock.mockResolvedValue(title);

    expect(await generateChatTitle('Short question', ctx)).toBe(title);
  });

  it('never splits a surrogate pair when the fallback has no space to cut at', async () => {
    callClaudeMock.mockRejectedValue(new Error('boom'));

    const title = await generateChatTitle('😀'.repeat(70), ctx);

    expect(title).toBe(`${'😀'.repeat(60)}…`);
    expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('falls back when the title call throws', async () => {
    callClaudeMock.mockRejectedValue(new Error('Claude API: API key not configured'));

    expect(await generateChatTitle('How does  FSRS\nscheduling work?', ctx)).toBe(
      'How does FSRS scheduling work?',
    );
  });

  it('cuts a very long first message at a word boundary with an ellipsis', async () => {
    callClaudeMock.mockResolvedValue(ANSWER_LIKE);
    const message =
      'Can you compare every article I saved about spaced repetition with the ones about active recall and tell me which is better';

    const title = await generateChatTitle(message, ctx);

    expect(title.endsWith('…')).toBe(true);
    const body = title.slice(0, -1);
    expect(body.length).toBeLessThanOrEqual(60);
    expect(message.startsWith(body)).toBe(true);
    expect(message[body.length]).toBe(' ');
  });

  it('returns "New chat" when the fallback message is blank', async () => {
    callClaudeMock.mockRejectedValue(new Error('boom'));

    expect(await generateChatTitle('   \n  ', ctx)).toBe('New chat');
  });
});
