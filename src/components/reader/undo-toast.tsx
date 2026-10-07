'use client';

import { useEffect } from 'react';
import { Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface UndoToastProps {
  /** Whether the toast is visible */
  visible: boolean;
  /** Called when the user clicks "Undo" */
  onUndo: () => void;
  /** Called when the toast auto-dismisses or is manually closed */
  onDismiss: () => void;
}

/**
 * Fixed-position toast at bottom-center of viewport for merge undo.
 * Auto-dismisses after 5 seconds.
 */
export function UndoToast({ visible, onUndo, onDismiss }: UndoToastProps) {
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(onDismiss, 5000);
    return () => clearTimeout(timer);
  }, [visible, onDismiss]);

  if (!visible) return null;

  return (
    <div
      data-testid="merge-undo-toast"
      className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-[rgb(var(--reader-text))]/10 bg-[var(--reader-bg)] px-4 py-2.5 shadow-lg"
    >
      <span className="text-sm text-[rgb(var(--reader-text))]/70">Highlights merged</span>
      <Button
        data-testid="merge-undo-btn"
        size="sm"
        onClick={onUndo}
        className="gap-1.5 bg-[rgb(var(--reader-text))]/10 text-[rgb(var(--reader-text))] hover:bg-[rgb(var(--reader-text))]/20"
      >
        <Undo2 className="size-3.5" />
        Undo
      </Button>
    </div>
  );
}
