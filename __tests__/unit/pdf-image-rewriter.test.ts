import { describe, it, expect } from 'vitest';
import { rewriteImageRefs } from '@/lib/pdf-image-rewriter';

const ARTICLE_ID = 42;

function stored(...names: string[]): Set<string> {
  return new Set(names);
}

describe('rewriteImageRefs', () => {
  it('rewrites a single stored image ref to the API URL', () => {
    const md = '![Figure 1](img-0.jpeg)';
    const result = rewriteImageRefs(md, stored('img-0.jpeg'), ARTICLE_ID);
    expect(result).toBe(`![Figure 1](/api/articles/${ARTICLE_ID}/images/img-0.jpeg)`);
  });

  it('rewrites multiple stored image refs independently', () => {
    const md = '![A](img-0.jpeg)\n\nSome text.\n\n![B](img-1.png)';
    const result = rewriteImageRefs(md, stored('img-0.jpeg', 'img-1.png'), ARTICLE_ID);
    expect(result).toContain(`/api/articles/${ARTICLE_ID}/images/img-0.jpeg`);
    expect(result).toContain(`/api/articles/${ARTICLE_ID}/images/img-1.png`);
  });

  it('strips orphan refs (name not in stored set)', () => {
    const md = 'Before. ![Orphan](img-orphan.jpeg) After.';
    const result = rewriteImageRefs(md, stored(), ARTICLE_ID);
    expect(result).not.toContain('img-orphan.jpeg');
    expect(result).toContain('Before.');
    expect(result).toContain('After.');
  });

  it('rewrites stored refs and strips orphan refs in the same document', () => {
    const md = '![Good](img-0.jpeg) text ![Bad](img-bad.jpeg)';
    const result = rewriteImageRefs(md, stored('img-0.jpeg'), ARTICLE_ID);
    expect(result).toContain(`/api/articles/${ARTICLE_ID}/images/img-0.jpeg`);
    expect(result).not.toContain('img-bad.jpeg');
  });

  it('preserves surrounding text when rewriting refs', () => {
    const md = 'Intro text.\n\n![Fig](img-0.jpeg)\n\nTrailing text.';
    const result = rewriteImageRefs(md, stored('img-0.jpeg'), ARTICLE_ID);
    expect(result).toContain('Intro text.');
    expect(result).toContain('Trailing text.');
  });

  it('handles title-form refs: title is dropped, rewrite succeeds for stored names', () => {
    const md = '![Figure 1](img-0.jpeg "A caption")';
    const result = rewriteImageRefs(md, stored('img-0.jpeg'), ARTICLE_ID);
    expect(result).toBe(`![Figure 1](/api/articles/${ARTICLE_ID}/images/img-0.jpeg)`);
    expect(result).not.toContain('"A caption"');
  });

  it('strips title-form refs for orphan names', () => {
    const md = '![Figure](img-orphan.jpeg "caption")';
    const result = rewriteImageRefs(md, stored(), ARTICLE_ID);
    expect(result).not.toContain('img-orphan.jpeg');
    expect(result).not.toContain('caption');
  });

  it('returns markdown unchanged when there are no image refs', () => {
    const md = '# Heading\n\nSome paragraph with [a link](https://example.com).';
    expect(rewriteImageRefs(md, stored(), ARTICLE_ID)).toBe(md);
  });

  it('returns empty string unchanged', () => {
    expect(rewriteImageRefs('', stored(), ARTICLE_ID)).toBe('');
  });
});
