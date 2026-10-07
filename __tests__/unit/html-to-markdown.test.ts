import { describe, it, expect } from 'vitest';
import { convertHtmlToMarkdown } from '@/lib/html-to-markdown';

describe('convertHtmlToMarkdown', () => {
  it('returns empty string for empty input', () => {
    expect(convertHtmlToMarkdown('')).toBe('');
  });

  it('converts paragraphs to plain text', () => {
    const html = '<p>Hello world</p>';
    expect(convertHtmlToMarkdown(html)).toBe('Hello world');
  });

  it('converts headings to atx style', () => {
    const html = '<h1>Title</h1><h2>Subtitle</h2>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('# Title');
    expect(md).toContain('## Subtitle');
  });

  it('preserves images as markdown syntax', () => {
    const html = '<img src="https://example.com/img.jpg" alt="A photo">';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('https://example.com/img.jpg');
    expect(md).toContain('A photo');
  });

  it('converts blockquotes', () => {
    const html = '<blockquote><p>Quoted text</p></blockquote>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('> Quoted text');
  });

  it('converts unordered lists', () => {
    const html = '<ul><li>Item one</li><li>Item two</li></ul>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toMatch(/^-\s+Item one/m);
    expect(md).toMatch(/^-\s+Item two/m);
  });

  it('converts ordered lists', () => {
    const html = '<ol><li>First</li><li>Second</li></ol>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toMatch(/^1\.\s+First/m);
    expect(md).toMatch(/^2\.\s+Second/m);
  });

  it('strips empty links (no text content)', () => {
    const html = '<p>Text <a href="https://example.com"></a> more</p>';
    const md = convertHtmlToMarkdown(html);
    expect(md).not.toContain('https://example.com');
    expect(md).toContain('Text');
    expect(md).toContain('more');
  });

  it('keeps links that have text content', () => {
    const html = '<a href="https://example.com">Click here</a>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('Click here');
    expect(md).toContain('https://example.com');
  });

  it('strips empty paragraphs', () => {
    const html = '<p>Real content</p><p>   </p><p>More content</p>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('Real content');
    expect(md).toContain('More content');
    // Should not have a paragraph with only whitespace
    expect(md.trim().replace(/\n+/g, '\n')).not.toMatch(/^\s*$/m);
  });

  it('converts bold and italic', () => {
    const html = '<p><strong>bold</strong> and <em>italic</em></p>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('**bold**');
    expect(md).toContain('_italic_');
  });

  it('converts code blocks', () => {
    const html = '<pre><code>const x = 1;</code></pre>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('const x = 1;');
    expect(md).toContain('```');
  });

  it('handles HTML with no meaningful content', () => {
    const html = '<div><span></span></div>';
    const md = convertHtmlToMarkdown(html);
    expect(typeof md).toBe('string');
  });
});
