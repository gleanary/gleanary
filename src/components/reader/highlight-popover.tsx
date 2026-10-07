'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Check, Trash2, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { isMobileDevice } from '@/lib/is-mobile';
import { clampToViewport } from '@/lib/clamp-to-viewport';

/** Gap between the popover bottom edge and the highlight top (px) */
const GAP = 6;

interface HighlightPopoverProps {
  /** The highlight ID */
  highlightId: number;
  /** Current note text */
  note: string | null;
  /** The highlight mark element to position relative to */
  markElement: HTMLElement | null;
  /** Called when the user updates the note */
  onUpdateNote: (id: number, note: string) => void;
  /** Called when the user deletes the highlight */
  onDelete: () => void;
  /** Called when the user confirms (exits edit mode with save) */
  onConfirm: () => void;
}

/**
 * Popover shown during edit mode alongside selection handles.
 * Centered above the highlight mark element. Uses bottom-anchoring
 * so the popover expands upward when the note textarea is visible.
 * Updates position on scroll/resize via RAF.
 */
export function HighlightPopover({
  highlightId,
  note,
  markElement,
  onUpdateNote,
  onDelete,
  onConfirm,
}: HighlightPopoverProps) {
  const [prevHighlightId, setPrevHighlightId] = useState(highlightId);
  const [showNote, setShowNote] = useState(!!note);
  const [noteText, setNoteText] = useState(note ?? '');
  const popoverRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rafRef = useRef<number>(0);
  const [position, setPosition] = useState<{ y: number; left: number }>({
    y: 0,
    left: 0,
  });

  // Derived-state reset: when highlightId changes, sync local state during render
  if (prevHighlightId !== highlightId) {
    setPrevHighlightId(highlightId);
    setShowNote(!!note);
    setNoteText(note ?? '');
  }

  // Always-fresh snapshot used by the unmount cleanup below
  const unmountSaveRef = useRef({ showNote, noteText, note, highlightId, onUpdateNote });
  useEffect(() => {
    unmountSaveRef.current = { showNote, noteText, note, highlightId, onUpdateNote };
  });

  // Save the note when the popover is dismissed via click-outside or Escape
  // (those paths call exitEditMode without going through handleConfirm).
  useEffect(() => {
    return () => {
      const {
        showNote: sn,
        noteText: nt,
        note: n,
        highlightId: id,
        onUpdateNote: save,
      } = unmountSaveRef.current;
      if (sn && nt !== (n ?? '')) {
        save(id, nt);
      }
    };
  }, []);

  const updatePosition = useCallback(() => {
    if (!markElement) return;

    const rect = markElement.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    if (isMobileDevice) {
      // Mobile: right edge, vertically centered on highlight
      const popoverHeight = popoverRef.current?.offsetHeight ?? 100;
      const centerY = rect.top + rect.height / 2;
      const top = clampToViewport(centerY - popoverHeight / 2, popoverHeight, vh);
      const popoverWidth = popoverRef.current?.offsetWidth ?? 40;

      setPosition((prev) => {
        const left = vw - popoverWidth - 8;
        if (prev.y === top && prev.left === left) return prev;
        return { y: top, left };
      });
    } else {
      // Desktop: bottom-anchored, centered above highlight
      const bottom = vh - rect.top + GAP;

      const popoverWidth = popoverRef.current?.offsetWidth ?? 120;
      const centerX = rect.left + rect.width / 2;
      const left = clampToViewport(centerX - popoverWidth / 2, popoverWidth, vw);

      setPosition((prev) => {
        if (prev.y === bottom && prev.left === left) return prev;
        return { y: bottom, left };
      });
    }
  }, [markElement]);

  // Calculate position on mount, resize, and scroll
  useEffect(() => {
    rafRef.current = requestAnimationFrame(updatePosition);

    const handleScrollOrResize = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(updatePosition);
    };

    window.addEventListener('resize', handleScrollOrResize, { passive: true });
    window.addEventListener('scroll', handleScrollOrResize, { passive: true });
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', handleScrollOrResize);
      window.removeEventListener('scroll', handleScrollOrResize);
    };
  }, [updatePosition]);

  // Focus textarea when showing note
  useEffect(() => {
    if (showNote) {
      textareaRef.current?.focus();
    }
  }, [showNote]);

  /** Saves the note if it has changed. */
  const saveNoteIfChanged = useCallback(() => {
    if (showNote && noteText !== (note ?? '')) {
      onUpdateNote(highlightId, noteText);
    }
  }, [showNote, noteText, note, highlightId, onUpdateNote]);

  const handleNoteToggle = useCallback(() => {
    saveNoteIfChanged();
    setShowNote(!showNote);
  }, [showNote, saveNoteIfChanged]);

  const handleNoteKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onUpdateNote(highlightId, noteText);
      }
      // Escape handling is done by the parent (highlight-layer) to also exit edit mode
    },
    [highlightId, noteText, onUpdateNote],
  );

  const handleConfirm = useCallback(() => {
    saveNoteIfChanged();
    onConfirm();
  }, [saveNoteIfChanged, onConfirm]);

  if (!markElement) return null;

  const noteTextarea = showNote && (
    <div className={isMobileDevice ? 'mt-1' : 'mb-1'}>
      <textarea
        ref={textareaRef}
        data-testid="highlight-note-input"
        value={noteText}
        onChange={(e) => setNoteText(e.target.value)}
        onKeyDown={handleNoteKeyDown}
        placeholder="Add a note..."
        rows={3}
        className="w-full min-w-[200px] resize-none rounded-md border border-[rgb(var(--reader-text))]/10 bg-transparent px-2 py-1.5 text-sm text-[rgb(var(--reader-text))] placeholder:text-[rgb(var(--reader-text))]/30 focus:border-[rgb(var(--reader-text))]/30 focus:outline-none"
      />
      {!isMobileDevice && (
        <p className="mt-0.5 text-xs text-[rgb(var(--reader-text))]/30">
          {navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}+Enter to save
        </p>
      )}
    </div>
  );

  return (
    <div
      ref={popoverRef}
      data-testid="highlight-popover"
      className="fixed z-[70] rounded-lg border border-[rgb(var(--reader-text))]/10 bg-[var(--reader-bg)] p-1 shadow-lg"
      style={
        isMobileDevice
          ? { top: `${position.y}px`, left: `${position.left}px` }
          : { bottom: `${position.y}px`, left: `${position.left}px` }
      }
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Note textarea — above buttons on desktop, below on mobile */}
      {!isMobileDevice && noteTextarea}

      <div
        className={`flex items-center justify-center gap-0.5 ${isMobileDevice ? 'flex-col' : ''}`}
      >
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleConfirm}
          data-testid="highlight-confirm"
          title="Confirm"
        >
          <Check className="h-3.5 w-3.5" />
        </Button>

        {!isMobileDevice && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleNoteToggle}
            title={showNote ? 'Hide note' : 'Add note'}
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </Button>
        )}

        <Button
          variant="ghost"
          size="icon"
          className="text-destructive hover:text-destructive/80 h-7 w-7"
          onClick={onDelete}
          data-testid="highlight-delete"
          title="Delete highlight"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {isMobileDevice && noteTextarea}
    </div>
  );
}
