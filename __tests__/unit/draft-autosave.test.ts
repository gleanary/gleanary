import { describe, it, expect } from 'vitest';
import { shouldAutoSave } from '@/lib/draft-autosave';

describe('shouldAutoSave', () => {
  it('returns false while streaming, even with a dirty value', () => {
    expect(shouldAutoSave({ isStreaming: true, current: 'abc', lastSaved: 'def' })).toBe(false);
  });

  it('returns false when current equals lastSaved', () => {
    expect(shouldAutoSave({ isStreaming: false, current: 'abc', lastSaved: 'abc' })).toBe(false);
  });

  it('returns true when current differs from lastSaved and not streaming', () => {
    expect(shouldAutoSave({ isStreaming: false, current: 'abc', lastSaved: 'def' })).toBe(true);
  });

  it('returns false for empty-to-empty (initial state)', () => {
    expect(shouldAutoSave({ isStreaming: false, current: '', lastSaved: '' })).toBe(false);
  });

  it('returns true when one value is empty and the other is not', () => {
    expect(shouldAutoSave({ isStreaming: false, current: '', lastSaved: 'abc' })).toBe(true);
    expect(shouldAutoSave({ isStreaming: false, current: 'abc', lastSaved: '' })).toBe(true);
  });

  it('streaming takes precedence over a clean value (idempotent)', () => {
    expect(shouldAutoSave({ isStreaming: true, current: 'abc', lastSaved: 'abc' })).toBe(false);
  });
});
