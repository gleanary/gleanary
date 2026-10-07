import { describe, it, expect } from 'vitest';
import { escapeFts5Query, applyPrefixStar } from '@/lib/search';

describe('escapeFts5Query', () => {
  it('returns plain text unchanged', () => {
    expect(escapeFts5Query('hello world')).toBe('hello world');
  });

  it('escapes double quotes by doubling them', () => {
    expect(escapeFts5Query('say "hello"')).toBe('say ""hello""');
  });

  it('replaces asterisk with space', () => {
    expect(escapeFts5Query('test*')).toBe('test');
  });

  it('replaces parentheses with spaces', () => {
    expect(escapeFts5Query('func(arg)')).toBe('func arg');
  });

  it('replaces colons with spaces', () => {
    expect(escapeFts5Query('title:search')).toBe('title search');
  });

  it('replaces carets with spaces', () => {
    expect(escapeFts5Query('word^2')).toBe('word 2');
  });

  it('replaces curly braces with spaces and trims result', () => {
    expect(escapeFts5Query('{near}')).toBe('near');
  });

  it('replaces square brackets with spaces and trims result', () => {
    expect(escapeFts5Query('[test]')).toBe('test');
  });

  it('trims leading and trailing whitespace', () => {
    expect(escapeFts5Query('  hello  ')).toBe('hello');
  });

  it('handles empty string', () => {
    expect(escapeFts5Query('')).toBe('');
  });

  it('handles string with only special characters', () => {
    expect(escapeFts5Query('*()[]{}^:')).toBe('');
  });

  it('handles multiple special characters in sequence', () => {
    expect(escapeFts5Query('user"s (query) [test]*')).toBe('user""s  query   test');
  });
});

describe('applyPrefixStar', () => {
  it('appends * to a single token', () => {
    expect(applyPrefixStar('neural')).toBe('neural*');
  });

  it('appends * only to the last token in a multi-token query', () => {
    expect(applyPrefixStar('machine learning')).toBe('machine learning*');
  });

  it('appends * even when the last token contains doubled quotes (from escapeFts5Query)', () => {
    // escapeFts5Query('neural"') → 'neural""'; prefix star still fires
    expect(applyPrefixStar('neural""')).toBe('neural""*');
  });

  it('appends * to a token that originally ended with * (after escape, * becomes a space)', () => {
    // escapeFts5Query('test*') → 'test'; applyPrefixStar → 'test*'
    expect(applyPrefixStar('test')).toBe('test*');
  });

  it('returns empty string when input is empty', () => {
    expect(applyPrefixStar('')).toBe('');
  });

  it('returns empty string when input is only whitespace', () => {
    expect(applyPrefixStar('   ')).toBe('');
  });

  it('handles multi-token query with extra whitespace', () => {
    expect(applyPrefixStar('foo bar')).toBe('foo bar*');
  });
});
