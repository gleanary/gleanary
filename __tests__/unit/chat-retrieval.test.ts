import { describe, it, expect } from 'vitest';
import {
  parseScope,
  extractKeywordsHeuristic,
  buildConversationHistory,
} from '@/lib/chat-retrieval';

describe('parseScope', () => {
  it('parses "all" scope', () => {
    expect(parseScope('all')).toEqual({ type: 'all' });
  });

  it('parses article scope', () => {
    expect(parseScope('article:42')).toEqual({ type: 'article', articleId: 42 });
  });

  it('throws on invalid scope', () => {
    expect(() => parseScope('invalid')).toThrow('Invalid scope');
  });

  it('throws on malformed article scope', () => {
    expect(() => parseScope('article:abc')).toThrow('Invalid scope');
  });

  it('throws on empty string', () => {
    expect(() => parseScope('')).toThrow('Invalid scope');
  });

  it('parses thesis scope', () => {
    expect(parseScope('thesis:5')).toEqual({ type: 'thesis', thesisId: 5 });
  });

  it('parses tag scope', () => {
    expect(parseScope('tag:machine learning')).toEqual({
      type: 'tag',
      tagName: 'machine learning',
    });
  });

  it('parses tag scope with special characters', () => {
    expect(parseScope('tag:AI/ML')).toEqual({ type: 'tag', tagName: 'AI/ML' });
  });

  it('parses recent scope', () => {
    expect(parseScope('recent:30')).toEqual({ type: 'recent', days: 30 });
  });

  it('throws on malformed thesis scope', () => {
    expect(() => parseScope('thesis:abc')).toThrow('Invalid scope');
  });

  it('throws on malformed recent scope', () => {
    expect(() => parseScope('recent:abc')).toThrow('Invalid scope');
  });
});

describe('extractKeywordsHeuristic', () => {
  it('extracts keywords removing stop words', () => {
    const keywords = extractKeywordsHeuristic('What articles discuss regulatory capture?');
    expect(keywords).toContain('articles');
    expect(keywords).toContain('discuss');
    expect(keywords).toContain('regulatory');
    expect(keywords).toContain('capture');
    expect(keywords).not.toContain('what');
  });

  it('handles short input', () => {
    const keywords = extractKeywordsHeuristic('AI');
    expect(keywords).toEqual([]);
  });

  it('deduplicates keywords', () => {
    const keywords = extractKeywordsHeuristic('testing testing testing patterns');
    expect(keywords.filter((k) => k === 'testing')).toHaveLength(1);
  });

  it('limits to 10 keywords', () => {
    const long = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike';
    const keywords = extractKeywordsHeuristic(long);
    expect(keywords.length).toBeLessThanOrEqual(10);
  });
});

describe('buildConversationHistory', () => {
  it('returns all messages for short conversations', () => {
    const messages = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi there' },
    ];
    const history = buildConversationHistory(messages, 20_000);
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('applies sliding window for long conversations', () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `Message ${i}`,
    }));
    const history = buildConversationHistory(messages, 20_000);
    // First 2 + gap marker + last 6 = 9
    expect(history).toHaveLength(9);
    expect(history[0]!.content).toBe('Message 0');
    expect(history[1]!.content).toBe('Message 1');
    expect(history[2]!.content).toContain('omitted');
    expect(history[history.length - 1]!.content).toBe('Message 19');
  });

  it('returns all messages when exactly 8', () => {
    const messages = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `Message ${i}`,
    }));
    const history = buildConversationHistory(messages, 20_000);
    expect(history).toHaveLength(8);
  });
});
