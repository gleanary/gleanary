/**
 * Highlight anchoring — environment-agnostic core (browser + jsdom).
 *
 * Two anchor models coexist during migration:
 * - **v2 (current): text-quote + text-position.** A durable {@link TextQuoteAnchor} of
 *   `exact`/`prefix`/`suffix` plus char offsets into the article's root text stream
 *   (`describeRange` / `anchorToRange`). Survives reformatting of the content HTML.
 * - **v1 (legacy): child-index DOM path.** `{ startContainerPath, ... }` relative to the
 *   content root (`serializeRange` / `deserializeRange`). Kept importable for the backfill
 *   and the transitional reader fallback; removed once the backfill is confirmed.
 *
 * All functions operate on the standard DOM `Element`/`Range`/`Text` interfaces and derive
 * their document from `root.ownerDocument`, so the same code runs client-side (reader) and
 * server-side under jsdom (backfill / re-anchor). No `window`, React, or Node APIs.
 * See docs/modules/highlight-anchoring.md.
 */

import search from 'approx-string-match';
import type { TextQuoteAnchor } from '@/types';

// Numeric DOM constants — used instead of the global `Node`/`NodeFilter`, which are
// absent in a bare Node/tsx process (e.g. the backfill script). Values are fixed by the
// DOM spec.
const SHOW_TEXT = 0x4;
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** Serialized position of a highlight within the article DOM. */
export interface PositionData {
  startContainerPath: number[];
  startOffset: number;
  endContainerPath: number[];
  endOffset: number;
  /** The highlighted text, stored for verification. */
  text: string;
}

/**
 * Computes the path from a node to the root as an array of child indices.
 * @param node - Target node
 * @param root - Root container element
 * @returns Array of child indices, or null if node is not inside root
 */
export function getNodePath(node: Node, root: Element): number[] | null {
  if (node === root) return [];

  const path: number[] = [];
  let current: Node | null = node;

  while (current && current !== root) {
    const parentNode: ParentNode | null = current.parentNode;
    if (!parentNode) return null;

    const index = Array.prototype.indexOf.call(parentNode.childNodes, current);
    if (index === -1) return null;

    path.unshift(index);
    current = parentNode as Node;
  }

  if (current !== root) return null;
  return path;
}

/**
 * Resolves a child-index path to a DOM node.
 * @param path - Array of child indices from root
 * @param root - Root container element
 * @returns The target node, or null if the path is invalid
 */
export function getNodeFromPath(path: number[], root: Element): Node | null {
  let current: Node = root;

  for (const index of path) {
    if (!current.childNodes || index >= current.childNodes.length) return null;
    current = current.childNodes[index]!;
  }

  return current;
}

/**
 * Recursively extracts text from a DOM node, replacing KaTeX elements with their
 * LaTeX source wrapped in $...$ delimiters. Skips katex-mathml subtrees to avoid
 * capturing the duplicate annotation text that range.toString() would otherwise include.
 */
function getTextFromNode(node: Node): string {
  if (node.nodeType === TEXT_NODE) return node.textContent ?? '';

  if (node.nodeType === ELEMENT_NODE) {
    const el = node as Element;
    // Skip MathML subtrees — duplicate of the HTML rendering + raw LaTeX annotation
    if (el.classList.contains('katex-mathml')) return '';
    // For a KaTeX wrapper: use the LaTeX source so it can be re-rendered later
    if (el.classList.contains('katex')) {
      const annotation = el.querySelector('annotation[encoding="application/x-tex"]');
      if (annotation?.textContent) {
        const src = annotation.textContent.trim();
        const isDisplay = !!el.closest('.katex-display');
        return isDisplay ? `$$${src}$$` : `$${src}$`;
      }
      // Fallback: plain text from the HTML rendering only
      return el.querySelector('.katex-html')?.textContent ?? el.textContent ?? '';
    }
  }

  return Array.from(node.childNodes).map(getTextFromNode).join('');
}

/**
 * Extracts the text of a DOM Range, replacing KaTeX-rendered math with their
 * original LaTeX source wrapped in $ delimiters instead of font-encoded characters.
 */
export function extractRangeText(range: Range): string {
  return getTextFromNode(range.cloneContents());
}

/**
 * Serializes a DOM Range into a PositionData object relative to the root element.
 * @param range - The DOM Range to serialize
 * @param root - The article content root element
 * @returns Serialized position data
 */
export function serializeRange(range: Range, root: Element): PositionData {
  const startPath = getNodePath(range.startContainer, root);
  const endPath = getNodePath(range.endContainer, root);

  if (!startPath || !endPath) {
    throw new Error('Range is not within the root element');
  }

  return {
    startContainerPath: startPath,
    startOffset: range.startOffset,
    endContainerPath: endPath,
    endOffset: range.endOffset,
    text: extractRangeText(range),
  };
}

/**
 * Deserializes a PositionData object back into a DOM Range.
 * @param data - Serialized position data
 * @param root - The article content root element
 * @returns A DOM Range, or null if the position can't be restored
 */
export function deserializeRange(data: PositionData, root: Element): Range | null {
  const startNode = getNodeFromPath(data.startContainerPath, root);
  const endNode = getNodeFromPath(data.endContainerPath, root);

  if (!startNode || !endNode) return null;

  // Validate offsets
  const startLength =
    startNode.nodeType === TEXT_NODE ? (startNode as Text).length : startNode.childNodes.length;
  const endLength =
    endNode.nodeType === TEXT_NODE ? (endNode as Text).length : endNode.childNodes.length;

  if (data.startOffset > startLength || data.endOffset > endLength) return null;

  const range = root.ownerDocument.createRange();
  range.setStart(startNode, data.startOffset);
  range.setEnd(endNode, data.endOffset);
  return range;
}

/**
 * Converts a DOM Range to absolute character offsets within the root's text content.
 * Character offsets are stable across mark element addition/removal since marks
 * don't change the text content, only the DOM structure.
 * Works with any container type (text nodes, elements, etc.).
 * @param range - The DOM Range to convert
 * @param root - The article content root element
 * @returns Start and end character offsets
 */
export function rangeToCharOffsets(range: Range, root: Element): { start: number; end: number } {
  // Create a range from root start to the range's start point.
  // Its text length equals the start character offset.
  const beforeStart = root.ownerDocument.createRange();
  beforeStart.setStart(root, 0);
  beforeStart.setEnd(range.startContainer, range.startOffset);
  const start = beforeStart.toString().length;

  // Same for the end point.
  const beforeEnd = root.ownerDocument.createRange();
  beforeEnd.setStart(root, 0);
  beforeEnd.setEnd(range.endContainer, range.endOffset);
  const end = beforeEnd.toString().length;

  return { start, end };
}

/**
 * Converts absolute character offsets back into a DOM Range.
 * Works on any DOM state (with or without marks).
 * @param start - Start character offset
 * @param end - End character offset
 * @param root - The article content root element
 * @returns A DOM Range, or null if the offsets are out of bounds
 */
export function charOffsetsToRange(start: number, end: number, root: Element): Range | null {
  const walker = root.ownerDocument.createTreeWalker(root, SHOW_TEXT);
  let charCount = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;
  let node = walker.nextNode();

  while (node) {
    const textNode = node as Text;
    const nodeEnd = charCount + textNode.length;

    // Strict `>` for start: the offset falls inside this text node
    if (!startNode && nodeEnd > start) {
      startNode = textNode;
      startOffset = start - charCount;
    }
    // Non-strict `>=` for end: end offset is exclusive (past-the-last-char)
    if (nodeEnd >= end) {
      endNode = textNode;
      endOffset = end - charCount;
      break;
    }

    charCount += textNode.length;
    node = walker.nextNode();
  }

  if (!startNode || !endNode) return null;

  const range = root.ownerDocument.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

/**
 * Strips all highlight mark elements from the DOM, unwrapping their contents.
 * After stripping, adjacent text nodes are normalized (merged).
 * @param root - The article content root element
 * @param selector - CSS selector for mark elements to strip
 */
export function stripHighlightMarks(root: Element, selector = 'mark[data-highlight-id]'): void {
  const marks = root.querySelectorAll(selector);
  const parents = new Set<Node>();
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
    parents.add(parent);
  }
  for (const parent of parents) {
    parent.normalize();
  }
}

/**
 * Queries all mark elements for a given highlight ID within a root element.
 * @param highlightId - The highlight ID to query marks for
 * @param root - The root element to search within
 * @returns NodeList of matching mark elements
 */
export function getHighlightMarks(highlightId: number, root: Element): NodeListOf<Element> {
  return root.querySelectorAll(`mark[data-highlight-id="${highlightId}"]`);
}

/**
 * Serializes a range into clean PositionData (without mark elements in paths).
 * Clones the root, strips marks from the clone, and serializes on the clean DOM.
 * This ensures paths are stable across mark application/removal.
 * @param range - The range to serialize (on the live DOM)
 * @param root - The article content root element
 * @returns Clean PositionData, or null if conversion fails
 */
export function serializeRangeClean(range: Range, root: Element): PositionData | null {
  const offsets = rangeToCharOffsets(range, root);
  const clone = root.cloneNode(true) as Element;
  stripHighlightMarks(clone);
  const cleanRange = charOffsetsToRange(offsets.start, offsets.end, clone);
  if (!cleanRange) return null;
  return serializeRange(cleanRange, clone);
}

// --- v2 text-quote anchoring (position_data v2) ---

/** Prefix/suffix context window length (chars) captured around each quote. Spec §3. */
export const ANCHOR_CONTEXT_LEN = 32;

/** Fuzzy match tolerance as a fraction of the quote length. Spec §3. */
export const ANCHOR_MAX_ERROR_RATIO = 0.25;

/**
 * Max edit distance allowed when fuzzy-matching a pattern, sized to the pattern itself:
 * `clamp(round(length * ANCHOR_MAX_ERROR_RATIO), 1, 64)`. Sizing the budget to the pattern
 * (not the pattern + context) is what lets a quote survive when its surrounding context is
 * reformatted but the quote text is intact.
 */
function maxErrorsFor(pattern: string): number {
  const raw = Math.round(pattern.length * ANCHOR_MAX_ERROR_RATIO);
  return Math.min(64, Math.max(1, raw));
}

/**
 * Sørensen–Dice bigram coefficient in [0, 1] — string similarity used to score how well a
 * candidate match's surroundings agree with the anchor's stored context. Both-empty → 1
 * (a true document boundary), exactly-one-empty → 0.
 */
function dice(a: string, b: string): number {
  if (a === b) return 1; // covers both-empty and identical strings
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length === 1 || b.length === 1) return 0; // no bigrams to compare

  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    counts.set(bg, (counts.get(bg) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    const remaining = counts.get(bg) ?? 0;
    if (remaining > 0) {
      counts.set(bg, remaining - 1);
      overlap++;
    }
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

/**
 * The article's root text stream: the in-document-order concatenation of every text node
 * within `root`, with no whitespace normalization. All v2 offsets index into this string.
 * Reproducible from the DOM at any time, which is what makes anchors portable. Spec §4.
 * @param root - The article content root element
 * @returns The concatenated text of all descendant text nodes
 */
export function getRootText(root: Element): string {
  return root.textContent ?? '';
}

/**
 * Describes a DOM Range as a durable v2 text-quote anchor (selection → anchor). Spec §5.
 * @param root - The article content root element
 * @param range - The selected range, within `root`
 * @returns A v2 anchor with quote, surrounding context, and stream offsets
 */
export function describeRange(root: Element, range: Range): TextQuoteAnchor {
  const stream = getRootText(root);
  const { start, end } = rangeToCharOffsets(range, root);
  return {
    v: 2,
    exact: stream.slice(start, end),
    prefix: stream.slice(Math.max(0, start - ANCHOR_CONTEXT_LEN), start),
    suffix: stream.slice(end, end + ANCHOR_CONTEXT_LEN),
    start,
    end,
  };
}

/** Context-agreement score for a candidate match against the anchor's stored prefix/suffix. */
function contextScore(
  stream: string,
  match: { start: number; end: number },
  anchor: TextQuoteAnchor,
): number {
  const pre = stream.slice(Math.max(0, match.start - anchor.prefix.length), match.start);
  const suf = stream.slice(match.end, match.end + anchor.suffix.length);
  return dice(pre, anchor.prefix) + dice(suf, anchor.suffix);
}

/**
 * Fuzzy-locates the anchor's quote in the stream (exact-primary, context-as-scoring).
 * Returns the best `{ start, end }` or null when nothing matches within tolerance.
 */
function locateQuote(
  stream: string,
  anchor: TextQuoteAnchor,
): { start: number; end: number } | null {
  if (anchor.exact.length === 0) return null;

  const matches = search(stream, anchor.exact, maxErrorsFor(anchor.exact));
  if (matches.length === 0) return null;
  if (matches.length === 1) return { start: matches[0]!.start, end: matches[0]!.end };

  // Rank candidates: (a) fewest errors, (b) highest context agreement, (c) closest to the
  // original position. Each criterion breaks ties for the previous one.
  let best = matches[0]!;
  let bestContext = contextScore(stream, best, anchor);
  for (let i = 1; i < matches.length; i++) {
    const m = matches[i]!;
    const mContext = contextScore(stream, m, anchor);
    if (
      m.errors < best.errors ||
      (m.errors === best.errors && mContext > bestContext) ||
      (m.errors === best.errors &&
        mContext === bestContext &&
        Math.abs(m.start - anchor.start) < Math.abs(best.start - anchor.start))
    ) {
      best = m;
      bestContext = mContext;
    }
  }
  return { start: best.start, end: best.end };
}

/**
 * Resolves a v2 anchor to a DOM Range against the current content (anchor → selection).
 * Spec §5: position fast path → quote fuzzy path → orphan (null). The fast path returns
 * before any recompute, so re-resolving an unchanged anchor never drifts its offsets.
 *
 * Pure: on a fuzzy (drifted) resolve the caller is responsible for persisting a refreshed
 * anchor (`describeRange` over the returned range) so the fast path hits next time.
 * @param root - The article content root element
 * @param anchor - The v2 anchor to resolve
 * @returns A DOM Range, or null if the quote can no longer be located (orphaned)
 */
export function anchorToRange(root: Element, anchor: TextQuoteAnchor): Range | null {
  const stream = getRootText(root);

  // 1. Position fast path — content unchanged at the stored offsets.
  if (stream.slice(anchor.start, anchor.end) === anchor.exact) {
    return charOffsetsToRange(anchor.start, anchor.end, root);
  }

  // 2. Quote fuzzy path.
  const span = locateQuote(stream, anchor);
  if (!span) return null;
  return charOffsetsToRange(span.start, span.end, root);
}

/**
 * Last-resort recovery used by the backfill: synthesize a v2 anchor from a highlight's
 * stored `text` alone (no prior offsets or context), fuzzy-matching it against the stream.
 * With no context/position to disambiguate, prefers the fewest-errors, earliest match.
 * @param root - The article content root element
 * @param text - The highlight's stored text
 * @returns A freshly described v2 anchor, or null if the text can't be located (orphaned)
 */
export function recoverAnchorFromText(root: Element, text: string): TextQuoteAnchor | null {
  if (!text) return null;
  const stream = getRootText(root);
  const matches = search(stream, text, maxErrorsFor(text));
  if (matches.length === 0) return null;

  const best = matches.reduce((b, m) =>
    m.errors < b.errors || (m.errors === b.errors && m.start < b.start) ? m : b,
  );

  const range = charOffsetsToRange(best.start, best.end, root);
  if (!range) return null;
  return describeRange(root, range);
}

/** Type guard: true when a parsed position_data payload is a v2 TextQuoteAnchor. */
export function isV2Anchor(parsed: unknown): parsed is TextQuoteAnchor {
  return typeof parsed === 'object' && parsed !== null && (parsed as { v?: unknown }).v === 2;
}
