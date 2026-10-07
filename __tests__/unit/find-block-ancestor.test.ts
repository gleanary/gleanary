// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { findBlockAncestor } from '@/components/reader/highlight-layer';

describe('findBlockAncestor', () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.innerHTML = '';
    document.body.appendChild(root);
  });

  it('returns <p> when clicking on text inside a paragraph', () => {
    root.innerHTML = '<p>Hello world</p>';
    const p = root.querySelector('p')!;
    expect(findBlockAncestor(p, root)).toBe(p);
  });

  it('returns <p> when clicking on inline element inside paragraph', () => {
    root.innerHTML = '<p>Hello <strong>bold</strong> world</p>';
    const strong = root.querySelector('strong')!;
    expect(findBlockAncestor(strong, root)).toBe(root.querySelector('p'));
  });

  it('returns <li> when clicking inside a list item', () => {
    root.innerHTML = '<ul><li>Item one</li><li>Item two</li></ul>';
    const li = root.querySelectorAll('li')[1]!;
    expect(findBlockAncestor(li, root)).toBe(li);
  });

  it('returns <blockquote> when clicking inside a blockquote without nested blocks', () => {
    root.innerHTML = '<blockquote>A quote</blockquote>';
    const bq = root.querySelector('blockquote')!;
    expect(findBlockAncestor(bq, root)).toBe(bq);
  });

  it('returns innermost <p> for nested blockquote > p', () => {
    root.innerHTML = '<blockquote><p>Quoted paragraph</p></blockquote>';
    const p = root.querySelector('p')!;
    expect(findBlockAncestor(p, root)).toBe(p);
  });

  it('returns heading elements', () => {
    root.innerHTML = '<h2>Section Title</h2><p>Content</p>';
    const h2 = root.querySelector('h2')!;
    expect(findBlockAncestor(h2, root)).toBe(h2);
  });

  it('returns <pre> for code blocks', () => {
    root.innerHTML = '<pre><code>const x = 1;</code></pre>';
    const code = root.querySelector('code')!;
    expect(findBlockAncestor(code, root)).toBe(root.querySelector('pre'));
  });

  it('returns <td> for table cells', () => {
    root.innerHTML = '<table><tbody><tr><td>Cell</td></tr></tbody></table>';
    const td = root.querySelector('td')!;
    expect(findBlockAncestor(td, root)).toBe(td);
  });

  it('returns <figcaption> for figure captions', () => {
    root.innerHTML = '<figure><img src="x"><figcaption>Caption</figcaption></figure>';
    const fc = root.querySelector('figcaption')!;
    expect(findBlockAncestor(fc, root)).toBe(fc);
  });

  it('returns null when clicking on the content root div itself', () => {
    root.innerHTML = '<p>Hello</p>';
    expect(findBlockAncestor(root, root)).toBeNull();
  });

  it('returns null for elements outside the root', () => {
    const outside = document.createElement('p');
    document.body.appendChild(outside);
    expect(findBlockAncestor(outside, root)).toBeNull();
  });

  it('returns null for non-block elements directly under root', () => {
    root.innerHTML = '<span>Loose text</span>';
    const span = root.querySelector('span')!;
    expect(findBlockAncestor(span, root)).toBeNull();
  });
});

describe('mark highlight-id extraction for click-to-select', () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.innerHTML = '';
    document.body.appendChild(root);
  });

  it('extracts highlight ID from mark element on double-click target', () => {
    root.innerHTML =
      '<p><mark data-highlight-id="42" class="highlight highlight-yellow">Hello world</mark></p>';
    const mark = root.querySelector('mark')!;
    const closest = mark.closest('mark[data-highlight-id]');
    expect(closest).toBe(mark);
    const id = parseInt(closest!.getAttribute('data-highlight-id')!, 10);
    expect(id).toBe(42);
  });

  it('extracts highlight ID when clicking inline element inside mark', () => {
    root.innerHTML =
      '<p><mark data-highlight-id="7" class="highlight"><strong>bold text</strong></mark></p>';
    const strong = root.querySelector('strong')!;
    const closest = strong.closest('mark[data-highlight-id]');
    expect(closest).not.toBeNull();
    const id = parseInt(closest!.getAttribute('data-highlight-id')!, 10);
    expect(id).toBe(7);
  });

  it('returns null for mark without data-highlight-id', () => {
    root.innerHTML = '<p><mark>plain mark</mark></p>';
    const mark = root.querySelector('mark')!;
    const closest = mark.closest('mark[data-highlight-id]');
    expect(closest).toBeNull();
  });

  it('returns NaN for non-numeric highlight ID', () => {
    root.innerHTML = '<p><mark data-highlight-id="abc">text</mark></p>';
    const mark = root.querySelector('mark')!;
    const closest = mark.closest('mark[data-highlight-id]')!;
    const id = parseInt(closest.getAttribute('data-highlight-id')!, 10);
    expect(id).toBeNaN();
  });
});
