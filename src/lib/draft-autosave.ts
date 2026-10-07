/**
 * Pure helper for the draft editor's debounced auto-save effects.
 * Returns `true` only when there is a meaningful pending change to persist:
 * not streaming, and current value differs from the last saved value.
 */
export function shouldAutoSave<T>({
  isStreaming,
  current,
  lastSaved,
}: {
  isStreaming: boolean;
  current: T;
  lastSaved: T;
}): boolean {
  if (isStreaming) return false;
  return current !== lastSaved;
}
