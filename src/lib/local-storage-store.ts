import { useSyncExternalStore } from 'react';

/** A single-key localStorage store; read it in components with `useLocalStorageStore`. */
export interface LocalStorageStore<T> {
  getSnapshot: () => T;
  getServerSnapshot: () => T;
  subscribe: (callback: () => void) => () => void;
  set: (value: T) => void;
}

/**
 * Factory for a single-key localStorage store compatible with useSyncExternalStore.
 * Reads are hydration-safe: the server snapshot is a fixed default, and the client
 * snapshot is read from localStorage after hydration. If a write fails (storage
 * unavailable), the value is kept in memory so the UI still updates.
 *
 * @param key - localStorage key
 * @param parse - Maps the raw stored string (or null when absent) to a value, returning
 *   the default for missing or invalid input. Must return a primitive (or a stable
 *   reference): useSyncExternalStore re-renders whenever the snapshot identity changes.
 * @param serverValue - Snapshot used on the server and during hydration
 * @returns The store
 */
export function createLocalStorageStore<T>(
  key: string,
  parse: (raw: string | null) => T,
  serverValue: T,
): LocalStorageStore<T> {
  const listeners = new Set<() => void>();
  // Set only after a failed write; boxed so a nullable T can still be held.
  let memory: { value: T } | null = null;

  function getSnapshot(): T {
    if (memory) return memory.value;
    try {
      return parse(localStorage.getItem(key));
    } catch {
      return parse(null);
    }
  }

  function getServerSnapshot(): T {
    return serverValue;
  }

  function subscribe(callback: () => void): () => void {
    listeners.add(callback);
    return () => listeners.delete(callback);
  }

  /** Persists the value (stringified) and notifies subscribers. */
  function set(value: T): void {
    try {
      localStorage.setItem(key, String(value));
      memory = null;
    } catch {
      // Storage unavailable — fall back to the in-memory value
      memory = { value };
    }
    listeners.forEach((cb) => cb());
  }

  return { getSnapshot, getServerSnapshot, subscribe, set };
}

/**
 * Subscribes a component to a localStorage store (hydration-safe).
 *
 * @param store - Store created by `createLocalStorageStore`
 * @returns The current value: the server snapshot during SSR and hydration, then the stored value
 */
export function useLocalStorageStore<T>(store: LocalStorageStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}
