import { describe, it, expect } from 'vitest';
import { runWithConcurrency } from '@/lib/concurrency';

describe('runWithConcurrency', () => {
  it('returns an empty array for no thunks', async () => {
    const results = await runWithConcurrency<number>([], 4);
    expect(results).toEqual([]);
  });

  it('runs all thunks when limit exceeds length', async () => {
    const fns = [1, 2, 3].map((n) => () => Promise.resolve(n * 10));
    const results = await runWithConcurrency(fns, 99);
    expect(results).toEqual([10, 20, 30]);
  });

  it('preserves result ordering regardless of completion order', async () => {
    // Later thunks resolve sooner, so ordering must come from index, not timing.
    const fns = [0, 1, 2, 3].map((n) => () => {
      const delay = (4 - n) * 10;
      return new Promise<number>((resolve) => setTimeout(() => resolve(n), delay));
    });
    const results = await runWithConcurrency(fns, 2);
    expect(results).toEqual([0, 1, 2, 3]);
  });

  it('never exceeds the concurrency limit of in-flight thunks', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fns = Array.from({ length: 10 }, () => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return inFlight;
    });
    await runWithConcurrency(fns, 3);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBe(3);
  });
});
