/**
 * Utility functions for selection handle positioning and caret detection.
 * Used by the SelectionHandles component to position draggable handles
 * at the start and end of a text selection.
 */

/** Position of a single handle (x, y in viewport coordinates). */
export interface HandlePosition {
  x: number;
  y: number;
  lineHeight: number;
}

/** Positions for both start and end handles. */
export interface HandlePositions {
  start: HandlePosition;
  end: HandlePosition;
}

/** Bounding box in viewport coordinates. */
export interface BoundingBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Result of a caret position lookup from a point. */
export interface CaretPosition {
  node: Node;
  offset: number;
}

/**
 * Computes the combined bounding box of a set of elements using getClientRects.
 * Returns null if there are no elements.
 * @param elements - The elements to compute the bounding box for
 * @returns The combined bounding box in viewport coordinates, or null
 */
export function getElementsBoundingBox(
  elements: NodeListOf<Element> | Element[],
): BoundingBox | null {
  if (elements.length === 0) return null;
  let top = Infinity;
  let bottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;
  for (const el of elements) {
    const r = el.getBoundingClientRect();
    if (r.top < top) top = r.top;
    if (r.bottom > bottom) bottom = r.bottom;
    if (r.left < left) left = r.left;
    if (r.right > right) right = r.right;
  }
  return { top, bottom, left, right };
}

/**
 * Creates a DOM Range spanning all provided mark elements (first child to last child).
 * @param marks - The mark elements to span
 * @returns A Range covering all marks, or null if no marks
 */
export function createRangeFromMarks(marks: NodeListOf<Element>): Range | null {
  if (marks.length === 0) return null;
  const first = marks[0]!;
  const last = marks[marks.length - 1]!;
  const range = document.createRange();
  range.setStartBefore(first.firstChild || first);
  range.setEndAfter(last.lastChild || last);
  return range;
}

/**
 * Computes viewport positions for start and end selection handles.
 * The start handle is placed at the beginning of the first selected line;
 * the end handle is placed at the end of the last selected line.
 * Uses getClientRects() for accurate per-line positioning on multi-line selections.
 * @param range - The DOM Range to compute positions for
 * @returns Handle positions, or null if the range has no visible geometry
 */
export function computeHandlePositions(range: Range | null): HandlePositions | null {
  if (!range) return null;

  // getClientRects() returns one rect per line fragment — much more accurate
  // than getBoundingClientRect() for multi-line selections.
  const rects = range.getClientRects();
  if (rects.length === 0) return null;

  const firstRect = rects[0]!;
  const lastRect = rects[rects.length - 1]!;

  const startLineHeight = firstRect.height || 20;
  const endLineHeight = lastRect.height || 20;

  return {
    start: {
      x: firstRect.left,
      y: firstRect.top,
      lineHeight: startLineHeight,
    },
    end: {
      x: lastRect.right,
      y: lastRect.top,
      lineHeight: endLineHeight,
    },
  };
}

/**
 * Gets the caret position (text node + offset) at a given viewport coordinate.
 * Uses caretRangeFromPoint (Chrome/Safari) or caretPositionFromPoint (Firefox).
 * @param x - Viewport X coordinate
 * @param y - Viewport Y coordinate
 * @returns The caret position, or null if not determinable
 */
export function getCaretPositionFromPoint(x: number, y: number): CaretPosition | null {
  // Firefox
  if ('caretPositionFromPoint' in document) {
    const pos = (
      document as unknown as {
        caretPositionFromPoint: (
          x: number,
          y: number,
        ) => { offsetNode: Node; offset: number } | null;
      }
    ).caretPositionFromPoint(x, y);
    if (pos) {
      return { node: pos.offsetNode, offset: pos.offset };
    }
  }

  // Chrome, Safari, Edge
  if ('caretRangeFromPoint' in document) {
    const range = document.caretRangeFromPoint(x, y);
    if (range) {
      return { node: range.startContainer, offset: range.startOffset };
    }
  }

  return null;
}
