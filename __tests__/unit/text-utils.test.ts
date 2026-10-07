import { describe, it, expect } from 'vitest';
import { computeWordCount, readingTime, formatDate, stripCodeFences } from '@/lib/text-utils';

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
    const result = formatDate('2024-06-01');
    // The exact output depends on timezone, but it should contain the year
    expect(result).toContain('2024');
  });

  it('returns original string for invalid date', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date');
  });

  it('returns original string for empty string', () => {
    expect(formatDate('')).toBe('');
  });
});
