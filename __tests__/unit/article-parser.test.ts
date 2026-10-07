import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseArticleFromHtml } from '@/lib/article-parser';

const richHtml = readFileSync(join(__dirname, '../mocks/fixtures/rich-article.html'), 'utf-8');
const minimalHtml = readFileSync(
  join(__dirname, '../mocks/fixtures/minimal-article.html'),
  'utf-8',
);

const BASE_URL = 'https://example.com/blog/2024/web-architecture';

describe('parseArticleFromHtml', () => {
  it('extracts title from article', async () => {
    const result = await parseArticleFromHtml(richHtml, BASE_URL);
    expect(result.title).toBe('Understanding Modern Web Architecture');
  });

  it('extracts author from meta tag', async () => {
    const result = await parseArticleFromHtml(richHtml, BASE_URL);
    expect(result.author).toBe('Jane Smith');
  });

  it('extracts siteName from og:site_name', async () => {
    const result = await parseArticleFromHtml(richHtml, BASE_URL);
    expect(result.siteName).toBe('Tech Blog');
  });

  it('extracts imageUrl from og:image', async () => {
    const result = await parseArticleFromHtml(richHtml, BASE_URL);
    expect(result.imageUrl).toBe('https://example.com/images/hero.jpg');
  });

  it('extracts publishedAt from meta tag', async () => {
    const result = await parseArticleFromHtml(richHtml, BASE_URL);
    expect(result.publishedAt).toBe('2024-06-15T10:30:00Z');
  });

  it('returns sanitized HTML (no script tags)', async () => {
    const result = await parseArticleFromHtml(richHtml, BASE_URL);
    expect(result.contentHtml).not.toContain('<script');
    expect(result.contentHtml).not.toContain('alert');
    expect(result.contentHtml).not.toContain('document.write');
  });

  it('returns sanitized HTML (no style tags)', async () => {
    const result = await parseArticleFromHtml(richHtml, BASE_URL);
    expect(result.contentHtml).not.toContain('<style');
  });

  it('preserves allowed HTML elements', async () => {
    const result = await parseArticleFromHtml(richHtml, BASE_URL);
    expect(result.contentHtml).toContain('<p>');
    expect(result.contentHtml).toContain('<h2>');
  });

  it('extracts plain text content', async () => {
    const result = await parseArticleFromHtml(richHtml, BASE_URL);
    expect(result.contentText).toContain('Modern web applications');
    expect(result.contentText).not.toContain('<p>');
    expect(result.contentText).not.toContain('<h2>');
  });

  it('computes word count from plain text', async () => {
    const result = await parseArticleFromHtml(richHtml, BASE_URL);
    expect(result.wordCount).toBeGreaterThan(100);
    expect(typeof result.wordCount).toBe('number');
  });

  it('generates excerpt', async () => {
    const result = await parseArticleFromHtml(richHtml, BASE_URL);
    expect(result.excerpt).toBeDefined();
    expect(result.excerpt!.length).toBeGreaterThan(0);
    expect(result.excerpt!.length).toBeLessThanOrEqual(300);
  });

  it('resolves relative image URLs to absolute', async () => {
    const result = await parseArticleFromHtml(richHtml, BASE_URL);
    // /images/hero.jpg should resolve to https://example.com/images/hero.jpg
    expect(result.contentHtml).not.toMatch(/src="\/images\//);
    expect(result.contentHtml).toContain('https://example.com/images/');
    // diagrams/architecture.png should resolve relative to the article URL
    expect(result.contentHtml).not.toMatch(/src="diagrams\//);
  });

  it('resolves relative link URLs to absolute', async () => {
    const result = await parseArticleFromHtml(richHtml, BASE_URL);
    // /about should resolve to https://example.com/about
    expect(result.contentHtml).not.toMatch(/href="\/about"/);
    expect(result.contentHtml).toContain('https://example.com/about');
  });

  it('sets url to the provided base URL', async () => {
    const result = await parseArticleFromHtml(richHtml, BASE_URL);
    expect(result.url).toBe(BASE_URL);
  });

  it('handles minimal HTML gracefully', async () => {
    const result = await parseArticleFromHtml(minimalHtml, 'https://example.com/minimal');
    expect(result.title).toBeDefined();
    expect(result.title.length).toBeGreaterThan(0);
    expect(result.contentText).toBeDefined();
    expect(result.url).toBe('https://example.com/minimal');
  });

  it('falls back to page title when extraction finds none', async () => {
    const html =
      '<html><head><title>Fallback Title</title></head><body><p>Short.</p></body></html>';
    const result = await parseArticleFromHtml(html, 'https://example.com/fallback');
    expect(result.title).toBe('Fallback Title');
  });

  it('returns null fields for missing metadata', async () => {
    const html =
      '<html><head><title>No Meta</title></head><body><article><p>Content paragraph one here for readability to pick up.</p><p>Content paragraph two for readability.</p><p>Content paragraph three for readability extraction.</p></article></body></html>';
    const result = await parseArticleFromHtml(html, 'https://example.com/no-meta');
    expect(result.author).toBeNull();
    expect(result.publishedAt).toBeNull();
  });

  it('handles empty HTML without throwing', async () => {
    const result = await parseArticleFromHtml('', 'https://example.com/empty');
    expect(result.title).toBeDefined();
    expect(result.url).toBe('https://example.com/empty');
  });

  it('stores the raw input HTML as contentOriginalHtml', async () => {
    const result = await parseArticleFromHtml(richHtml, BASE_URL);
    expect(result.contentOriginalHtml).toBe(richHtml);
  });

  it('populates contentMarkdown as a non-empty string', async () => {
    const result = await parseArticleFromHtml(richHtml, BASE_URL);
    expect(typeof result.contentMarkdown).toBe('string');
    expect(result.contentMarkdown.length).toBeGreaterThan(0);
  });

  it('contentMarkdown contains article text without HTML tags', async () => {
    const result = await parseArticleFromHtml(richHtml, BASE_URL);
    expect(result.contentMarkdown).not.toContain('<p>');
    expect(result.contentMarkdown).not.toContain('<h2>');
    expect(result.contentMarkdown).toContain('Modern web applications');
  });

  it('returns empty contentOriginalHtml and contentMarkdown for empty input', async () => {
    const result = await parseArticleFromHtml('', 'https://example.com/empty');
    expect(result.contentOriginalHtml).toBe('');
    expect(typeof result.contentMarkdown).toBe('string');
  });
});
