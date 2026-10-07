import { describe, it, expect } from 'vitest';
import { sanitizeArticleHtml } from '@/lib/sanitize';

describe('sanitizeArticleHtml', () => {
  it('preserves allowed HTML tags', () => {
    const html = '<p>Hello <strong>world</strong></p>';
    expect(sanitizeArticleHtml(html)).toBe('<p>Hello <strong>world</strong></p>');
  });

  it('preserves headings', () => {
    const html = '<h1>Title</h1><h2>Subtitle</h2>';
    const result = sanitizeArticleHtml(html);
    expect(result).toContain('<h1>');
    expect(result).toContain('<h2>');
  });

  it('preserves links with href', () => {
    const html = '<a href="https://example.com">Link</a>';
    expect(sanitizeArticleHtml(html)).toBe('<a href="https://example.com">Link</a>');
  });

  it('preserves images with src and alt', () => {
    const html = '<img src="https://example.com/img.png" alt="test">';
    const result = sanitizeArticleHtml(html);
    expect(result).toContain('src="https://example.com/img.png"');
    expect(result).toContain('alt="test"');
  });

  it('strips script tags', () => {
    const html = '<p>Safe</p><script>alert("xss")</script>';
    const result = sanitizeArticleHtml(html);
    expect(result).not.toContain('<script');
    expect(result).not.toContain('alert');
    expect(result).toContain('<p>Safe</p>');
  });

  it('strips style tags', () => {
    const html = '<style>body{color:red}</style><p>Content</p>';
    const result = sanitizeArticleHtml(html);
    expect(result).not.toContain('<style');
    expect(result).toContain('<p>Content</p>');
  });

  it('strips iframe tags', () => {
    const html = '<iframe src="https://evil.com"></iframe><p>Safe</p>';
    const result = sanitizeArticleHtml(html);
    expect(result).not.toContain('<iframe');
  });

  it('strips form and input tags', () => {
    const html = '<form action="/steal"><input type="text"></form>';
    const result = sanitizeArticleHtml(html);
    expect(result).not.toContain('<form');
    expect(result).not.toContain('<input');
  });

  it('strips object and embed tags', () => {
    const html = '<object data="evil.swf"></object><embed src="evil.swf">';
    const result = sanitizeArticleHtml(html);
    expect(result).not.toContain('<object');
    expect(result).not.toContain('<embed');
  });

  it('strips event handler attributes', () => {
    const html = '<img src="x" onerror="alert(1)">';
    const result = sanitizeArticleHtml(html);
    expect(result).not.toContain('onerror');
  });

  it('strips onclick attributes', () => {
    const html = '<p onclick="alert(1)">Click me</p>';
    const result = sanitizeArticleHtml(html);
    expect(result).not.toContain('onclick');
  });

  it('strips style attributes', () => {
    const html = '<p style="background:url(evil)">Text</p>';
    const result = sanitizeArticleHtml(html);
    expect(result).not.toContain('style=');
  });

  it('preserves data-highlight-id attribute', () => {
    const html = '<mark data-highlight-id="42">Highlighted</mark>';
    const result = sanitizeArticleHtml(html);
    expect(result).toContain('data-highlight-id="42"');
  });

  it('strips arbitrary data attributes (ALLOW_DATA_ATTR is false)', () => {
    const html = '<div data-custom="value">Content</div>';
    const result = sanitizeArticleHtml(html);
    expect(result).not.toContain('data-custom');
  });

  it('handles empty string', () => {
    expect(sanitizeArticleHtml('')).toBe('');
  });

  it('strips noscript tags', () => {
    const html = '<noscript><img src="tracker.png"></noscript><p>Content</p>';
    const result = sanitizeArticleHtml(html);
    expect(result).not.toContain('<noscript');
  });

  it('preserves table structure', () => {
    const html =
      '<table><thead><tr><th>Header</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table>';
    const result = sanitizeArticleHtml(html);
    expect(result).toContain('<table>');
    expect(result).toContain('<th>Header</th>');
    expect(result).toContain('<td>Cell</td>');
  });

  it('preserves code blocks', () => {
    const html = '<pre><code>const x = 1;</code></pre>';
    const result = sanitizeArticleHtml(html);
    expect(result).toContain('<pre>');
    expect(result).toContain('<code>');
  });

  it('strips javascript: URLs in href', () => {
    const html = '<a href="javascript:alert(1)">Click</a>';
    const result = sanitizeArticleHtml(html);
    expect(result).not.toContain('javascript:');
  });
});
