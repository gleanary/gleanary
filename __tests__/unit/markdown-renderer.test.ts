/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '@/lib/markdown-renderer';

/**
 * Unit tests for renderMarkdown = marked.parse + sanitizeArticleHtml (DOMPurify).
 * Runs under jsdom so DOMPurify has a DOM to operate on. Covers both benign
 * markdown rendering and the hostile-input XSS vectors mandated by
 * architecture.md §16 (script tags, event handlers, javascript: URLs).
 */
describe('renderMarkdown', () => {
  describe('benign markdown', () => {
    it('renders a heading to an <h1> preserving the text', () => {
      const result = renderMarkdown('# Hello World');
      expect(result).toContain('<h1');
      expect(result).toContain('Hello World');
      expect(result).toContain('</h1>');
    });

    it('renders a markdown link to an anchor with an http href', () => {
      const result = renderMarkdown('[Example](https://example.com)');
      expect(result).toContain('href="https://example.com"');
      expect(result).toContain('Example');
    });

    it('renders bold text to <strong> and keeps the words', () => {
      const result = renderMarkdown('Hello **world**');
      expect(result).toContain('<strong>world</strong>');
      expect(result).toContain('Hello');
    });

    it('renders a fenced code block to <pre><code> preserving the source text', () => {
      const result = renderMarkdown('```\nconst x = 1;\n```');
      expect(result).toContain('<pre>');
      expect(result).toContain('<code');
      expect(result).toContain('const x = 1;');
    });

    it('returns an empty string for empty input', () => {
      expect(renderMarkdown('')).toBe('');
    });
  });

  describe('hostile input (XSS vectors)', () => {
    it('strips a raw <script> tag and its payload', () => {
      const result = renderMarkdown('Safe text\n\n<script>alert(1)</script>');
      expect(result).not.toContain('<script');
      expect(result).not.toContain('alert(1)');
      expect(result).toContain('Safe text');
    });

    it('strips the onerror handler from an inline <img>', () => {
      const result = renderMarkdown('<img src=x onerror=alert(1)>');
      expect(result).not.toContain('onerror');
      expect(result).not.toContain('alert(1)');
    });

    it('neutralizes a javascript: href in a markdown link', () => {
      const result = renderMarkdown('[Click](javascript:alert(1))');
      expect(result).not.toContain('javascript:');
      expect(result).not.toContain('alert(1)');
    });

    it('strips inline event-handler attributes such as onclick', () => {
      const result = renderMarkdown('<p onclick="alert(1)">Click me</p>');
      expect(result).not.toContain('onclick');
      expect(result).not.toContain('alert(1)');
      expect(result).toContain('Click me');
    });
  });
});
