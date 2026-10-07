import { describe, it, expect } from 'vitest';
import { buildSnippet } from '@/lib/search-snippets';

describe('buildSnippet', () => {
  it('wraps sentinel-marked text with <mark> tags', () => {
    expect(buildSnippet('hello \x01world\x02 end')).toBe('hello <mark>world</mark> end');
  });

  it('HTML-escapes < and > so <script> tags are inert', () => {
    const input = '<script>alert(1)</script> \x01match\x02';
    const result = buildSnippet(input);
    expect(result).toBe('&lt;script&gt;alert(1)&lt;/script&gt; <mark>match</mark>');
    expect(result).not.toContain('<script>');
  });

  it('HTML-escapes <img onerror=...> payloads', () => {
    const input = '<img onerror=alert(1)> \x01match\x02';
    const result = buildSnippet(input);
    expect(result).toContain('&lt;img');
    expect(result).not.toContain('<img');
    expect(result).toContain('<mark>match</mark>');
  });

  it('HTML-escapes ampersands', () => {
    expect(buildSnippet('AT&T \x01match\x02')).toBe('AT&amp;T <mark>match</mark>');
  });

  it('HTML-escapes double quotes', () => {
    expect(buildSnippet('"quoted" \x01match\x02')).toBe('&quot;quoted&quot; <mark>match</mark>');
  });

  it('HTML-escapes single quotes', () => {
    expect(buildSnippet("it's \x01match\x02")).toBe('it&#39;s <mark>match</mark>');
  });

  it('handles a literal \\x01 byte in stored text — it becomes a bare <mark> (not stripped at ingestion)', () => {
    // Per spec §6.1: control bytes \x01/\x02 are NOT stripped at ingestion. A literal
    // byte that survives in stored text becomes an attribute-less <mark> tag. This is
    // harmless precisely because HTML-escaping (step 2) runs before substitution (step 3),
    // so the byte can never carry other tags, attributes, or script — the escape-first
    // ordering is the load-bearing control, not ingestion filtering.
    const result = buildSnippet('\x01orphan');
    expect(result).toBe('<mark>orphan');
  });

  it('handles multiple sentinel pairs in one snippet', () => {
    expect(buildSnippet('\x01foo\x02 bar \x01baz\x02')).toBe(
      '<mark>foo</mark> bar <mark>baz</mark>',
    );
  });

  it('returns plain text unchanged when no sentinels present', () => {
    expect(buildSnippet('plain text here')).toBe('plain text here');
  });

  it('returns empty string for empty input', () => {
    expect(buildSnippet('')).toBe('');
  });
});
