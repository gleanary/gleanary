'use client';

import { useEffect, useRef } from 'react';

/**
 * Silently refetches data on mount to work around stale Next.js Router Cache
 * after client-side navigation. The initial SSR data renders immediately;
 * this fires a background refresh so the list updates if anything changed.
 *
 * The callback passed on initial render is captured and invoked once on mount.
 * Callers do not need to stabilize the callback with `useCallback`.
 *
 * @param refetch - Async function that fetches fresh data
 */
export function useRefreshOnMount(refetch: () => Promise<unknown>): void {
  const refetchRef = useRef(refetch);

  useEffect(() => {
    refetchRef.current();
  }, []);
}
