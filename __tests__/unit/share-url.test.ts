import { describe, it, expect } from 'vitest';
import { extractSharedUrl } from '@/lib/share-url';

describe('extractSharedUrl', () => {
  it('returns the url param when it is an http(s) URL', () => {
    expect(extractSharedUrl('https://example.com/a', 'ignored')).toBe('https://example.com/a');
  });

  it('extracts the URL from text when the url param is missing', () => {
    expect(extractSharedUrl(null, 'Great read https://example.com/post?id=1')).toBe(
      'https://example.com/post?id=1',
    );
  });

  it('extracts the URL from text when the url param is not a URL', () => {
    expect(extractSharedUrl('Some title', 'Some title\nhttp://example.com/x')).toBe(
      'http://example.com/x',
    );
  });

  it('returns the first URL when text contains several', () => {
    expect(extractSharedUrl(null, 'https://a.com/1 and https://b.com/2')).toBe('https://a.com/1');
  });

  it('strips trailing punctuation around the URL', () => {
    expect(extractSharedUrl(null, 'Read this (https://example.com/a).')).toBe(
      'https://example.com/a',
    );
    expect(extractSharedUrl(null, '"https://example.com/b",')).toBe('https://example.com/b');
  });

  it('strips typographic quotes and ellipses around the URL', () => {
    expect(extractSharedUrl(null, 'Read “https://example.com/a”')).toBe('https://example.com/a');
    expect(extractSharedUrl(null, 'see https://example.com/b…')).toBe('https://example.com/b');
    expect(extractSharedUrl(null, '«https://example.com/c»')).toBe('https://example.com/c');
    expect(extractSharedUrl(null, "'https://example.com/d'")).toBe('https://example.com/d');
  });

  it('keeps an apostrophe inside the URL', () => {
    expect(extractSharedUrl("https://example.com/what's-new", null)).toBe(
      "https://example.com/what's-new",
    );
  });

  it('keeps balanced parentheses inside the URL', () => {
    expect(extractSharedUrl(null, 'https://en.wikipedia.org/wiki/Foo_(bar)')).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    );
  });

  it('returns null when no URL is present', () => {
    expect(extractSharedUrl(null, 'just some text')).toBeNull();
    expect(extractSharedUrl(null, null)).toBeNull();
    expect(extractSharedUrl('', '')).toBeNull();
  });

  it('ignores non-http schemes', () => {
    expect(extractSharedUrl('javascript:alert(1)', 'ftp://example.com/file')).toBeNull();
  });
});
