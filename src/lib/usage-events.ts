/**
 * Emit a DOM CustomEvent when ai_usage data changes.
 * UsageFooter subscribes via addEventListener in a useEffect.
 * Using a native DOM event avoids adding Zustand/Jotai for a single cross-tree signal.
 */
export function emitUsageChanged(): void {
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent('usage:changed'));
  }
}
