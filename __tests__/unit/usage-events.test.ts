/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest';
import { emitUsageChanged } from '@/lib/usage-events';

describe('emitUsageChanged', () => {
  it('dispatches a usage:changed CustomEvent on document', () => {
    const listener = vi.fn();
    document.addEventListener('usage:changed', listener);

    emitUsageChanged();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.any(CustomEvent));
    document.removeEventListener('usage:changed', listener);
  });
});
