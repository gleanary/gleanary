// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import katex from 'katex';
import {
  serializeRange,
  deserializeRange,
  getNodePath,
  getNodeFromPath,
  rangeToCharOffsets,
  charOffsetsToRange,
  stripHighlightMarks,
  extractRangeText,
  getRootText,
  describeRange,
  anchorToRange,
  recoverAnchorFromText,
  ANCHOR_CONTEXT_LEN,
  type PositionData,
} from '@/lib/highlight-anchoring';
import type { TextQuoteAnchor } from '@/types';

describe('highlight-anchoring', () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.innerHTML = '';
    document.body.appendChild(root);
  });

  describe('getNodePath', () => {
    it('returns empty array for the root element itself', () => {
      expect(getNodePath(root, root)).toEqual([]);
    });

    it('returns path for a direct text child', () => {
      root.innerHTML = 'Hello world';
      const textNode = root.childNodes[0]!;
      expect(getNodePath(textNode, root)).toEqual([0]);
    });

    it('returns path for nested element child', () => {
      root.innerHTML = '<p>First</p><p>Second</p>';
      const secondP = root.childNodes[1]!;
      expect(getNodePath(secondP, root)).toEqual([1]);
    });

    it('returns path for deeply nested text node', () => {
      root.innerHTML = '<p>Hello <strong>bold <em>italic</em></strong></p>';
      const em = root.querySelector('em')!;
      const textInEm = em.childNodes[0]!;
      // root → p(0) → strong(1) → em(1) → text(0)
      expect(getNodePath(textInEm, root)).toEqual([0, 1, 1, 0]);
    });

    it('returns null for node outside root', () => {
      const other = document.createElement('span');
      document.body.appendChild(other);
      expect(getNodePath(other, root)).toBeNull();
    });
  });

  describe('getNodeFromPath', () => {
    it('returns root for empty path', () => {
      expect(getNodeFromPath([], root)).toBe(root);
    });

    it('returns direct text child', () => {
      root.innerHTML = 'Hello';
      expect(getNodeFromPath([0], root)).toBe(root.childNodes[0]);
    });

    it('returns deeply nested node', () => {
      root.innerHTML = '<p>Hello <strong>bold <em>italic</em></strong></p>';
      const em = root.querySelector('em')!;
      const textInEm = em.childNodes[0]!;
      expect(getNodeFromPath([0, 1, 1, 0], root)).toBe(textInEm);
    });

    it('returns null for invalid path', () => {
      root.innerHTML = '<p>Hello</p>';
      expect(getNodeFromPath([5, 0], root)).toBeNull();
    });
  });

  describe('serializeRange', () => {
    it('serializes a simple text selection', () => {
      root.innerHTML = '<p>Hello world</p>';
      const textNode = root.querySelector('p')!.childNodes[0]!;

      const range = document.createRange();
      range.setStart(textNode, 6);
      range.setEnd(textNode, 11);

      const data = serializeRange(range, root);
      expect(data).toEqual({
        startContainerPath: [0, 0],
        startOffset: 6,
        endContainerPath: [0, 0],
        endOffset: 11,
        text: 'world',
      });
    });

    it('serializes a cross-element selection', () => {
      root.innerHTML = '<p>Hello</p><p>World</p>';
      const startText = root.querySelectorAll('p')[0]!.childNodes[0]!;
      const endText = root.querySelectorAll('p')[1]!.childNodes[0]!;

      const range = document.createRange();
      range.setStart(startText, 3);
      range.setEnd(endText, 3);

      const data = serializeRange(range, root);
      expect(data.startContainerPath).toEqual([0, 0]);
      expect(data.startOffset).toBe(3);
      expect(data.endContainerPath).toEqual([1, 0]);
      expect(data.endOffset).toBe(3);
      expect(data.text).toBe('loWor');
    });

    it('handles selection in nested formatting', () => {
      root.innerHTML = '<p>Hello <strong>bold text</strong> end</p>';
      const boldText = root.querySelector('strong')!.childNodes[0]!;

      const range = document.createRange();
      range.setStart(boldText, 0);
      range.setEnd(boldText, 4);

      const data = serializeRange(range, root);
      expect(data.text).toBe('bold');
      expect(data.startContainerPath).toEqual([0, 1, 0]);
    });
  });

  describe('deserializeRange', () => {
    it('deserializes a simple text selection', () => {
      root.innerHTML = '<p>Hello world</p>';

      const data: PositionData = {
        startContainerPath: [0, 0],
        startOffset: 6,
        endContainerPath: [0, 0],
        endOffset: 11,
        text: 'world',
      };

      const range = deserializeRange(data, root);
      expect(range).not.toBeNull();
      expect(range!.toString()).toBe('world');
    });

    it('deserializes a cross-element selection', () => {
      root.innerHTML = '<p>Hello</p><p>World</p>';

      const data: PositionData = {
        startContainerPath: [0, 0],
        startOffset: 3,
        endContainerPath: [1, 0],
        endOffset: 3,
        text: 'loWor',
      };

      const range = deserializeRange(data, root);
      expect(range).not.toBeNull();
    });

    it('returns null for invalid path', () => {
      root.innerHTML = '<p>Hello</p>';

      const data: PositionData = {
        startContainerPath: [5, 0],
        startOffset: 0,
        endContainerPath: [5, 0],
        endOffset: 3,
        text: 'nope',
      };

      const range = deserializeRange(data, root);
      expect(range).toBeNull();
    });

    it('returns null when offset exceeds node length', () => {
      root.innerHTML = '<p>Hi</p>';

      const data: PositionData = {
        startContainerPath: [0, 0],
        startOffset: 0,
        endContainerPath: [0, 0],
        endOffset: 100,
        text: 'too long',
      };

      const range = deserializeRange(data, root);
      expect(range).toBeNull();
    });
  });

  describe('round-trip', () => {
    it('round-trips a simple selection', () => {
      root.innerHTML = '<p>The quick brown fox jumps over the lazy dog.</p>';
      const textNode = root.querySelector('p')!.childNodes[0]!;

      const range = document.createRange();
      range.setStart(textNode, 10);
      range.setEnd(textNode, 19);

      const data = serializeRange(range, root);
      expect(data.text).toBe('brown fox');

      const restored = deserializeRange(data, root);
      expect(restored).not.toBeNull();
      expect(restored!.toString()).toBe('brown fox');
      expect(restored!.startOffset).toBe(10);
      expect(restored!.endOffset).toBe(19);
    });

    it('round-trips a selection across nested elements', () => {
      root.innerHTML = '<p>Start <strong>bold <em>and italic</em></strong> end.</p>';
      const startText = root.querySelector('p')!.childNodes[0]!; // "Start "
      const italicText = root.querySelector('em')!.childNodes[0]!; // "and italic"

      const range = document.createRange();
      range.setStart(startText, 0);
      range.setEnd(italicText, 3);

      const data = serializeRange(range, root);
      const restored = deserializeRange(data, root);
      expect(restored).not.toBeNull();
      expect(restored!.startContainer).toBe(startText);
      expect(restored!.startOffset).toBe(0);
      expect(restored!.endContainer).toBe(italicText);
      expect(restored!.endOffset).toBe(3);
    });

    it('round-trips a selection with unicode text', () => {
      root.innerHTML = '<p>Caf\u00e9 \u2014 r\u00e9sum\u00e9 \ud83c\udf0d world</p>';
      const textNode = root.querySelector('p')!.childNodes[0]!;

      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 4);

      const data = serializeRange(range, root);
      expect(data.text).toBe('Caf\u00e9');

      const restored = deserializeRange(data, root);
      expect(restored).not.toBeNull();
      expect(restored!.toString()).toBe('Caf\u00e9');
    });

    it('round-trips with empty text between elements', () => {
      root.innerHTML = '<p><span>First</span><span>Second</span></p>';
      const secondText = root.querySelectorAll('span')[1]!.childNodes[0]!;

      const range = document.createRange();
      range.setStart(secondText, 0);
      range.setEnd(secondText, 6);

      const data = serializeRange(range, root);
      expect(data.text).toBe('Second');

      const restored = deserializeRange(data, root);
      expect(restored).not.toBeNull();
      expect(restored!.toString()).toBe('Second');
    });
  });

  describe('rangeToCharOffsets', () => {
    it('returns correct offsets for a simple text range', () => {
      root.innerHTML = '<p>Hello world</p>';
      const textNode = root.querySelector('p')!.childNodes[0]!;

      const range = document.createRange();
      range.setStart(textNode, 6);
      range.setEnd(textNode, 11);

      const offsets = rangeToCharOffsets(range, root);
      expect(offsets).toEqual({ start: 6, end: 11 });
    });

    it('returns correct offsets for a cross-element range', () => {
      root.innerHTML = '<p>Hello</p><p>World</p>';
      const startText = root.querySelectorAll('p')[0]!.childNodes[0]!;
      const endText = root.querySelectorAll('p')[1]!.childNodes[0]!;

      const range = document.createRange();
      range.setStart(startText, 3);
      range.setEnd(endText, 3);

      const offsets = rangeToCharOffsets(range, root);
      expect(offsets.start).toBe(3);
      expect(offsets.end).toBe(8); // "Hello" (5) + "Wor" (3)
    });

    it('returns zero-based offsets from the start of the root', () => {
      root.innerHTML = '<p>ABC</p>';
      const textNode = root.querySelector('p')!.childNodes[0]!;

      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 3);

      const offsets = rangeToCharOffsets(range, root);
      expect(offsets).toEqual({ start: 0, end: 3 });
    });

    it('handles nested formatting elements', () => {
      root.innerHTML = '<p>Hello <strong>bold</strong> end</p>';
      const boldText = root.querySelector('strong')!.childNodes[0]!;

      const range = document.createRange();
      range.setStart(boldText, 0);
      range.setEnd(boldText, 4);

      const offsets = rangeToCharOffsets(range, root);
      // "Hello " = 6 chars before bold text
      expect(offsets).toEqual({ start: 6, end: 10 });
    });
  });

  describe('charOffsetsToRange', () => {
    it('converts offsets back to a range in simple text', () => {
      root.innerHTML = '<p>Hello world</p>';

      const range = charOffsetsToRange(6, 11, root);
      expect(range).not.toBeNull();
      expect(range!.toString()).toBe('world');
    });

    it('converts offsets spanning multiple elements', () => {
      root.innerHTML = '<p>Hello</p><p>World</p>';

      const range = charOffsetsToRange(3, 8, root);
      expect(range).not.toBeNull();
      expect(range!.toString()).toBe('loWor');
    });

    it('returns null for out-of-bounds offsets', () => {
      root.innerHTML = '<p>Short</p>';

      const range = charOffsetsToRange(0, 100, root);
      expect(range).toBeNull();
    });

    it('handles offsets within nested formatting', () => {
      root.innerHTML = '<p>Hello <strong>bold</strong> end</p>';

      // offset 6-10 = "bold"
      const range = charOffsetsToRange(6, 10, root);
      expect(range).not.toBeNull();
      expect(range!.toString()).toBe('bold');
    });

    it('round-trips with rangeToCharOffsets', () => {
      root.innerHTML = '<p>Start <em>middle</em> end</p>';
      const emText = root.querySelector('em')!.childNodes[0]!;

      const original = document.createRange();
      original.setStart(emText, 0);
      original.setEnd(emText, 6);

      const offsets = rangeToCharOffsets(original, root);
      const restored = charOffsetsToRange(offsets.start, offsets.end, root);
      expect(restored).not.toBeNull();
      expect(restored!.toString()).toBe('middle');
    });
  });

  describe('stripHighlightMarks', () => {
    it('removes mark elements and preserves text content', () => {
      root.innerHTML = '<p>Hello <mark data-highlight-id="1">world</mark> end</p>';

      stripHighlightMarks(root);

      expect(root.querySelector('mark')).toBeNull();
      expect(root.textContent).toBe('Hello world end');
    });

    it('normalizes text nodes after stripping', () => {
      root.innerHTML = '<p>Hello <mark data-highlight-id="1">world</mark> end</p>';

      stripHighlightMarks(root);

      const p = root.querySelector('p')!;
      // After normalize, "Hello ", "world", and " end" should merge into one text node
      expect(p.childNodes.length).toBe(1);
      expect(p.childNodes[0]!.textContent).toBe('Hello world end');
    });

    it('handles multiple marks', () => {
      root.innerHTML =
        '<p><mark data-highlight-id="1">First</mark> and <mark data-highlight-id="2">Second</mark></p>';

      stripHighlightMarks(root);

      expect(root.querySelectorAll('mark').length).toBe(0);
      expect(root.textContent).toBe('First and Second');
    });

    it('preserves non-mark elements', () => {
      root.innerHTML = '<p>Hello <strong><mark data-highlight-id="1">bold</mark></strong> end</p>';

      stripHighlightMarks(root);

      expect(root.querySelector('mark')).toBeNull();
      expect(root.querySelector('strong')).not.toBeNull();
      expect(root.querySelector('strong')!.textContent).toBe('bold');
    });

    it('uses custom selector when provided', () => {
      root.innerHTML =
        '<p><mark data-highlight-id="1">keep</mark> <mark class="custom">remove</mark></p>';

      stripHighlightMarks(root, 'mark.custom');

      // Only custom marks removed
      expect(root.querySelectorAll('mark').length).toBe(1);
      expect(root.querySelector('mark[data-highlight-id]')).not.toBeNull();
    });

    it('is a no-op when no marks exist', () => {
      root.innerHTML = '<p>No marks here</p>';
      const htmlBefore = root.innerHTML;

      stripHighlightMarks(root);

      expect(root.innerHTML).toBe(htmlBefore);
    });
  });

  describe('text-search anchoring', () => {
    it('finds text at the start of the article', () => {
      root.innerHTML = '<p>Introduction paragraph here.</p>';
      const searchText = 'Introduction';
      const articleText = root.textContent ?? '';
      const idx = articleText.indexOf(searchText);
      expect(idx).toBe(0);
      const range = charOffsetsToRange(idx, idx + searchText.length, root);
      expect(range).not.toBeNull();
      expect(range!.toString()).toBe('Introduction');
    });

    it('finds text in the middle of the article', () => {
      root.innerHTML = '<p>First sentence.</p><p>Great insight here.</p><p>Last sentence.</p>';
      const searchText = 'Great insight here.';
      const articleText = root.textContent ?? '';
      const idx = articleText.indexOf(searchText);
      expect(idx).toBeGreaterThan(0);
      const range = charOffsetsToRange(idx, idx + searchText.length, root);
      expect(range).not.toBeNull();
      expect(range!.toString()).toBe('Great insight here.');
    });

    it('returns -1 (no match) when text is not in the article', () => {
      root.innerHTML = '<p>Some content here.</p>';
      const articleText = root.textContent ?? '';
      const idx = articleText.indexOf('text not present in article');
      expect(idx).toBe(-1);
    });

    it('trims leading/trailing whitespace before searching', () => {
      root.innerHTML = '<p>The key insight was remarkable.</p>';
      const searchText = '  key insight was  ';
      const articleText = root.textContent ?? '';
      const trimmed = searchText.trim();
      const idx = articleText.indexOf(trimmed);
      expect(idx).toBeGreaterThan(0);
      const range = charOffsetsToRange(idx, idx + trimmed.length, root);
      expect(range).not.toBeNull();
      expect(range!.toString()).toBe('key insight was');
    });

    it('finds text spanning across two paragraphs', () => {
      root.innerHTML = '<p>End of first.</p><p>Start of second.</p>';
      const articleText = root.textContent ?? '';
      // textContent concatenates without separator: "End of first.Start of second."
      const searchText = 'first.Start';
      const idx = articleText.indexOf(searchText);
      expect(idx).toBeGreaterThan(0);
      const range = charOffsetsToRange(idx, idx + searchText.length, root);
      expect(range).not.toBeNull();
      expect(range!.toString()).toBe('first.Start');
    });

    it('handles highlight text inside nested formatting elements', () => {
      root.innerHTML = '<p>See <strong>this important point</strong> for details.</p>';
      const searchText = 'this important point';
      const articleText = root.textContent ?? '';
      const idx = articleText.indexOf(searchText);
      expect(idx).toBeGreaterThan(0);
      const range = charOffsetsToRange(idx, idx + searchText.length, root);
      expect(range).not.toBeNull();
      expect(range!.toString()).toBe('this important point');
    });
  });
});

// --- v2 text-quote anchoring (position_data v2) ---

/** Builds a fresh, attached content root from HTML (mirrors a re-parsed article). */
function makeRoot(html: string): HTMLDivElement {
  const r = document.createElement('div');
  r.innerHTML = html;
  document.body.appendChild(r);
  return r;
}

/** Describes a [start, end) char-offset span of `root` as a v2 anchor. */
function anchorFor(root: Element, start: number, end: number): TextQuoteAnchor {
  const range = charOffsetsToRange(start, end, root);
  if (!range) throw new Error('test offsets out of bounds');
  return describeRange(root, range);
}

/** Describes the first occurrence of `quote` in `root` as a v2 anchor. */
function anchorForQuote(root: Element, quote: string): TextQuoteAnchor {
  const idx = (root.textContent ?? '').indexOf(quote);
  if (idx < 0) throw new Error(`quote not found: ${quote}`);
  return anchorFor(root, idx, idx + quote.length);
}

describe('getRootText', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('equals root.textContent (raw, in-document-order concatenation, no normalization)', () => {
    const root = makeRoot('<p>Alpha</p><p>Beta  <em>gamma</em>\tdelta</p>');
    expect(getRootText(root)).toBe(root.textContent);
  });

  it('length matches the summed length the SHOW_TEXT TreeWalker visits', () => {
    // Invariant lock: the stream must never silently diverge from the offset machinery
    // (charOffsetsToRange / rangeToCharOffsets) that walks the same text nodes.
    const root = makeRoot('<p>One <strong>two <em>three</em></strong> four.</p><p>Five</p>');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let sum = 0;
    let n = walker.nextNode();
    while (n) {
      sum += (n as Text).length;
      n = walker.nextNode();
    }
    expect(getRootText(root).length).toBe(sum);
  });
});

describe('describeRange', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('captures exact, prefix, suffix, and offsets', () => {
    const root = makeRoot('<p>The quick brown fox jumps over the lazy dog.</p>');
    const anchor = anchorForQuote(root, 'fox');
    expect(anchor.v).toBe(2);
    expect(anchor.exact).toBe('fox');
    expect(anchor.start).toBe(16);
    expect(anchor.end).toBe(19);
    expect(anchor.prefix).toBe('The quick brown ');
    expect(anchor.suffix).toBe(' jumps over the lazy dog.');
  });

  it('caps prefix and suffix at ANCHOR_CONTEXT_LEN', () => {
    const long = 'x'.repeat(100);
    const root = makeRoot(`<p>${long}QUOTE${long}</p>`);
    const anchor = anchorForQuote(root, 'QUOTE');
    expect(anchor.prefix.length).toBe(ANCHOR_CONTEXT_LEN);
    expect(anchor.suffix.length).toBe(ANCHOR_CONTEXT_LEN);
  });

  it('describes a cross-element span (stream is concatenated without separators)', () => {
    const root = makeRoot('<p>Hello world</p><p>Goodbye moon</p>');
    const text = root.textContent ?? ''; // "Hello worldGoodbye moon"
    const start = text.indexOf('world');
    const end = text.indexOf('Goodbye') + 'Goodbye'.length;
    const anchor = anchorFor(root, start, end);
    expect(anchor.exact).toBe('worldGoodbye');
  });
});

describe('anchorToRange', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('round-trips describe → resolve on the same DOM (position fast path)', () => {
    const root = makeRoot('<p>The quick brown fox jumps over the lazy dog.</p>');
    const anchor = anchorForQuote(root, 'brown fox');
    const resolved = anchorToRange(root, anchor);
    expect(resolved).not.toBeNull();
    expect(resolved!.toString()).toBe('brown fox');
  });

  it('resolves after a node is inserted BEFORE the highlight (offsets shift)', () => {
    const root = makeRoot('<p>Alpha beta gamma delta epsilon.</p>');
    const anchor = anchorForQuote(root, 'gamma');
    const root2 = makeRoot(
      '<p>Inserted preamble sentence.</p><p>Alpha beta gamma delta epsilon.</p>',
    );
    const resolved = anchorToRange(root2, anchor);
    expect(resolved).not.toBeNull();
    expect(resolved!.toString()).toBe('gamma');
  });

  it('resolves after a node is inserted AFTER the highlight', () => {
    const root = makeRoot('<p>Alpha beta gamma delta epsilon.</p>');
    const anchor = anchorForQuote(root, 'gamma');
    const root2 = makeRoot(
      '<p>Alpha beta gamma delta epsilon.</p><p>Appended trailing sentence.</p>',
    );
    const resolved = anchorToRange(root2, anchor);
    expect(resolved).not.toBeNull();
    expect(resolved!.toString()).toBe('gamma');
  });

  it('resolves when a node is inserted INSIDE the highlight (within fuzzy tolerance)', () => {
    const root = makeRoot('<p>Alpha beta gammazone delta.</p>');
    const anchor = anchorForQuote(root, 'gammazone');
    // A formatting span splits the quote: "gamma" + "zone" with an element boundary,
    // and an extra char drift — still within maxErrors for a 9-char quote.
    const root2 = makeRoot('<p>Alpha beta gamma<b>X</b>zone delta.</p>');
    const resolved = anchorToRange(root2, anchor);
    expect(resolved).not.toBeNull();
    expect(resolved!.toString()).toMatch(/gamma.*zone/);
  });

  it('disambiguates a repeated quote using prefix/suffix context', () => {
    const root = makeRoot('<p>The cat sat. The cat ran. The cat slept.</p>');
    const text = root.textContent ?? '';
    const secondIdx = text.indexOf('cat', text.indexOf('cat') + 1);
    const anchor = anchorFor(root, secondIdx, secondIdx + 3);
    // Re-parsed DOM with a prefix prepended so the fast path misses and all three remain.
    const root2 = makeRoot('<p>Intro. The cat sat. The cat ran. The cat slept.</p>');
    const resolved = anchorToRange(root2, anchor);
    expect(resolved).not.toBeNull();
    const start = rangeToCharOffsets(resolved!, root2).start;
    expect((root2.textContent ?? '').slice(start, start + 7)).toBe('cat ran');
  });

  it('resolves when the surrounding context changed but exact is intact (budget regression)', () => {
    // Exact-primary matching: the error budget is sized to `exact`, so heavy context
    // drift must NOT orphan a highlight whose quote is still verbatim present.
    const root = makeRoot('<p>Before context here. IMPORTANT QUOTE. After context here.</p>');
    const anchor = anchorForQuote(root, 'IMPORTANT QUOTE');
    const root2 = makeRoot(
      '<p>A totally different preamble paragraph now. IMPORTANT QUOTE. And an entirely rewritten trailing clause follows.</p>',
    );
    const resolved = anchorToRange(root2, anchor);
    expect(resolved).not.toBeNull();
    expect(resolved!.toString()).toBe('IMPORTANT QUOTE');
  });

  it('absorbs whitespace drift within tolerance', () => {
    const root = makeRoot('<p>machine learning models</p>');
    const anchor = anchorForQuote(root, 'machine learning models');
    const root2 = makeRoot('<p>machine  learning  models</p>'); // doubled spaces (2 inserts)
    const resolved = anchorToRange(root2, anchor);
    expect(resolved).not.toBeNull();
  });

  it('orphans (returns null) when drift exceeds tolerance', () => {
    const root = makeRoot('<p>machine learning models</p>');
    const anchor = anchorForQuote(root, 'machine learning models');
    const root2 = makeRoot('<p>quantum entanglement theory</p>');
    expect(anchorToRange(root2, anchor)).toBeNull();
  });

  it('orphans when the quote is removed entirely', () => {
    const root = makeRoot('<p>The passphrase is swordfish indeed.</p>');
    const anchor = anchorForQuote(root, 'swordfish');
    const root2 = makeRoot('<p>The passphrase is unknown indeed.</p>');
    expect(anchorToRange(root2, anchor)).toBeNull();
  });

  it('resolves a cross-element span on a freshly parsed DOM', () => {
    const html = '<p>Hello world</p><p>Goodbye moon</p>';
    const root = makeRoot(html);
    const anchor = (() => {
      const text = root.textContent ?? '';
      const start = text.indexOf('world');
      const end = text.indexOf('Goodbye') + 'Goodbye'.length;
      return anchorFor(root, start, end);
    })();
    const root2 = makeRoot(html);
    const resolved = anchorToRange(root2, anchor);
    expect(resolved).not.toBeNull();
    expect(resolved!.toString()).toBe('worldGoodbye');
  });

  it('is idempotent: re-resolving an unchanged anchor never drifts offsets', () => {
    const root = makeRoot('<p>Stable anchor text that does not move at all.</p>');
    const anchor = anchorForQuote(root, 'anchor text');
    const o1 = rangeToCharOffsets(anchorToRange(root, anchor)!, root);
    const o2 = rangeToCharOffsets(anchorToRange(root, anchor)!, root);
    // Fast path returns the stored offsets verbatim — no recompute, no drift.
    expect(o1).toEqual({ start: anchor.start, end: anchor.end });
    expect(o2).toEqual(o1);
  });
});

describe('offset reproducibility', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('produces identical offsets from two independent parses of the same HTML', () => {
    const html = '<p>Reproducible <strong>offsets</strong> stay put here.</p>';
    const a = anchorForQuote(makeRoot(html), 'offsets');
    const b = anchorForQuote(makeRoot(html), 'offsets');
    expect(b.start).toBe(a.start);
    expect(b.end).toBe(a.end);
    expect(b.exact).toBe(a.exact);
    expect(b.prefix).toBe(a.prefix);
    expect(b.suffix).toBe(a.suffix);
  });
});

describe('recoverAnchorFromText', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('synthesizes a v2 anchor from stored text alone (no prior offsets/context)', () => {
    const root = makeRoot('<p>Some preamble. The recoverable sentence is here. A tail.</p>');
    const anchor = recoverAnchorFromText(root, 'The recoverable sentence is here.');
    expect(anchor).not.toBeNull();
    expect(anchor!.v).toBe(2);
    expect(anchor!.exact).toBe('The recoverable sentence is here.');
    expect(anchorToRange(root, anchor!)!.toString()).toBe('The recoverable sentence is here.');
  });

  it('returns null when the text is absent', () => {
    const root = makeRoot('<p>nothing relevant here at all</p>');
    expect(recoverAnchorFromText(root, 'a quote that does not exist anywhere')).toBeNull();
  });
});

// --- KaTeX class-name contract (pins the classes getTextFromNode depends on) ---
//
// These tests render real KaTeX markup with the installed version (0.18.1) and assert
// that extractRangeText reconstructs the LaTeX source from it. They exist to catch a
// future KaTeX bump that renames any of the four load-bearing class names
// ('katex', 'katex-mathml', 'katex-html', 'katex-display') or drops the
// annotation[encoding="application/x-tex"] element (the contract documented in
// docs/modules/highlight-anchoring.md). 0.18.0 prefixed only the *internal* classes
// (base->katex-base, strut->katex-strut, ...), which this code never touches.
describe('KaTeX text extraction (class-name contract)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /** Selects the whole root and runs the extraction the reader uses on a highlight range. */
  function extractWhole(root: Element): string {
    const range = document.createRange();
    range.selectNodeContents(root);
    return extractRangeText(range);
  }

  it('round-trips inline math to $latex$ with no duplicate MathML text', () => {
    const math = katex.renderToString('E=mc^2', { throwOnError: false });
    const root = makeRoot(`<p>Before ${math} after</p>`);
    // Exact equality is the double-extraction guard: range.toString() would include
    // BOTH the MathML annotation text and the visual HTML rendering; we get neither
    // duplicated. Just the single reconstructed source between the surrounding words.
    expect(extractWhole(root)).toBe('Before $E=mc^2$ after');
  });

  it('round-trips display math (wrapped in .katex-display) to $$latex$$', () => {
    const math = katex.renderToString('\\int_0^1 x^2 dx', {
      throwOnError: false,
      displayMode: true,
    });
    const root = makeRoot(`<p>Intro</p>${math}<p>Outro</p>`);
    expect(extractWhole(root)).toBe('Intro$$\\int_0^1 x^2 dx$$Outro');
  });

  it('extracts zero text from a .katex-mathml subtree (no double extraction)', () => {
    const math = katex.renderToString('a+b', { throwOnError: false });
    const root = makeRoot(`<p>${math}</p>`);
    const mathml = root.querySelector('.katex-mathml')!;
    expect(mathml).not.toBeNull();
    const range = document.createRange();
    range.selectNode(mathml); // clone the katex-mathml element itself
    expect(extractRangeText(range)).toBe('');
  });

  it('falls back to .katex-html textContent when the annotation is missing', () => {
    const math = katex.renderToString('E=mc^2', { throwOnError: false });
    const root = makeRoot(`<p>${math}</p>`);
    // Simulate markup with no LaTeX annotation to reconstruct from.
    root.querySelector('annotation[encoding="application/x-tex"]')!.remove();
    const htmlText = root.querySelector('.katex-html')!.textContent ?? '';
    expect(htmlText).not.toBe('');
    const extracted = extractWhole(root);
    expect(extracted).toBe(htmlText);
    // No $ delimiters when the source annotation is unavailable.
    expect(extracted).not.toContain('$');
  });

  it('handles invalid LaTeX rendered as a .katex-error span without breaking extraction', () => {
    const math = katex.renderToString('\\frac{', { throwOnError: false });
    // 0.18.1 renders an unrecoverable parse error as <span class="katex-error">…</span>
    // containing the raw source (no .katex wrapper), so it extracts as plain text.
    expect(math).toContain('katex-error');
    const root = makeRoot(`<p>Before ${math} after</p>`);
    const extracted = extractWhole(root);
    expect(extracted).toContain('Before');
    expect(extracted).toContain('after');
    expect(extracted).toContain('\\frac{');
  });
});
