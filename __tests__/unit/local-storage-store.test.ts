/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalStorageStore } from '@/lib/local-storage-store';

const KEY = 'test-store-key';
const parseFlag = (raw: string | null) => raw === 'true';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('createLocalStorageStore', () => {
  it('returns the server value from getServerSnapshot regardless of storage', () => {
    localStorage.setItem(KEY, 'true');
    const store = createLocalStorageStore(KEY, parseFlag, false);

    expect(store.getServerSnapshot()).toBe(false);
  });

  it('parses the stored value, passing null when the key is absent', () => {
    const parse = vi.fn(parseFlag);
    const store = createLocalStorageStore(KEY, parse, false);

    expect(store.getSnapshot()).toBe(false);
    expect(parse).toHaveBeenLastCalledWith(null);

    localStorage.setItem(KEY, 'true');
    expect(store.getSnapshot()).toBe(true);
  });

  it('writes the stringified value and notifies subscribers until unsubscribed', () => {
    const store = createLocalStorageStore(KEY, parseFlag, false);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.set(true);
    expect(localStorage.getItem(KEY)).toBe('true');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.set(false);
    expect(localStorage.getItem(KEY)).toBe('false');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('falls back to parse(null) when reading storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const store = createLocalStorageStore(KEY, (raw) => raw ?? 'default', 'server');

    expect(store.getSnapshot()).toBe('default');
  });

  it('keeps the value in memory when writing storage throws, until a write succeeds', () => {
    const store = createLocalStorageStore(KEY, parseFlag, false);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const listener = vi.fn();
    store.subscribe(listener);

    store.set(true);
    expect(store.getSnapshot()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    setItem.mockRestore();
    store.set(false);
    expect(store.getSnapshot()).toBe(false);
    expect(localStorage.getItem(KEY)).toBe('false');
  });

  it('holds a nullable value in memory after a failed write', () => {
    const store = createLocalStorageStore<string | null>(KEY, (raw) => raw ?? 'fallback', null);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });

    store.set(null);
    expect(store.getSnapshot()).toBeNull();
  });
});
