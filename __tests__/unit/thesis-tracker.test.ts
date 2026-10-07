import { describe, it, expect } from 'vitest';
import { parseThesisSuggestions, parseHighlightSuggestions } from '@/lib/ai';

describe('parseThesisSuggestions', () => {
  it('parses valid JSON suggestions array', () => {
    const raw = JSON.stringify([
      {
        title: 'AI kills careers not jobs',
        claim: 'AI eliminates specific career paths...',
        relevantHighlightIds: [1, 2, 3],
        confidence: 0.85,
      },
      {
        title: 'Remote work increases output',
        claim: 'Distributed teams produce more...',
        relevantHighlightIds: [4, 5],
        confidence: 0.72,
      },
    ]);

    const result = parseThesisSuggestions(raw);
    expect(result).toHaveLength(2);
    expect(result[0]!.title).toBe('AI kills careers not jobs');
    expect(result[0]!.relevantHighlightIds).toEqual([1, 2, 3]);
    expect(result[0]!.confidence).toBe(0.85);
    expect(result[1]!.title).toBe('Remote work increases output');
  });

  it('extracts JSON embedded in surrounding text', () => {
    const raw = `Here are my suggestions:\n[\n{"title":"Test thesis","claim":"A claim","relevantHighlightIds":[],"confidence":0.9}\n]\nEnd.`;
    const result = parseThesisSuggestions(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe('Test thesis');
  });

  it('returns empty array on invalid JSON', () => {
    expect(parseThesisSuggestions('not valid json')).toEqual([]);
    expect(parseThesisSuggestions('')).toEqual([]);
    expect(parseThesisSuggestions('{ bad: json }')).toEqual([]);
  });

  it('filters out items missing required title field', () => {
    const raw = JSON.stringify([
      { title: 'Valid thesis', claim: 'A claim', relevantHighlightIds: [], confidence: 0.8 },
      { claim: 'No title here', relevantHighlightIds: [], confidence: 0.5 },
    ]);
    const result = parseThesisSuggestions(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe('Valid thesis');
  });
});

describe('parseHighlightSuggestions', () => {
  it('parses valid highlight suggestion array', () => {
    const raw = JSON.stringify([
      {
        highlightId: 42,
        suggestedRole: 'supporting',
        reason: 'Provides empirical evidence',
      },
      {
        highlightId: 17,
        suggestedRole: 'opposing',
        reason: 'Contradicts main claim',
      },
    ]);

    const result = parseHighlightSuggestions(raw);
    expect(result).toHaveLength(2);
    expect(result[0]!.highlightId).toBe(42);
    expect(result[0]!.suggestedRole).toBe('supporting');
    expect(result[1]!.highlightId).toBe(17);
    expect(result[1]!.suggestedRole).toBe('opposing');
  });

  it('extracts JSON embedded in surrounding text', () => {
    const raw = `Some text [\n{"highlightId":5,"suggestedRole":"context","reason":"Background info"}\n]`;
    const result = parseHighlightSuggestions(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.highlightId).toBe(5);
  });

  it('returns empty array on invalid or empty input', () => {
    expect(parseHighlightSuggestions('')).toEqual([]);
    expect(parseHighlightSuggestions('not json')).toEqual([]);
  });

  it('filters out items missing required highlightId', () => {
    const raw = JSON.stringify([
      { highlightId: 1, suggestedRole: 'supporting', reason: 'Good' },
      { suggestedRole: 'opposing', reason: 'No id' },
    ]);
    const result = parseHighlightSuggestions(raw);
    expect(result).toHaveLength(1);
  });
});
