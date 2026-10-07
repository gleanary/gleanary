import { describe, it, expect } from 'vitest';
import { calculateNextReview } from '@/lib/spaced-repetition';

describe('calculateNextReview', () => {
  it('starts with interval of 1 day for new highlights on got_it', () => {
    const result = calculateNextReview({ reviewCount: 0, currentInterval: 0 }, 'got_it');
    expect(result.interval).toBe(1);
    expect(result.reviewCount).toBe(1);
  });

  it('doubles the interval on subsequent got_it reviews', () => {
    const result = calculateNextReview({ reviewCount: 1, currentInterval: 1 }, 'got_it');
    expect(result.interval).toBe(2);
    expect(result.reviewCount).toBe(2);
  });

  it('keeps doubling for later reviews', () => {
    const result = calculateNextReview({ reviewCount: 3, currentInterval: 8 }, 'got_it');
    expect(result.interval).toBe(16);
    expect(result.reviewCount).toBe(4);
  });

  it('resets interval to 1 on review_again', () => {
    const result = calculateNextReview({ reviewCount: 5, currentInterval: 32 }, 'review_again');
    expect(result.interval).toBe(1);
    expect(result.reviewCount).toBe(6);
  });

  it('resets interval to 1 on review_again for first review', () => {
    const result = calculateNextReview({ reviewCount: 0, currentInterval: 0 }, 'review_again');
    expect(result.interval).toBe(1);
    expect(result.reviewCount).toBe(1);
  });

  it('increments reviewCount on every action', () => {
    const gotIt = calculateNextReview({ reviewCount: 10, currentInterval: 64 }, 'got_it');
    expect(gotIt.reviewCount).toBe(11);

    const again = calculateNextReview({ reviewCount: 10, currentInterval: 64 }, 'review_again');
    expect(again.reviewCount).toBe(11);
  });

  it('sets lastReviewed to an ISO datetime string', () => {
    const result = calculateNextReview({ reviewCount: 0, currentInterval: 0 }, 'got_it');
    expect(result.lastReviewed).toBeDefined();
    // Should be a valid ISO-ish datetime
    expect(new Date(result.lastReviewed).getTime()).not.toBeNaN();
  });
});
