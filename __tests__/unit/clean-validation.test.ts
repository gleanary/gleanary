import { describe, it, expect } from 'vitest';
import { validateCleanOutput } from '@/lib/content-quality';

describe('validateCleanOutput', () => {
  const input100 = 'a'.repeat(100);

  it('returns true when sanitized is within ±40% of input and ratio ≥ 50%', () => {
    const raw = 'a'.repeat(90);
    const sanitized = 'a'.repeat(90);
    expect(validateCleanOutput(raw, sanitized, input100)).toBe(true);
  });

  it('returns false when sanitized is too short (< 60% of input)', () => {
    const raw = 'a'.repeat(50);
    const sanitized = 'a'.repeat(50); // 50% of 100 < 60%
    expect(validateCleanOutput(raw, sanitized, input100)).toBe(false);
  });

  it('returns false when sanitized is too long (> 140% of input)', () => {
    const raw = 'a'.repeat(200);
    const sanitized = 'a'.repeat(200); // 200% of 100 > 140%
    expect(validateCleanOutput(raw, sanitized, input100)).toBe(false);
  });

  it('returns false when sanitized is less than 50% of raw output (heavy stripping)', () => {
    const raw = 'a'.repeat(200);
    const sanitized = 'a'.repeat(80); // 80 < 200 * 0.5, but also within ±40% of input
    // sanitized (80) vs input (100): 80% → within bounds
    // sanitized (80) vs raw (200): 40% < 50% → fail
    expect(validateCleanOutput(raw, sanitized, input100)).toBe(false);
  });

  it('returns true when both bounds are just barely passing', () => {
    // Sanitized exactly at lower bound: 60% of input
    const raw = 'a'.repeat(60);
    const sanitized = 'a'.repeat(60); // exactly 60% of input; sanitized/raw = 100% ≥ 50%
    expect(validateCleanOutput(raw, sanitized, input100)).toBe(true);
  });

  it('returns true when sanitized is exactly at upper bound (140% of input)', () => {
    const raw = 'a'.repeat(140);
    const sanitized = 'a'.repeat(140); // exactly 140% of input; ratio = 100% ≥ 50%
    expect(validateCleanOutput(raw, sanitized, input100)).toBe(true);
  });

  it('returns false for empty sanitized string', () => {
    const raw = 'a'.repeat(90);
    expect(validateCleanOutput(raw, '', input100)).toBe(false);
  });

  it('returns false when sanitized is exactly at 59% of input (just below lower bound)', () => {
    const raw = 'a'.repeat(59);
    const sanitized = 'a'.repeat(59);
    expect(validateCleanOutput(raw, sanitized, input100)).toBe(false);
  });

  it('returns false when sanitized is exactly at 141% of input (just above upper bound)', () => {
    const raw = 'a'.repeat(141);
    const sanitized = 'a'.repeat(141);
    expect(validateCleanOutput(raw, sanitized, input100)).toBe(false);
  });

  it('returns false when sanitized is exactly 49% of raw output', () => {
    // Sanitized = 98, raw = 200; ratio = 49% < 50%; input=100, sanitized/input = 98% → within bounds
    const raw = 'a'.repeat(200);
    const sanitized = 'a'.repeat(98);
    expect(validateCleanOutput(raw, sanitized, input100)).toBe(false);
  });

  describe('custom minRatio (chunk path)', () => {
    it('passes at 40% of input when minRatio=0.4', () => {
      const raw = 'a'.repeat(40);
      const sanitized = 'a'.repeat(40); // 40% of 100 ≥ 40%
      expect(validateCleanOutput(raw, sanitized, input100, 0.4)).toBe(true);
    });

    it('fails below minRatio=0.4', () => {
      const raw = 'a'.repeat(39);
      const sanitized = 'a'.repeat(39); // 39% of 100 < 40%
      expect(validateCleanOutput(raw, sanitized, input100, 0.4)).toBe(false);
    });

    it('default 0.6 still rejects 50% output', () => {
      const raw = 'a'.repeat(50);
      const sanitized = 'a'.repeat(50);
      expect(validateCleanOutput(raw, sanitized, input100)).toBe(false);
    });
  });
});
