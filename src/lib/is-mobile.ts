/**
 * Detects whether the current device uses a coarse pointer (touch/mobile).
 * Computed once at module load; safe for SSR and test environments.
 */
export const isMobileDevice =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches;
