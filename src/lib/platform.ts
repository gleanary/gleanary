/**
 * Whether the browser runs on macOS (or another Apple platform reporting "Mac"), used to
 * show ⌘ rather than Ctrl in shortcut hints. Safe to call during SSR (returns false).
 * @returns True on Mac platforms
 */
export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.platform?.includes('Mac');
}
