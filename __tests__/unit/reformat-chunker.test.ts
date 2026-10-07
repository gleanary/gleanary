import { describe, it, expect } from 'vitest';
import { chunkHtml, CHUNK_TARGET_SIZE, CHUNK_HARD_CEILING } from '@/lib/reformat-chunker';

// Generate a <p> block of approximately `chars` characters of text
function para(chars: number, id = 'x'): string {
  const text = `${id}-`.repeat(Math.ceil(chars / 2)).slice(0, chars);
  return `<p>${text}</p>`;
}

describe('chunkHtml', () => {
  describe('empty / whitespace-only input', () => {
    it('returns [] for empty string', () => {
      expect(chunkHtml('')).toEqual([]);
    });

    it('returns [] for whitespace-only string', () => {
      expect(chunkHtml('   \n\t  ')).toEqual([]);
    });

    it('returns [] for body with no elements', () => {
      expect(chunkHtml('  just text with no tags  ')).toEqual([]);
    });
  });

  describe('block-boundary chunking', () => {
    it('returns a single chunk when content fits within target', () => {
      const html = para(1_000, 'a') + para(1_000, 'b') + para(1_000, 'c');
      const chunks = chunkHtml(html, CHUNK_TARGET_SIZE);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.index).toBe(0);
      expect(chunks[0]!.isOversized).toBe(false);
    });

    it('splits into multiple chunks when content exceeds target', () => {
      // Three blocks each just over 10k — target 10k forces a split
      const target = 10_000;
      const block = para(11_000, 'a');
      // Each block individually exceeds target so they each become their own chunk
      const html = block + block + block;
      const chunks = chunkHtml(html, target);
      expect(chunks.length).toBeGreaterThanOrEqual(3);
    });

    it('never splits a block element across chunks', () => {
      const target = 5_000;
      const html =
        para(4_000, 'a') + // fits in chunk 1
        para(4_000, 'b') + // adding b would exceed 5k → new chunk
        para(4_000, 'c'); // new chunk
      const chunks = chunkHtml(html, target);
      // Each chunk's html should be parseable (no partial tags)
      for (const chunk of chunks) {
        expect(chunk.html).toMatch(/^<p>/);
        expect(chunk.html).toMatch(/<\/p>$/);
      }
    });

    it('assigns sequential 0-based indices', () => {
      const target = 8_000;
      const html = para(9_000, 'a') + para(9_000, 'b') + para(9_000, 'c');
      const chunks = chunkHtml(html, target);
      chunks.forEach((chunk, i) => {
        expect(chunk.index).toBe(i);
      });
    });

    it('charCount matches actual html length', () => {
      const html = para(3_000, 'a') + para(3_000, 'b');
      const chunks = chunkHtml(html);
      for (const chunk of chunks) {
        expect(chunk.charCount).toBe(chunk.html.length);
      }
    });

    it('packs elements greedily — two small blocks fit in one chunk', () => {
      const target = 10_000;
      const html = para(3_000, 'a') + para(3_000, 'b') + para(3_000, 'c');
      // 3k + 3k < 10k so all three fit in one chunk
      const chunks = chunkHtml(html, target);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.html).toContain('a-');
      expect(chunks[0]!.html).toContain('b-');
      expect(chunks[0]!.html).toContain('c-');
    });
  });

  describe('single-giant-div wrapper (one-level recursion)', () => {
    it('recurses into children of a wrapper div larger than target', () => {
      const target = 10_000;
      // Wrapper div containing three 12k-char blocks — each larger than target
      const inner = para(12_000, 'a') + para(12_000, 'b') + para(12_000, 'c');
      const html = `<div>${inner}</div>`;
      const chunks = chunkHtml(html, target);
      // Recursion expands the wrapper into 3 separate chunks
      expect(chunks.length).toBeGreaterThanOrEqual(3);
      // Each sub-chunk is still wrapped in the parent <div>
      for (const chunk of chunks) {
        expect(chunk.html).toMatch(/^<div>/);
        expect(chunk.html).toMatch(/<\/div>$/);
      }
    });

    it('does not recurse more than one level', () => {
      const target = 5_000;
      // Deeply nested: outer > inner > content where content is still oversized
      const content = para(8_000, 'x');
      const html = `<div><div>${content}</div></div>`;
      // Only one level of recursion — inner <div> is still oversized → accepted as-is
      const chunks = chunkHtml(html, target);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      for (const chunk of chunks) {
        expect(chunk.html.length).toBeGreaterThan(0);
      }
    });
  });

  describe('oversized-after-recursion hard ceiling', () => {
    it('truncates a chunk exceeding CHUNK_HARD_CEILING', () => {
      // Single block larger than the hard ceiling
      const giantText = 'x'.repeat(CHUNK_HARD_CEILING + 10_000);
      const html = `<p>${giantText}</p>`;
      const chunks = chunkHtml(html);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.charCount).toBeLessThanOrEqual(CHUNK_HARD_CEILING);
      expect(chunks[0]!.isOversized).toBe(true);
    });

    it('does not truncate chunks within the hard ceiling', () => {
      const html = para(CHUNK_HARD_CEILING - 100, 'a');
      const chunks = chunkHtml(html);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.charCount).toBeLessThanOrEqual(CHUNK_HARD_CEILING);
    });
  });

  describe('round-trip content fidelity', () => {
    it('concatenating all chunks preserves all text content', () => {
      const texts = ['Alpha fox trot', 'Bravo hotel india', 'Charlie juliet kilo'];
      const html = texts.map((t) => `<p>${t}</p>`).join('');
      const chunks = chunkHtml(html, 20); // tiny target forces splits
      const combined = chunks.map((c) => c.html).join('');
      for (const text of texts) {
        expect(combined).toContain(text);
      }
    });

    it('concatenating all chunks preserves href links', () => {
      const html =
        '<p>See <a href="https://example.com/one">link one</a> here.</p>' +
        '<p>See <a href="https://example.com/two">link two</a> here.</p>';
      const chunks = chunkHtml(html, 50); // force split
      const combined = chunks.map((c) => c.html).join('');
      expect(combined).toContain('https://example.com/one');
      expect(combined).toContain('https://example.com/two');
    });

    it('concatenating all chunks preserves img src attributes', () => {
      const html =
        '<p><img src="https://example.com/img1.jpg" alt="one"></p>' +
        '<p><img src="https://example.com/img2.jpg" alt="two"></p>';
      const chunks = chunkHtml(html, 50);
      const combined = chunks.map((c) => c.html).join('');
      expect(combined).toContain('https://example.com/img1.jpg');
      expect(combined).toContain('https://example.com/img2.jpg');
    });
  });

  describe('isOversized flag', () => {
    it('is false for normal-sized chunks', () => {
      const html = para(1_000, 'a') + para(1_000, 'b');
      const chunks = chunkHtml(html);
      expect(chunks.every((c) => !c.isOversized)).toBe(true);
    });

    it('is true for a block exceeding target even after recursion', () => {
      const target = 500;
      // A single <p> with no children — recursion cannot help
      const html = para(600, 'a');
      const chunks = chunkHtml(html, target);
      expect(chunks[0]!.isOversized).toBe(true);
    });
  });
});
