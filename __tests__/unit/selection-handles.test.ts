// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { computeHandlePositions, getCaretPositionFromPoint } from '@/lib/selection-handle-utils';

describe('selection-handle-utils', () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.innerHTML = '';
    document.body.appendChild(root);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('computeHandlePositions', () => {
    it('returns null when range is null', () => {
      expect(computeHandlePositions(null)).toBeNull();
    });

    it('computes start and end positions from a range', () => {
      root.innerHTML = '<p>Hello world</p>';
      const textNode = root.querySelector('p')!.childNodes[0]!;

      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 5);

      // jsdom doesn't implement getClientRects on ranges with real geometry,
      // so we mock it to return a single line rect
      const originalGetCR = Range.prototype.getClientRects;
      Range.prototype.getClientRects = function () {
        const rect = new DOMRect(50, 100, 100, 20);
        return [rect] as unknown as DOMRectList;
      };

      const positions = computeHandlePositions(range);

      Range.prototype.getClientRects = originalGetCR;

      expect(positions).not.toBeNull();
      expect(positions!.start).toEqual({ x: 50, y: 100, lineHeight: 20 });
      expect(positions!.end).toEqual({ x: 150, y: 100, lineHeight: 20 });
    });

    it('computes correct positions for multi-line ranges', () => {
      root.innerHTML = '<p>Hello world</p>';
      const textNode = root.querySelector('p')!.childNodes[0]!;

      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 11);

      // Mock two line rects (multi-line selection)
      const originalGetCR = Range.prototype.getClientRects;
      Range.prototype.getClientRects = function () {
        const firstLine = new DOMRect(50, 100, 200, 20);
        const secondLine = new DOMRect(50, 120, 150, 20);
        return [firstLine, secondLine] as unknown as DOMRectList;
      };

      const positions = computeHandlePositions(range);

      Range.prototype.getClientRects = originalGetCR;

      expect(positions).not.toBeNull();
      // Start handle at beginning of first line
      expect(positions!.start).toEqual({ x: 50, y: 100, lineHeight: 20 });
      // End handle at end of last line
      expect(positions!.end).toEqual({ x: 200, y: 120, lineHeight: 20 });
    });

    it('returns null when getClientRects returns empty list', () => {
      root.innerHTML = '<p>Hello</p>';
      const textNode = root.querySelector('p')!.childNodes[0]!;

      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 5);

      const originalGetCR = Range.prototype.getClientRects;
      Range.prototype.getClientRects = function () {
        return [] as unknown as DOMRectList;
      };

      const positions = computeHandlePositions(range);

      Range.prototype.getClientRects = originalGetCR;

      expect(positions).toBeNull();
    });
  });

  describe('getCaretPositionFromPoint', () => {
    it('returns null when caretRangeFromPoint is not available', () => {
      // jsdom doesn't implement caretRangeFromPoint
      const result = getCaretPositionFromPoint(100, 200);
      expect(result).toBeNull();
    });

    it('uses caretRangeFromPoint when available', () => {
      root.innerHTML = '<p>Hello world</p>';
      const textNode = root.querySelector('p')!.childNodes[0]!;

      const mockRange = document.createRange();
      mockRange.setStart(textNode, 3);
      mockRange.setEnd(textNode, 3);

      // Mock caretRangeFromPoint
      (document as unknown as Record<string, unknown>).caretRangeFromPoint = vi.fn(() => mockRange);

      const result = getCaretPositionFromPoint(100, 200);

      expect(result).not.toBeNull();
      expect(result!.node).toBe(textNode);
      expect(result!.offset).toBe(3);

      delete (document as unknown as Record<string, unknown>).caretRangeFromPoint;
    });

    it('uses caretPositionFromPoint when available (Firefox)', () => {
      root.innerHTML = '<p>Hello world</p>';
      const textNode = root.querySelector('p')!.childNodes[0]!;

      // Mock caretPositionFromPoint (Firefox API)
      (document as unknown as Record<string, unknown>).caretPositionFromPoint = vi.fn(() => ({
        offsetNode: textNode,
        offset: 5,
      }));

      const result = getCaretPositionFromPoint(100, 200);

      expect(result).not.toBeNull();
      expect(result!.node).toBe(textNode);
      expect(result!.offset).toBe(5);

      delete (document as unknown as Record<string, unknown>).caretPositionFromPoint;
    });
  });
});
