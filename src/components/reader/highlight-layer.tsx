'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SelectionHandles } from './selection-handles';
import { HighlightPopover } from './highlight-popover';
import { UndoToast } from './undo-toast';
import {
  deserializeRange,
  extractRangeText,
  getHighlightMarks,
  stripHighlightMarks,
  describeRange,
  anchorToRange,
  isV2Anchor,
  rangeToCharOffsets,
  charOffsetsToRange,
  type PositionData,
} from '@/lib/highlight-anchoring';
import { createHighlight, deleteHighlight, updateHighlight } from '@/lib/article-api';
import { isMobileDevice } from '@/lib/is-mobile';
import { createRangeFromMarks, getElementsBoundingBox } from '@/lib/selection-handle-utils';
import type { Highlight, TextQuoteAnchor } from '@/types';

const HIGHLIGHT_MARK_SELECTOR = 'mark[data-highlight-id]';
const POPOVER_SELECTOR = '[data-testid="highlight-popover"]';
const HANDLE_SELECTOR = '[data-testid^="selection-handle"]';
export const BLOCK_SELECTOR = 'p, blockquote, li, h1, h2, h3, h4, h5, h6, pre, td, th, figcaption';

/**
 * Finds the closest block-level ancestor suitable for paragraph highlighting.
 * @param target - The element that was clicked
 * @param root - The article content root element
 * @returns The closest block ancestor, or null if not found within root
 */
export function findBlockAncestor(target: HTMLElement, root: HTMLElement): HTMLElement | null {
  const block = target.closest(BLOCK_SELECTOR) as HTMLElement | null;
  if (!block || !root.contains(block)) return null;
  if (block === root) return null;
  return block;
}

/**
 * Validates the current browser selection for highlighting.
 * Returns the Range if the selection is non-empty, within root, and not inside an existing highlight.
 * @param root - The article content root element
 * @returns The valid Range, or null if the selection is unusable
 */
function getValidSelectionRange(root: HTMLElement): Range | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const ancestor = range.commonAncestorContainer;
  const parentEl =
    ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentElement : (ancestor as Element);
  if (parentEl?.closest(HIGHLIGHT_MARK_SELECTOR)) return null;

  if (!range.toString().trim()) return null;

  return range;
}

interface MergeUndoData {
  /** The highlights that were deleted during merge */
  deletedHighlights: Highlight[];
  /** The surviving highlight's state before merge */
  originalSurvivor: Highlight;
}

interface HighlightLayerProps {
  articleId: number;
  initialHighlights: Highlight[];
  children: React.ReactNode;
  /** Bumped by the parent after async DOM transforms (e.g. KaTeX) to trigger re-application */
  contentVersion?: number;
  /** When set, scrolls to and pulses the matching highlight mark exactly once after anchoring */
  highlightIdToScroll?: number;
}

/**
 * Manages inline highlighting for the reader view.
 * Renders existing highlights, handles text selection → highlight creation,
 * and provides edit mode with handles and popover for adjusting/editing highlights.
 */
export function HighlightLayer({
  articleId,
  initialHighlights,
  children,
  contentVersion,
  highlightIdToScroll,
}: HighlightLayerProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [highlights, setHighlights] = useState<Highlight[]>(initialHighlights);
  // Consumed once — prevents re-scroll when the highlights array mutates mid-session
  const hasScrolledToDeepLinkRef = useRef(false);
  const [editingHighlight, setEditingHighlight] = useState<Highlight | null>(null);
  const [editingMarkEl, setEditingMarkEl] = useState<HTMLElement | null>(null);
  const [mergeUndo, setMergeUndo] = useState<MergeUndoData | null>(null);
  const [hoveredHighlightId, setHoveredHighlightId] = useState<number | null>(null);
  const [hasPendingSelection, setHasPendingSelection] = useState(false);
  const pendingAnchorRef = useRef<HTMLSpanElement | null>(null);
  const highlightsRef = useRef<Highlight[]>(initialHighlights);
  const editingRef = useRef<Highlight | null>(null);
  const lastTouchEndRef = useRef(0);
  const mouseupHandledRef = useRef(false);
  const mouseDownRef = useRef(false);
  const skipEditModeRef = useRef(false);
  const suppressAutoCreateRef = useRef(false);
  const pendingRangeRef = useRef<Range | null>(null);
  // Caches the last full DOM-application result so a contentVersion bump that didn't actually
  // change the rendered text (e.g. an article with no math, or a second KaTeX pass that no-ops)
  // can reuse it instead of redundantly stripping and rebuilding every <mark> — which would
  // invalidate any live Selection/Range anchored inside them. See the mount effect below.
  const lastAppliedRef = useRef<{
    highlights: Highlight[];
    text: string;
    orphaned: number[];
    drifted: Array<{ id: number; anchor: TextQuoteAnchor }>;
  } | null>(null);

  /** Clears pending selection state: range ref, anchor span, and UI flag. */
  const clearPendingSelection = useCallback(() => {
    pendingRangeRef.current = null;
    setHasPendingSelection(false);
    pendingAnchorRef.current?.remove();
    pendingAnchorRef.current = null;
  }, []);

  // Clean up pending anchor span on unmount to prevent DOM leak
  useEffect(() => {
    return () => {
      pendingAnchorRef.current?.remove();
    };
  }, []);

  // Keep refs in sync with state for use in event handlers
  useEffect(() => {
    highlightsRef.current = highlights;
  }, [highlights]);
  useEffect(() => {
    editingRef.current = editingHighlight;
    if (editingHighlight) {
      // Clear hover when entering edit mode to avoid duplicate handles
      setHoveredHighlightId(null);
      // Clear pending mobile selection to prevent dual popover flicker
      clearPendingSelection();
    }
  }, [editingHighlight, clearPendingSelection]);

  // Apply existing highlights to the DOM on mount and when highlights or content change.
  // contentVersion is bumped after async DOM transforms (KaTeX) so paths resolve correctly.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;

    // Marks never change the underlying characters (they only wrap existing text nodes), so
    // root.textContent is a stable signature for "did the rendered content actually change
    // since the last full application" — regardless of whether marks are currently present.
    // A contentVersion bump with an unchanged signature (e.g. a math-free article, whose
    // render pass is a no-op) reuses the prior result instead of tearing down every <mark>.
    const currentText = root.textContent ?? '';
    const cached = lastAppliedRef.current;
    const canReuse =
      cached !== null && cached.highlights === highlights && cached.text === currentText;

    const { orphaned, drifted } = canReuse ? cached : applyHighlightsToDOM(root, highlights);

    if (!canReuse) {
      lastAppliedRef.current = { highlights, text: root.textContent ?? '', orphaned, drifted };
    }

    // contentVersion === 0 means this is the very first application pass, before
    // ArticleContent's async KaTeX render has settled — content still containing unrendered
    // `$...$` delimiters won't match a v2 anchor captured against the rendered DOM, and would
    // otherwise get fuzzy-matched against garbage and permanently orphaned. ArticleContent
    // always bumps contentVersion once its render pass finishes (with or without math), so
    // deferring persistence at 0 only delays it by one guaranteed re-run — it never skips it
    // outright — and callers that don't wire up contentVersion (prop stays undefined) keep the
    // original unguarded behavior.
    const contentSettled = contentVersion !== 0;

    // Fire anchor-repair PATCHes only when the user is idle — prevents clobbering optimistic
    // state from in-flight creates or boundary edits. editingRef.current (kept in sync with
    // editingHighlight state) and hasPendingSelection are read as guards at effect run-time
    // rather than deps: their purpose is gating side effects, not triggering the anchor-
    // resolution pass. Adding them to deps would re-run PATCHes on every edit-mode entry/exit.
    if (editingRef.current === null && !hasPendingSelection && contentSettled) {
      for (const id of orphaned) {
        void updateHighlight(id, { anchorStatus: 'orphaned' }).catch(() => {});
        setHighlights((prev) =>
          prev.map((h) => (h.id === id ? { ...h, anchorStatus: 'orphaned' } : h)),
        );
      }
      for (const { id, anchor } of drifted) {
        const positionData = JSON.stringify(anchor);
        void updateHighlight(id, { positionData }).catch(() => {});
        setHighlights((prev) => prev.map((h) => (h.id === id ? { ...h, positionData } : h)));
      }
    }

    // Deep-link scroll: runs once after the target mark is anchored to the DOM.
    // hasScrolledToDeepLinkRef prevents re-scroll when highlights mutate mid-session.
    if (highlightIdToScroll && !hasScrolledToDeepLinkRef.current) {
      // Selector verified: wrapRangeWithMark sets data-highlight-id
      const mark = root.querySelector(
        `mark[data-highlight-id="${highlightIdToScroll}"]`,
      ) as HTMLElement | null;
      if (mark) {
        hasScrolledToDeepLinkRef.current = true;
        mark.scrollIntoView({ block: 'center' });
        mark.classList.add('highlight-pulse');
        setTimeout(() => mark.classList.remove('highlight-pulse'), 1200);
      }
      // No mark found → silent fallback: article stays at top, no error
    }
    // editingRef.current and hasPendingSelection are intentionally omitted — they are guards,
    // not triggers. See comment above the if block.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- editingRef.current and hasPendingSelection are guards, not triggers
  }, [highlights, contentVersion, highlightIdToScroll]);

  /** Exits edit mode: clears selection, editing state, and mark reference. */
  const exitEditMode = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    editingRef.current = null;
    setEditingHighlight(null);
    setEditingMarkEl(null);
  }, []);

  // After highlights are applied to DOM, find the mark element for the editing highlight
  // and restore the browser selection from the new marks (applyHighlightsToDOM destroys
  // the old marks, invalidating any existing selection).
  useEffect(() => {
    if (!editingHighlight || !contentRef.current) {
      setEditingMarkEl(null);
      return;
    }
    const root = contentRef.current;
    const allMarks = getHighlightMarks(editingHighlight.id, root);
    if (allMarks.length === 0) {
      setEditingMarkEl(null);
      return;
    }
    setEditingMarkEl(allMarks[0] as HTMLElement);

    // Restore browser selection from new marks so custom handles stay visible
    const range = createRangeFromMarks(allMarks);
    if (range) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [editingHighlight, highlights]);

  /**
   * Detects overlap between the edited highlight's current range and other highlights.
   * Returns the first overlapping highlight, or null if none overlap.
   */
  const findOverlappingHighlights = useCallback((editedId: number, range: Range): Highlight[] => {
    if (!contentRef.current) return [];
    const root = contentRef.current;
    const edited = rangeToCharOffsets(range, root);
    const result: Highlight[] = [];

    for (const h of highlightsRef.current) {
      if (h.id === editedId) continue;

      // Use rendered mark elements instead of deserializing positionData,
      // because positionData paths are relative to the clean DOM (no marks)
      // and won't resolve correctly on the live DOM with marks present.
      const marks = getHighlightMarks(h.id, root);
      if (marks.length === 0) continue;

      const markRange = document.createRange();
      markRange.setStartBefore(marks[0]!);
      markRange.setEndAfter(marks[marks.length - 1]!);
      const other = rangeToCharOffsets(markRange, root);

      // Strict inequality: touching but not overlapping does NOT merge
      if (edited.start < other.end && other.start < edited.end) {
        result.push(h);
      }
    }
    return result;
  }, []);

  /**
   * Merges overlapping highlights into one.
   * The surviving highlight spans the union of all ranges.
   * The absorbed highlights are deleted. Shows undo toast.
   */
  const mergeHighlights = useCallback(
    async (survivor: Highlight, absorbed: Highlight[], currentRange: Range) => {
      if (!contentRef.current) return;

      try {
        const root = contentRef.current;
        const survivorOffsets = rangeToCharOffsets(currentRange, root);

        let unionStart = survivorOffsets.start;
        let unionEnd = survivorOffsets.end;

        // Expand union to cover all absorbed highlights via their mark elements
        for (const h of absorbed) {
          const marks = getHighlightMarks(h.id, root);
          if (marks.length > 0) {
            const markRange = document.createRange();
            markRange.setStartBefore(marks[0]!);
            markRange.setEndAfter(marks[marks.length - 1]!);
            const offsets = rangeToCharOffsets(markRange, root);
            unionStart = Math.min(unionStart, offsets.start);
            unionEnd = Math.max(unionEnd, offsets.end);
          }
        }

        const unionRange = charOffsetsToRange(unionStart, unionEnd, root);
        if (!unionRange) return;

        const unionText = extractRangeText(unionRange).trim();
        const unionAnchor = describeRange(root, unionRange);
        if (!unionAnchor.exact.trim() || !unionText) return;

        // Build merged note from all highlights
        let mergedNote = survivor.note ?? '';
        for (const h of absorbed) {
          if (h.note) {
            mergedNote = mergedNote ? `${mergedNote}\n---\n${h.note}` : h.note;
          }
        }

        const originalSurvivor = { ...survivor };
        const deletedHighlights = absorbed.map((h) => ({ ...h }));

        const unionPosDataStr = JSON.stringify(unionAnchor);
        const absorbedIds = new Set(absorbed.map((h) => h.id));

        await Promise.all([
          updateHighlight(survivor.id, {
            text: unionText,
            positionData: unionPosDataStr,
            note: mergedNote || undefined,
          }),
          ...absorbed.map((h) => deleteHighlight(h.id)),
        ]);

        setHighlights((prev) =>
          prev
            .filter((h) => !absorbedIds.has(h.id))
            .map((h) =>
              h.id === survivor.id
                ? { ...h, text: unionText, positionData: unionPosDataStr, note: mergedNote || null }
                : h,
            ),
        );

        setMergeUndo({ deletedHighlights, originalSurvivor });
      } catch {
        // Merge failed — leave highlights as-is
      }
    },
    [],
  );

  /**
   * Handles merge undo: re-creates the deleted highlight and restores the survivor.
   */
  const handleMergeUndo = useCallback(async () => {
    if (!mergeUndo) return;

    try {
      const { deletedHighlights, originalSurvivor } = mergeUndo;

      // Restore survivor to original state
      await updateHighlight(originalSurvivor.id, {
        text: originalSurvivor.text,
        positionData: originalSurvivor.positionData ?? undefined,
        note: originalSurvivor.note ?? undefined,
      });

      // Re-create all deleted highlights
      const restored = await Promise.all(
        deletedHighlights.map((h) =>
          createHighlight({
            articleId,
            text: h.text,
            note: h.note ?? undefined,
            positionData: h.positionData ?? undefined,
          }),
        ),
      );

      // Update local state
      setHighlights((prev) =>
        prev.map((h) => (h.id === originalSurvivor.id ? originalSurvivor : h)).concat(restored),
      );
    } catch {
      // Undo failed — silently ignore
    }

    setMergeUndo(null);
  }, [mergeUndo, articleId]);

  /**
   * Persists the current selection as the edited highlight's new boundaries.
   * Detects overlapping highlights and triggers merge if needed.
   * Returns true if a save was performed, false otherwise.
   */
  const performSave = useCallback(async (): Promise<boolean> => {
    if (!editingHighlight || !contentRef.current) return false;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;

    const range = sel.getRangeAt(0);
    if (!contentRef.current.contains(range.commonAncestorContainer)) return false;

    const text = extractRangeText(range).trim();
    if (!text) return false;

    try {
      // Check for merge before serializing (merge uses live DOM ranges)
      const overlapping = findOverlappingHighlights(editingHighlight.id, range);
      if (overlapping.length > 0) {
        await mergeHighlights(editingHighlight, overlapping, range);
        return true;
      }

      const anchor = describeRange(contentRef.current, range);
      if (!anchor.exact.trim()) return false;

      const positionDataStr = JSON.stringify(anchor);

      // Check if range unchanged — avoid unnecessary PATCH
      if (editingHighlight.text === text && editingHighlight.positionData === positionDataStr) {
        return false;
      }

      // PATCH the highlight (preserves ID, creation date, review history, tags)
      await updateHighlight(editingHighlight.id, {
        text,
        positionData: positionDataStr,
      });

      setHighlights((prev) =>
        prev.map((h) =>
          h.id === editingHighlight.id ? { ...h, text, positionData: positionDataStr } : h,
        ),
      );
      return true;
    } catch {
      return false;
    }
  }, [editingHighlight, findOverlappingHighlights, mergeHighlights]);

  /**
   * Saves the edited highlight and exits edit mode.
   * Used by click-outside, Escape key, and confirm button.
   */
  const saveEditedHighlight = useCallback(async () => {
    await performSave();
    exitEditMode();
  }, [performSave, exitEditMode]);

  // Click-outside-to-save during edit mode
  useEffect(() => {
    if (!editingHighlight) return;

    const handleMouseDown = (e: MouseEvent) => {
      // Don't save if clicking the popover
      const popover = (e.target as HTMLElement).closest(POPOVER_SELECTOR);
      if (popover) return;

      // Don't save if clicking selection handles
      const handle = (e.target as HTMLElement).closest(HANDLE_SELECTOR);
      if (handle) return;

      // Don't save if clicking inside the highlight mark
      const mark = (e.target as HTMLElement).closest(HIGHLIGHT_MARK_SELECTOR);
      if (mark) return;

      // Click outside → save and exit
      saveEditedHighlight();
    };

    // Delay listener attachment to avoid catching the click/dblclick that entered edit mode
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleMouseDown);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [editingHighlight, saveEditedHighlight]);

  // Escape key saves and exits edit mode
  useEffect(() => {
    if (!editingHighlight) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Don't handle if typing in textarea (let popover handle it)
        const target = e.target as HTMLElement;
        if (target.tagName === 'TEXTAREA') return;

        e.preventDefault();
        saveEditedHighlight();
      }
    };

    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [editingHighlight, saveEditedHighlight]);

  // Listen for clicks on highlighted marks → enter edit mode.
  // On mobile, also check if the tap lands between lines of a multi-line highlight
  // (the gap between mark segments where the target is the parent element, not a mark).
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      // Don't handle clicks during edit mode (handled by mousedown above)
      if (editingRef.current) return;

      const mark = (e.target as HTMLElement).closest(HIGHLIGHT_MARK_SELECTOR);
      if (mark) {
        const highlightId = parseInt(mark.getAttribute('data-highlight-id')!, 10);
        if (!highlightId) return;
        const highlight = highlightsRef.current.find((h) => h.id === highlightId);
        if (highlight) setEditingHighlight(highlight);
        return;
      }

      // Mobile: tap may land between lines of a multi-line highlight.
      // Check if the tap point falls within any highlight's bounding box.
      if (!isMobileDevice) return;
      const root = contentRef.current;
      if (!root) return;

      for (const h of highlightsRef.current) {
        const marks = getHighlightMarks(h.id, root);
        const box = getElementsBoundingBox(marks);
        if (!box) continue;
        if (
          e.clientX >= box.left &&
          e.clientX <= box.right &&
          e.clientY >= box.top &&
          e.clientY <= box.bottom
        ) {
          setEditingHighlight(h);
          return;
        }
      }
    };

    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  // Show handles on hover over highlighted marks (desktop only)
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;

    const handleMouseOver = (e: MouseEvent) => {
      if (editingRef.current) return;
      const mark = (e.target as HTMLElement).closest(HIGHLIGHT_MARK_SELECTOR);
      if (!mark || !root.contains(mark)) return;
      const id = parseInt(mark.getAttribute('data-highlight-id')!, 10);
      if (id) setHoveredHighlightId(id);
    };

    root.addEventListener('mouseover', handleMouseOver);
    return () => root.removeEventListener('mouseover', handleMouseOver);
  }, []);

  // Clear hover when mouse moves away from both highlights and handles.
  // Uses a document-level listener (only active while hovering) to avoid
  // flicker when the mouse crosses between the mark and the fixed-position handle.
  // The bounding box is cached once when the hover starts to avoid layout thrashing
  // on every mouseover event; invalidated on scroll/resize.
  useEffect(() => {
    if (!hoveredHighlightId) return;

    // Compute and cache the bounding box of all marks for this highlight
    let cachedBox: import('@/lib/selection-handle-utils').BoundingBox | null = null;
    const computeBox = () => {
      const root = contentRef.current;
      if (!root) return null;
      const marks = getHighlightMarks(hoveredHighlightId, root);
      return getElementsBoundingBox(marks);
    };
    cachedBox = computeBox();

    const invalidateCache = () => {
      cachedBox = null;
    };

    const handleMouseOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(HIGHLIGHT_MARK_SELECTOR)) return;
      if (target.closest(HANDLE_SELECTOR)) return;

      // Check if mouse is within the overall bounding box of the hovered highlight
      // (covers gaps between lines within a multi-line highlight)
      if (!cachedBox) cachedBox = computeBox();
      if (cachedBox) {
        if (
          e.clientX >= cachedBox.left &&
          e.clientX <= cachedBox.right &&
          e.clientY >= cachedBox.top &&
          e.clientY <= cachedBox.bottom
        ) {
          return;
        }
      }

      setHoveredHighlightId(null);
    };

    document.addEventListener('mouseover', handleMouseOver);
    window.addEventListener('scroll', invalidateCache, { passive: true });
    window.addEventListener('resize', invalidateCache, { passive: true });
    return () => {
      document.removeEventListener('mouseover', handleMouseOver);
      window.removeEventListener('scroll', invalidateCache);
      window.removeEventListener('resize', invalidateCache);
    };
  }, [hoveredHighlightId]);

  const handleHighlight = useCallback(
    async (range: Range) => {
      if (!contentRef.current) return;

      const text = extractRangeText(range).trim();
      if (!text) return;

      try {
        const root = contentRef.current;

        // Check if the new selection overlaps with any existing highlights.
        // If so, merge them all into one instead of creating a duplicate.
        const overlapping = findOverlappingHighlights(-1, range);

        if (overlapping.length > 0) {
          // Clear the flag here so it doesn't leak into the next non-overlap call
          skipEditModeRef.current = false;
          const newOffsets = rangeToCharOffsets(range, root);
          let unionStart = newOffsets.start;
          let unionEnd = newOffsets.end;

          // Expand union to cover all overlapping highlights via their mark elements
          for (const h of overlapping) {
            const marks = getHighlightMarks(h.id, root);
            if (marks.length > 0) {
              const markRange = document.createRange();
              markRange.setStartBefore(marks[0]!);
              markRange.setEndAfter(marks[marks.length - 1]!);
              const offsets = rangeToCharOffsets(markRange, root);
              unionStart = Math.min(unionStart, offsets.start);
              unionEnd = Math.max(unionEnd, offsets.end);
            }
          }

          const unionRange = charOffsetsToRange(unionStart, unionEnd, root);
          if (!unionRange) return;

          const unionText = extractRangeText(unionRange).trim();
          const unionAnchor = describeRange(root, unionRange);
          if (!unionAnchor.exact.trim() || !unionText) return;

          const posDataStr = JSON.stringify(unionAnchor);

          // Keep the first overlapping highlight as survivor, delete the rest
          const survivor = overlapping[0]!;
          const toDelete = overlapping.slice(1);
          const deleteIds = new Set(toDelete.map((h) => h.id));

          await Promise.all([
            updateHighlight(survivor.id, {
              text: unionText,
              positionData: posDataStr,
            }),
            ...toDelete.map((h) => deleteHighlight(h.id)),
          ]);

          const merged = { ...survivor, text: unionText, positionData: posDataStr };
          setHighlights((prev) =>
            prev
              .filter((h) => !deleteIds.has(h.id))
              .map((h) => (h.id === survivor.id ? merged : h)),
          );
          setEditingHighlight(merged);
          window.getSelection()?.removeAllRanges();
          return;
        }

        // No overlap — create new highlight
        const anchor = describeRange(root, range);
        if (!anchor.exact.trim()) return;

        const highlight = await createHighlight({
          articleId,
          text,
          positionData: JSON.stringify(anchor),
        });

        // Batch state updates — selection will be restored by the
        // editingMarkEl effect after marks are applied to the DOM.
        setHighlights((prev) => [...prev, highlight]);
        if (skipEditModeRef.current) {
          skipEditModeRef.current = false;
        } else {
          setEditingHighlight(highlight);
        }
        window.getSelection()?.removeAllRanges();
      } catch {
        // Silently fail — user can retry
      }
    },
    [articleId, findOverlappingHighlights],
  );

  const handleDelete = useCallback(async (highlightId: number) => {
    // Suppress auto-create that might trigger from DOM changes after deletion
    suppressAutoCreateRef.current = true;

    // Optimistically remove from state so marks disappear immediately
    setHighlights((prev) => prev.filter((h) => h.id !== highlightId));

    try {
      await deleteHighlight(highlightId);
    } catch {
      // API failed — highlight already removed from local state.
      // Don't restore it (the user intended to delete).
    }

    setTimeout(() => {
      suppressAutoCreateRef.current = false;
    }, 500);
  }, []);

  // Track touch events so mouseup handler can skip on touch devices.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;

    const handleTouch = () => {
      lastTouchEndRef.current = Date.now();
    };

    root.addEventListener('touchstart', handleTouch, { passive: true });
    root.addEventListener('touchend', handleTouch, { passive: true });
    return () => {
      root.removeEventListener('touchstart', handleTouch);
      root.removeEventListener('touchend', handleTouch);
    };
  }, []);

  // Double-click/double-tap on a paragraph to highlight the entire block.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;

    const handleDblClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Double-click on existing highlight → do nothing
      if (target.closest(HIGHLIGHT_MARK_SELECTOR)) return;

      // Don't trigger during edit mode
      if (editingRef.current) return;

      const block = findBlockAncestor(target, root);
      if (!block) return;

      const range = document.createRange();
      range.selectNodeContents(block);

      window.getSelection()?.removeAllRanges();
      handleHighlight(range);
    };

    root.addEventListener('dblclick', handleDblClick);
    return () => root.removeEventListener('dblclick', handleDblClick);
  }, [handleHighlight]);

  // Auto-highlight on text selection: when the user finishes selecting text
  // (mouseup), immediately create a highlight and enter edit mode.
  // Delayed by 300ms to let dblclick fire first (dblclick triggers mouseup too).
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const handleMouseDown = () => {
      mouseDownRef.current = true;
    };

    const handleMouseUp = () => {
      mouseDownRef.current = false;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // Don't trigger during edit mode (dblclick may have entered it)
        if (editingRef.current) return;

        // Don't trigger right after a deletion
        if (suppressAutoCreateRef.current) return;

        // Skip on touch devices — the selectionchange handler creates highlights instead
        if (Date.now() - lastTouchEndRef.current < 1000) return;

        const range = getValidSelectionRange(root);
        if (!range) return;

        mouseupHandledRef.current = true;
        handleHighlight(range);
      }, 300);
    };

    root.addEventListener('mousedown', handleMouseDown);
    root.addEventListener('mouseup', handleMouseUp);
    return () => {
      root.removeEventListener('mousedown', handleMouseDown);
      root.removeEventListener('mouseup', handleMouseUp);
      if (timer) clearTimeout(timer);
    };
  }, [handleHighlight]);

  // Mobile: create highlight when user finishes selecting and taps away.
  // Tracks the last valid selection range; when the selection collapses
  // (user tapped elsewhere), creates a highlight from the saved range.
  // Desktop: auto-create via selectionchange after a debounce.
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let mobileRaf = 0;

    const handleSelectionChange = () => {
      if (debounceTimer) clearTimeout(debounceTimer);

      if (isMobileDevice) {
        // Coalesce rapid selectionchange events into one rAF frame
        cancelAnimationFrame(mobileRaf);
        mobileRaf = requestAnimationFrame(() => {
          const root = contentRef.current;
          if (!root || editingRef.current || suppressAutoCreateRef.current) return;

          const sel = window.getSelection();
          if (!sel || sel.rangeCount === 0) return;

          if (sel.isCollapsed) {
            // Selection collapsed (user tapped away) — create highlight without entering edit mode
            const savedRange = pendingRangeRef.current;
            clearPendingSelection();
            if (savedRange && root.contains(savedRange.commonAncestorContainer)) {
              const text = extractRangeText(savedRange).trim();
              if (text) {
                skipEditModeRef.current = true;
                handleHighlight(savedRange);
              }
            }
          } else {
            // Active selection — save it and show confirm UI
            const range = sel.getRangeAt(0);
            if (root.contains(range.commonAncestorContainer) && range.toString().trim()) {
              pendingRangeRef.current = range.cloneRange();
              // Insert a hidden anchor span at the selection start for popover positioning
              if (!pendingAnchorRef.current) {
                const anchor = document.createElement('span');
                anchor.style.cssText = 'position:absolute;pointer-events:none;width:0;height:0;';
                document.body.appendChild(anchor);
                pendingAnchorRef.current = anchor;
              }
              const rect = range.getBoundingClientRect();
              pendingAnchorRef.current.style.left = `${rect.left + window.scrollX}px`;
              pendingAnchorRef.current.style.top = `${rect.top + window.scrollY}px`;
              pendingAnchorRef.current.style.width = `${rect.width}px`;
              pendingAnchorRef.current.style.height = `${rect.height}px`;
              setHasPendingSelection(true);
            }
          }
        });
        return;
      }

      // Desktop: auto-create after debounce
      debounceTimer = setTimeout(() => {
        if (editingRef.current) return;
        if (suppressAutoCreateRef.current) return;
        if (mouseDownRef.current) return;

        if (mouseupHandledRef.current) {
          mouseupHandledRef.current = false;
          return;
        }

        const root = contentRef.current;
        if (!root) return;

        const range = getValidSelectionRange(root);
        if (!range) return;

        handleHighlight(range);
      }, 400);
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      if (debounceTimer) clearTimeout(debounceTimer);
      cancelAnimationFrame(mobileRaf);
    };
  }, [handleHighlight, clearPendingSelection]);

  const handleUpdateNote = useCallback(async (highlightId: number, note: string) => {
    try {
      await updateHighlight(highlightId, { note: note || undefined });
      setHighlights((prev) =>
        prev.map((h) => (h.id === highlightId ? { ...h, note: note || null } : h)),
      );
    } catch {
      // Silently fail
    }
  }, []);

  const dismissUndo = useCallback(() => setMergeUndo(null), []);

  const handleDeleteEditing = useCallback(async () => {
    if (!editingHighlight) return;

    // Exit edit mode immediately (clears selection, handles, popover)
    // before the async delete to prevent any auto-create race conditions.
    const idToDelete = editingHighlight.id;
    exitEditMode();
    await handleDelete(idToDelete);
  }, [editingHighlight, handleDelete, exitEditMode]);

  // When user grabs a handle from hover state, enter edit mode for that highlight
  const handleHandleDragStart = useCallback(() => {
    if (editingHighlight) return; // already in edit mode
    if (!hoveredHighlightId) return;

    const highlight = highlightsRef.current.find((h) => h.id === hoveredHighlightId);
    if (highlight) {
      setEditingHighlight(highlight);
    }
  }, [editingHighlight, hoveredHighlightId]);

  // Confirm pending mobile selection: create highlight from saved range
  const confirmPendingSelection = useCallback(() => {
    const range = pendingRangeRef.current;
    clearPendingSelection();
    window.getSelection()?.removeAllRanges();
    if (range && contentRef.current?.contains(range.commonAncestorContainer)) {
      handleHighlight(range);
    }
  }, [handleHighlight, clearPendingSelection]);

  // Dismiss pending selection without creating a highlight
  const dismissPendingSelection = useCallback(() => {
    clearPendingSelection();
    window.getSelection()?.removeAllRanges();
  }, [clearPendingSelection]);

  // Desktop: show handles on hover + edit. Mobile: edit mode only (no hover).
  const handlesHighlightId = isMobileDevice
    ? (editingHighlight?.id ?? null)
    : (editingHighlight?.id ?? hoveredHighlightId);

  return (
    <>
      <div ref={contentRef} data-testid="highlight-layer">
        {children}
      </div>

      {}
      {/* Custom selection handles: desktop hover+edit, mobile edit only */}
      {handlesHighlightId && (
        <SelectionHandles
          contentRoot={contentRef.current}
          highlightId={handlesHighlightId}
          setSelection={editingHighlight !== null}
          onDragStart={handleHandleDragStart}
          onSelectionChange={performSave}
        />
      )}

      {editingHighlight && editingMarkEl && (
        <HighlightPopover
          highlightId={editingHighlight.id}
          note={editingHighlight.note}
          markElement={editingMarkEl}
          onUpdateNote={handleUpdateNote}
          onDelete={handleDeleteEditing}
          onConfirm={saveEditedHighlight}
        />
      )}
      {/* Mobile: popover while user has an active selection (before highlight creation) */}
      {isMobileDevice && hasPendingSelection && pendingAnchorRef.current && (
        <HighlightPopover
          highlightId={0}
          note={null}
          markElement={pendingAnchorRef.current}
          onUpdateNote={() => {}}
          onDelete={dismissPendingSelection}
          onConfirm={confirmPendingSelection}
        />
      )}
      {}

      <UndoToast visible={mergeUndo !== null} onUndo={handleMergeUndo} onDismiss={dismissUndo} />
    </>
  );
}

/**
 * Applies highlight marks to the article DOM content.
 * Clears previous marks, resolves v2 and v1 anchors, and returns side-effect
 * descriptors for the calling effect to PATCH the server asynchronously.
 */
function applyHighlightsToDOM(
  root: HTMLDivElement,
  highlights: Highlight[],
): { orphaned: number[]; drifted: Array<{ id: number; anchor: TextQuoteAnchor }> } {
  const orphaned: number[] = [];
  const drifted: Array<{ id: number; anchor: TextQuoteAnchor }> = [];

  // Remove existing highlight marks so we have a clean DOM for resolution.
  stripHighlightMarks(root, HIGHLIGHT_MARK_SELECTOR);

  // Resolve ALL highlights to char offsets on the clean DOM first,
  // before any wrapping modifies the tree.
  const toApply: { highlight: Highlight; start: number; end: number }[] = [];
  // Cache once — root.textContent is O(DOM size) and reused for every text-search highlight
  const articleText = root.textContent ?? '';

  for (const h of highlights) {
    try {
      // Orphaned highlights are not rendered — skip entirely to avoid re-PATCHing every render.
      if (h.anchorStatus === 'orphaned') continue;

      if (!h.positionData) {
        // No position data — fall back to text search (legacy path).
        const searchText = h.text.trim();
        if (!searchText) continue;
        const idx = articleText.indexOf(searchText);
        if (idx === -1) continue;
        toApply.push({ highlight: h, start: idx, end: idx + searchText.length });
        continue;
      }

      const parsed: unknown = JSON.parse(h.positionData);

      if (isV2Anchor(parsed)) {
        // v2 text-quote anchor — primary path.
        // Fast path: content unchanged at stored offsets — skip DOM traversal entirely.
        if (articleText.slice(parsed.start, parsed.end) === parsed.exact) {
          toApply.push({ highlight: h, start: parsed.start, end: parsed.end });
          continue;
        }
        // Drifted path: fuzzy resolve then persist refreshed anchor.
        const range = anchorToRange(root, parsed);
        if (!range) {
          orphaned.push(h.id);
          continue;
        }
        const refreshed = describeRange(root, range);
        drifted.push({ id: h.id, anchor: refreshed });
        toApply.push({ highlight: h, start: refreshed.start, end: refreshed.end });
      } else {
        // v1 child-index anchor — lazy fallback; upgraded in place on first successful render (§9).
        const position = parsed as PositionData;
        const range = deserializeRange(position, root);
        if (!range) {
          // v1 path broken — treat as unresolvable. The reanchor route handles
          // fuzzy recovery via recoverAnchorFromText; the reader doesn't guess.
          orphaned.push(h.id);
          continue;
        }
        const refreshed = describeRange(root, range);
        drifted.push({ id: h.id, anchor: refreshed });
        toApply.push({ highlight: h, start: refreshed.start, end: refreshed.end });
      }
    } catch {
      continue;
    }
  }

  // Sort by start position descending — apply from end to start
  // so that wrapping doesn't shift char offsets of remaining highlights.
  toApply.sort((a, b) => b.start - a.start);

  for (const { highlight, start, end } of toApply) {
    const range = charOffsetsToRange(start, end, root);
    if (!range) continue;

    try {
      wrapRangeWithMark(range, highlight.id, highlight.color);
    } catch {
      // Range may be invalid; skip
    }
  }

  return { orphaned, drifted };
}

/**
 * Wraps a DOM range with <mark> elements, handling cross-element ranges.
 */
function wrapRangeWithMark(range: Range, highlightId: number, color: string): void {
  // For simple same-container ranges, use surroundContents
  if (
    range.startContainer === range.endContainer &&
    range.startContainer.nodeType === Node.TEXT_NODE
  ) {
    const mark = document.createElement('mark');
    mark.setAttribute('data-highlight-id', String(highlightId));
    mark.className = `highlight highlight-${color}`;
    range.surroundContents(mark);
    return;
  }

  // For cross-element ranges, wrap each text node segment
  const textNodes = getTextNodesInRange(range);

  for (const { node, start, end } of textNodes) {
    const mark = document.createElement('mark');
    mark.setAttribute('data-highlight-id', String(highlightId));
    mark.className = `highlight highlight-${color}`;

    const textToWrap = (node as Text).splitText(start);
    textToWrap.splitText(end - start);

    const parent = textToWrap.parentNode!;
    parent.replaceChild(mark, textToWrap);
    mark.appendChild(textToWrap);
  }
}

/**
 * Gets all text node segments within a range with their start/end offsets.
 */
function getTextNodesInRange(range: Range): { node: Node; start: number; end: number }[] {
  const result: { node: Node; start: number; end: number }[] = [];
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);

  let node = walker.nextNode();
  while (node) {
    if (range.intersectsNode(node)) {
      const textNode = node as Text;
      let start = 0;
      let end = textNode.length;

      if (node === range.startContainer) {
        start = range.startOffset;
      }
      if (node === range.endContainer) {
        end = range.endOffset;
      }

      // Skip whitespace-only segments (e.g., newlines between <p> tags)
      if (end > start && textNode.textContent?.slice(start, end).trim()) {
        result.push({ node, start, end });
      }
    }
    node = walker.nextNode();
  }

  // Process in reverse to avoid offset corruption
  result.reverse();
  return result;
}
