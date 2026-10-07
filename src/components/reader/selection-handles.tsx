'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getHighlightMarks } from '@/lib/highlight-anchoring';
import {
  computeHandlePositions,
  createRangeFromMarks,
  getCaretPositionFromPoint,
  type HandlePositions,
} from '@/lib/selection-handle-utils';

/** Distance from viewport edge (px) at which auto-scroll activates */
const AUTO_SCROLL_ZONE = 40;
/** Maximum scroll speed (px per frame) at the very edge */
const MAX_SCROLL_SPEED = 8;

interface SelectionHandlesProps {
  /** The article content root element (used to constrain handle positioning) */
  contentRoot: HTMLElement | null;
  /** The highlight ID whose marks define the initial selection range */
  highlightId: number | null;
  /** Whether to set browser selection from marks (false = position-only for hover) */
  setSelection?: boolean;
  /** Called when the user starts dragging a handle (e.g. to enter edit mode) */
  onDragStart?: () => void;
  /** Called when the user finishes dragging a handle and the selection has changed */
  onSelectionChange?: () => void;
}

type DragTarget = 'start' | 'end';

/**
 * Renders draggable teardrop handles at the start and end of the current
 * browser selection. Users can drag handles to adjust highlight boundaries.
 * Works on both touch and mouse input. Auto-scrolls when dragging near viewport edges.
 */
export function SelectionHandles({
  contentRoot,
  highlightId,
  setSelection = true,
  onDragStart,
  onSelectionChange,
}: SelectionHandlesProps) {
  const [positions, setPositions] = useState<HandlePositions | null>(null);
  const draggingRef = useRef<DragTarget | null>(null);
  const startHandleRef = useRef<HTMLDivElement>(null);
  const endHandleRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const scrollRafRef = useRef<number>(0);
  const lastPointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  /** Reads the current browser selection and updates handle positions. */
  const updatePositions = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setPositions(null);
      return;
    }

    const range = sel.getRangeAt(0);
    const newPositions = computeHandlePositions(range);
    setPositions(newPositions);
  }, []);

  /** Sets browser selection from marks and computes handle positions. */
  const syncFromMarks = useCallback(() => {
    if (!contentRoot || !highlightId) {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setPositions(null);
      } else {
        setPositions(computeHandlePositions(sel.getRangeAt(0)));
      }
      return;
    }

    const allMarks = getHighlightMarks(highlightId, contentRoot);
    const range = createRangeFromMarks(allMarks);
    if (!range) {
      setPositions(null);
      return;
    }

    // In hover mode, only compute positions without modifying browser selection.
    // Skip selection manipulation when a form element (e.g. note textarea) has focus —
    // calling addRange() while a textarea is active can interfere with its focus.
    if (setSelection && document.activeElement?.tagName !== 'TEXTAREA') {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }

    setPositions(computeHandlePositions(range));
  }, [contentRoot, highlightId, setSelection]);

  // Synchronize handle positions with the DOM on mount or when highlightId/setSelection changes.
  // Uses rAF to run after the browser's native selection settles (e.g. mobile word selection).
  useEffect(() => {
    const id = requestAnimationFrame(syncFromMarks);
    return () => cancelAnimationFrame(id);
  }, [syncFromMarks]);

  // Update positions on selection/scroll/resize changes.
  // When a highlightId is set, always recompute from marks (syncFromMarks) instead of
  // the browser selection (updatePositions), because the browser's native selection may
  // be a single tapped word on mobile rather than the full highlight range.
  useEffect(() => {
    const handleEvent = () => {
      if (draggingRef.current) return; // Already updating in handlePointerMove
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(highlightId ? syncFromMarks : updatePositions);
    };

    document.addEventListener('selectionchange', handleEvent);
    window.addEventListener('scroll', handleEvent, { passive: true });
    window.addEventListener('resize', handleEvent, { passive: true });

    return () => {
      cancelAnimationFrame(rafRef.current);
      document.removeEventListener('selectionchange', handleEvent);
      window.removeEventListener('scroll', handleEvent);
      window.removeEventListener('resize', handleEvent);
    };
  }, [highlightId, syncFromMarks, updatePositions]);

  const contentRootRef = useRef(contentRoot);
  useEffect(() => {
    contentRootRef.current = contentRoot;
  }, [contentRoot]);

  /** Starts a drag operation for the given handle. */
  const startDrag = useCallback(
    (target: DragTarget, e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Signal edit mode entry (e.g. when transitioning from hover to edit)
      onDragStart?.();

      draggingRef.current = target;
      lastPointerRef.current = { x: e.clientX, y: e.clientY };

      // Capture pointer events on the handle element
      const handle = target === 'start' ? startHandleRef.current : endHandleRef.current;
      if (handle) {
        handle.setPointerCapture(e.pointerId);
      }
    },
    [onDragStart],
  );

  /**
   * Updates the browser selection to match the given caret position.
   * Used by both pointer move and auto-scroll.
   */
  const updateSelectionAtPoint = useCallback((x: number, y: number) => {
    const root = contentRootRef.current;
    if (!draggingRef.current || !root) return;

    const caretPos = getCaretPositionFromPoint(x, y);
    if (!caretPos || !root.contains(caretPos.node)) return;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const currentRange = sel.getRangeAt(0);
    const isStart = draggingRef.current === 'start';

    try {
      const newRange = document.createRange();
      newRange.setStart(
        isStart ? caretPos.node : currentRange.startContainer,
        isStart ? caretPos.offset : currentRange.startOffset,
      );
      newRange.setEnd(
        isStart ? currentRange.endContainer : caretPos.node,
        isStart ? currentRange.endOffset : caretPos.offset,
      );
      if (newRange.collapsed) return;

      sel.removeAllRanges();
      sel.addRange(newRange);

      const updatedPositions = computeHandlePositions(newRange);
      if (updatedPositions) {
        setPositions(updatedPositions);
      }
    } catch {
      // Invalid range — ignore
    }
  }, []);

  /**
   * Starts the auto-scroll RAF loop. Reads pointer position from lastPointerRef
   * to scroll the page when dragging near viewport edges.
   */
  const startAutoScroll = useCallback(() => {
    cancelAnimationFrame(scrollRafRef.current);

    const tick = () => {
      if (!draggingRef.current) return;

      const { x, y } = lastPointerRef.current;
      const vh = window.innerHeight;
      let scrollAmount = 0;

      if (y < AUTO_SCROLL_ZONE) {
        const proximity = 1 - y / AUTO_SCROLL_ZONE;
        scrollAmount = -Math.ceil(proximity * MAX_SCROLL_SPEED);
      } else if (y > vh - AUTO_SCROLL_ZONE) {
        const proximity = 1 - (vh - y) / AUTO_SCROLL_ZONE;
        scrollAmount = Math.ceil(proximity * MAX_SCROLL_SPEED);
      }

      if (scrollAmount !== 0) {
        window.scrollBy(0, scrollAmount);
        updateSelectionAtPoint(x, y);
        scrollRafRef.current = requestAnimationFrame(tick);
      }
    };

    const { y } = lastPointerRef.current;
    if (y < AUTO_SCROLL_ZONE || y > window.innerHeight - AUTO_SCROLL_ZONE) {
      scrollRafRef.current = requestAnimationFrame(tick);
    }
  }, [updateSelectionAtPoint]);

  /** Handles pointer move during drag — updates browser selection and auto-scroll. */
  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current || !contentRoot) return;

      e.preventDefault();
      e.stopPropagation();

      lastPointerRef.current = { x: e.clientX, y: e.clientY };
      updateSelectionAtPoint(e.clientX, e.clientY);
      startAutoScroll();
    },
    [contentRoot, updateSelectionAtPoint, startAutoScroll],
  );

  /** Ends the drag operation. */
  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;

      e.preventDefault();
      e.stopPropagation();
      draggingRef.current = null;
      cancelAnimationFrame(scrollRafRef.current);

      // Release pointer capture
      const handle = e.currentTarget as HTMLElement;
      if (handle.hasPointerCapture(e.pointerId)) {
        handle.releasePointerCapture(e.pointerId);
      }

      onSelectionChange?.();
    },
    [onSelectionChange],
  );

  // Clean up scroll RAF on unmount
  useEffect(() => {
    return () => cancelAnimationFrame(scrollRafRef.current);
  }, []);

  if (!positions) return null;

  return (
    <>
      {/* Start handle */}
      <div
        ref={startHandleRef}
        data-testid="selection-handle-start"
        className="selection-handle selection-handle-start"
        style={{
          position: 'fixed',
          left: `${positions.start.x}px`,
          top: `${positions.start.y - 8}px`,
          height: `${positions.start.lineHeight + 8}px`,
        }}
        onPointerDown={(e) => startDrag('start', e)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        role="separator"
        aria-label="Adjust selection start"
        aria-orientation="horizontal"
        tabIndex={-1}
      >
        <div data-testid="selection-handle-line" className="selection-handle-line" />
        <div data-testid="selection-handle-grip" className="selection-handle-grip" />
      </div>

      {/* End handle */}
      <div
        ref={endHandleRef}
        data-testid="selection-handle-end"
        className="selection-handle selection-handle-end"
        style={{
          position: 'fixed',
          left: `${positions.end.x}px`,
          top: `${positions.end.y}px`,
          height: `${positions.end.lineHeight + 8}px`,
        }}
        onPointerDown={(e) => startDrag('end', e)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        role="separator"
        aria-label="Adjust selection end"
        aria-orientation="horizontal"
        tabIndex={-1}
      >
        <div data-testid="selection-handle-line" className="selection-handle-line" />
        <div data-testid="selection-handle-grip" className="selection-handle-grip" />
      </div>
    </>
  );
}
