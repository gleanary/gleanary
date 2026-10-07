import { describe, it, expect } from 'vitest';
import { computeScrollProgress, progressToScrollY } from '@/lib/scroll-progress';

describe('computeScrollProgress', () => {
  it('returns null when the document is not scrollable (height 0)', () => {
    expect(computeScrollProgress(500, 0)).toBeNull();
  });

  it('returns null when the viewport is taller than the document (negative height)', () => {
    expect(computeScrollProgress(0, -200)).toBeNull();
  });

  it('maps scroll offset to a 0–1 ratio', () => {
    expect(computeScrollProgress(300, 1000)).toBe(0.3);
    expect(computeScrollProgress(1000, 1000)).toBe(1);
  });

  it('clamps to 1 when scrolled past the end', () => {
    expect(computeScrollProgress(1500, 1000)).toBe(1);
  });

  it('clamps to 0 for a negative scroll offset (overscroll bounce)', () => {
    expect(computeScrollProgress(-50, 1000)).toBe(0);
  });

  it('does not round — rounding is a caller concern', () => {
    expect(computeScrollProgress(1, 3)).toBe(1 / 3);
  });
});

describe('progressToScrollY', () => {
  it('returns null when the document is not scrollable', () => {
    expect(progressToScrollY(0.5, 0)).toBeNull();
    expect(progressToScrollY(0.5, -200)).toBeNull();
  });

  it('maps progress back to a scroll offset', () => {
    expect(progressToScrollY(0.3, 1000)).toBe(300);
    expect(progressToScrollY(1, 1000)).toBe(1000);
  });

  it('inverts computeScrollProgress for in-range offsets', () => {
    const progress = computeScrollProgress(420, 1000);
    expect(progress).not.toBeNull();
    expect(progressToScrollY(progress as number, 1000)).toBe(420);
  });
});
