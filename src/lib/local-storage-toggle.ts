/**
 * Factory for a per-ID localStorage toggle store compatible with useSyncExternalStore.
 * The stored value is 'original' (true) or absent/anything-else (false).
 *
 * @param keyPrefix - Prefix prepended to the numeric ID to form the storage key,
 *   e.g. 'newsletter-view-' produces 'newsletter-view-42'.
 */
export function createPersistedToggleStore(keyPrefix: string) {
  const listeners = new Map<number, Set<() => void>>();

  function getSnapshot(id: number): boolean {
    try {
      return localStorage.getItem(`${keyPrefix}${id}`) === 'original';
    } catch {
      return false;
    }
  }

  function getServerSnapshot(): boolean {
    return false;
  }

  function subscribe(callback: () => void, id: number): () => void {
    if (!listeners.has(id)) listeners.set(id, new Set());
    listeners.get(id)!.add(callback);
    return () => listeners.get(id)?.delete(callback);
  }

  function setShowOriginal(id: number, value: boolean): void {
    try {
      if (value) {
        localStorage.setItem(`${keyPrefix}${id}`, 'original');
      } else {
        localStorage.removeItem(`${keyPrefix}${id}`);
      }
    } catch {
      // Storage unavailable — silently ignore
    }
    listeners.get(id)?.forEach((cb) => cb());
  }

  return { getSnapshot, getServerSnapshot, subscribe, setShowOriginal };
}
