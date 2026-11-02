import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  computeWordCount,
  readingTime,
  formatDate,
  formatRelativeTime,
  parseDbTimestamp,
  stripCodeFences,
  parseAiTags,
} from '@/lib/text-utils';

describe('computeWordCount', () => {
  it('counts words in a simple sentence', () => {
    expect(computeWordCount('hello world foo')).toBe(3);
  });

  it('handles multiple spaces between words', () => {
    expect(computeWordCount('hello   world')).toBe(2);
  });

  it('handles tabs and newlines', () => {
    expect(computeWordCount('hello\tworld\nfoo')).toBe(3);
  });

  it('returns 0 for empty string', () => {
    expect(computeWordCount('')).toBe(0);
  });

  it('returns 0 for whitespace-only string', () => {
    expect(computeWordCount('   ')).toBe(0);
  });

  it('counts single word', () => {
    expect(computeWordCount('hello')).toBe(1);
  });
});

describe('readingTime', () => {
  it('returns "1 min read" for very short articles', () => {
    expect(readingTime(50)).toBe('1 min read');
  });

  it('returns "1 min read" for zero words', () => {
    expect(readingTime(0)).toBe('1 min read');
  });

  it('computes correct reading time for longer articles', () => {
    // 238 WPM average, 1190 words = ~5 minutes
    expect(readingTime(1190)).toBe('5 min read');
  });

  it('rounds to nearest minute', () => {
    // 238 * 2.4 = ~571 words -> rounds to 2
    expect(readingTime(571)).toBe('2 min read');
  });

  it('returns "N pages" when wordCount is null and pageCount is provided', () => {
    expect(readingTime(null, 42)).toBe('42 pages');
  });

  it('returns "1 page" for single-page PDF', () => {
    expect(readingTime(null, 1)).toBe('1 page');
  });

  it('returns "N pages" when wordCount is 0 and pageCount is provided', () => {
    expect(readingTime(0, 10)).toBe('10 pages');
  });

  it('prefers page count for PDFs even when wordCount is set', () => {
    expect(readingTime(500, 5)).toBe('5 pages');
  });

  it('falls back to WPM when pageCount is 0', () => {
    expect(readingTime(500, 0)).toBe('2 min read');
  });

  it('returns "1 min read" when both wordCount and pageCount are null', () => {
    expect(readingTime(null, null)).toBe('1 min read');
  });
});

describe('stripCodeFences', () => {
  it('strips a fenced block with an html language tag', () => {
    expect(stripCodeFences('```html\n<p>hi</p>\n```')).toBe('<p>hi</p>');
  });

  it('strips a fenced block with no language tag', () => {
    expect(stripCodeFences('```\n<p>hi</p>\n```')).toBe('<p>hi</p>');
  });

  it('passes through text with no fences unchanged', () => {
    expect(stripCodeFences('<p>hi</p>')).toBe('<p>hi</p>');
  });

  it('trims leading and trailing whitespace before stripping fences', () => {
    expect(stripCodeFences('  \n```html\n<p>hi</p>\n```  \n')).toBe('<p>hi</p>');
  });
});

describe('formatDate', () => {
  it('formats a valid ISO date string', () => {
    const result = formatDate('2024-01-15T12:00:00Z');
    expect(result).toBe('January 15, 2024');
  });

  it('formats a date-only string', () => {
    expect(formatDate('2024-06-01')).toBe('June 1, 2024');
  });

  it('returns original string for invalid date', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date');
  });

  it('returns original string for empty string', () => {
    expect(formatDate('')).toBe('');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('west of UTC (America/New_York)', () => {
    beforeEach(() => {
      vi.stubEnv('TZ', 'America/New_York');
    });

    it('prints the stored calendar day for a date-only string', () => {
      expect(formatDate('2024-01-15')).toBe('January 15, 2024');
    });

    it('converts a full ISO timestamp to local time', () => {
      expect(formatDate('2024-01-15T03:00:00Z')).toBe('January 14, 2024');
    });

    it('converts an RFC 822 timestamp to local time', () => {
      expect(formatDate('Mon, 15 Jan 2024 03:00:00 GMT')).toBe('January 14, 2024');
    });
  });

  describe('east of UTC (Europe/Paris)', () => {
    beforeEach(() => {
      vi.stubEnv('TZ', 'Europe/Paris');
    });

    it('reads a naive DB timestamp as UTC', () => {
      // 23:30 UTC is already the next day in Paris
      expect(formatDate('2026-11-02 23:30:00')).toBe('November 3, 2026');
    });
  });
});

describe('parseDbTimestamp', () => {
  it('reads a space-separated DB timestamp as UTC', () => {
    expect(parseDbTimestamp('2026-11-02 23:30:00').toISOString()).toBe('2026-11-02T23:30:00.000Z');
  });

  it('reads a zone-less ISO timestamp as UTC', () => {
    expect(parseDbTimestamp('2026-11-02T23:30:00').toISOString()).toBe('2026-11-02T23:30:00.000Z');
  });

  it('keeps an explicit zone', () => {
    expect(parseDbTimestamp('2026-11-02T23:30:00+02:00').toISOString()).toBe(
      '2026-11-02T21:30:00.000Z',
    );
  });
});

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T23:35:00Z'));
    vi.stubEnv('TZ', 'Europe/Paris');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('reads a naive DB timestamp as UTC', () => {
    expect(formatRelativeTime('2026-11-02 23:30:00')).toBe('5m ago');
  });

  it('accepts a timestamp that already carries a zone', () => {
    expect(formatRelativeTime('2026-11-02T22:35:00Z')).toBe('1h ago');
  });
});

describe('parseAiTags', () => {
  it('returns [] for null without reporting it', () => {
    const onInvalid = vi.fn();
    expect(parseAiTags(null, onInvalid)).toEqual([]);
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it('returns [] for an empty string without reporting it', () => {
    const onInvalid = vi.fn();
    expect(parseAiTags('', onInvalid)).toEqual([]);
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it('drops repeated tag names', () => {
    expect(parseAiTags('["ai", "ai", "Databases"]')).toEqual(['ai', 'Databases']);
  });

  it('parses a JSON array of strings', () => {
    expect(parseAiTags('["ai", "Machine Learning"]')).toEqual(['ai', 'Machine Learning']);
  });

  it('returns [] and reports it for invalid JSON', () => {
    const onInvalid = vi.fn();
    expect(parseAiTags('not json', onInvalid)).toEqual([]);
    expect(onInvalid).toHaveBeenCalledTimes(1);
  });

  it('returns [] and reports it when the JSON is not an array', () => {
    const onInvalid = vi.fn();
    expect(parseAiTags('{"tags": ["ai"]}', onInvalid)).toEqual([]);
    expect(onInvalid).toHaveBeenCalledTimes(1);
  });

  it('returns [] and reports it when an item is not a string', () => {
    const onInvalid = vi.fn();
    expect(parseAiTags('["ai", 42]', onInvalid)).toEqual([]);
    expect(onInvalid).toHaveBeenCalledTimes(1);
  });
});
