import { JSDOM, VirtualConsole } from 'jsdom';

const virtualConsole = new VirtualConsole();

/**
 * Hostname substrings that identify known tracking/pixel-serving domains.
 * Conservative list — prefer false negatives over false positives.
 */
export const TRACKING_DOMAINS: readonly string[] = [
  'mailchimp.com',
  'list-manage.com',
  'sendgrid.net',
  'mailgun.org',
  'constantcontact.com',
  'hubspot.com',
  'salesforce.com',
  'exacttarget.com',
  'marketo.com',
  'pardot.com',
  'klaviyo.com',
  'drip.com',
  'convertkit.com',
  'mailerlite.com',
  'activecampaign.com',
  'campaignmonitor.com',
  'sendinblue.com',
  'brevo.com',
  'postmark.com',
  'sparkpost.com',
];

/**
 * URL path segments that strongly indicate a tracking endpoint regardless of domain.
 */
export const TRACKING_PATH_SEGMENTS: readonly string[] = [
  '/wf/open',
  '/open.php',
  '/track/open',
  '/pixel.gif',
  '/beacon',
];

/** Minimum consecutive images (without intervening text) to wrap in a grid. */
export const CONSECUTIVE_IMAGE_THRESHOLD = 4;

/** Minimum non-whitespace chars between images to count as "has text". */
export const MIN_TEXT_BETWEEN_IMAGES = 20;

/**
 * Deterministic HTML post-processor that cleans extracted article content.
 * Runs AFTER content extraction (Defuddle) and BEFORE sanitization (DOMPurify).
 *
 * Transforms (in order):
 *  1. Remove 1×1 tracking pixels
 *  2. Strip empty/whitespace-only div, p, span elements
 *  3. Unwrap single-cell layout tables (keep content, remove table wrapper)
 *  4. Wrap consecutive image sequences (4+) in <div class="image-grid">
 *  5. Collapse nested wrapper divs that add no semantic value
 *
 * PDF-only transforms (when isPdfContext: true):
 *  6. Strip page-number paragraphs ("Page 3", "3 of 42", etc.)
 *  7. Strip repeating header/footer paragraphs (≥3 occurrences of same short text)
 *
 * @param html - HTML string (post-extraction, pre-sanitization)
 * @param options - Optional context flags
 * @returns Cleaned HTML string
 */
export function postProcessHtml(html: string, options?: { isPdfContext?: boolean }): string {
  if (!html || !html.trim()) return html;

  const dom = new JSDOM(html, { virtualConsole });
  const { document } = dom.window;

  postProcessDocument(document);

  if (options?.isPdfContext) {
    stripPageNumbers(document);
    stripRepeatingHeaders(document);
  }

  return document.body?.innerHTML ?? html;
}

/**
 * Runs all post-processing transforms on an already-parsed Document.
 * Use this when you already have a JSDOM instance to avoid a redundant parse.
 * @param document - The DOM document to process in place
 * @returns void — mutates the document in place
 */
export function postProcessDocument(document: Document): void {
  removeTrackingPixels(document);
  removeEmptyElements(document);
  unwrapLayoutTables(document);
  wrapConsecutiveImages(document);
  collapseRedundantWrappers(document);
}

/**
 * Removes tracking pixel <img> elements.
 * @param document - The DOM document to process
 * @returns void — mutates the document in place
 */
export function removeTrackingPixels(document: Document): void {
  const imgs = Array.from(document.querySelectorAll('img'));
  for (const img of imgs) {
    if (isTrackingPixel(img)) {
      img.remove();
    }
  }
}

/**
 * Determines whether an <img> element is a tracking pixel.
 * @param img - The image element to check
 * @returns true if the image is likely a tracking pixel
 */
export function isTrackingPixel(img: Element): boolean {
  const widthAttr = img.getAttribute('width');
  const heightAttr = img.getAttribute('height');

  const w = widthAttr !== null ? parseInt(widthAttr, 10) : NaN;
  const h = heightAttr !== null ? parseInt(heightAttr, 10) : NaN;

  // 1×1 pixel check (width or height <= 1 when the other is also tiny or absent)
  const isTinyByDimension =
    (!isNaN(w) && w <= 1 && (isNaN(h) || h <= 1)) || (!isNaN(h) && h <= 1 && (isNaN(w) || w <= 1));

  if (isTinyByDimension && !img.getAttribute('alt')) {
    return true;
  }

  const src = img.getAttribute('src') ?? '';
  if (!src) return false;

  let hostname = '';
  let pathname = '';
  try {
    const url = new URL(src);
    hostname = url.hostname.toLowerCase();
    pathname = url.pathname.toLowerCase();
  } catch {
    hostname = src.toLowerCase();
    pathname = src.toLowerCase();
  }

  if (TRACKING_DOMAINS.some((d) => hostname.includes(d))) return true;
  if (TRACKING_PATH_SEGMENTS.some((seg) => pathname.includes(seg))) return true;

  return false;
}

/**
 * Removes empty/whitespace-only <div>, <p>, <span> elements.
 * Works bottom-up so parents are evaluated after children are cleaned.
 * @param document - The DOM document to process
 * @returns void — mutates the document in place
 */
export function removeEmptyElements(document: Document): void {
  const candidates = Array.from(document.querySelectorAll('div, p, span')).reverse();
  for (const el of candidates) {
    if (isEmptyElement(el)) {
      el.remove();
    }
  }
}

/**
 * Checks whether an element is empty (whitespace-only, no embedded media).
 * Also used by email-preprocessor for spacer element detection.
 * @param el - The element to check
 * @returns true if the element has no meaningful content
 */
export function isEmptyElement(el: Element): boolean {
  const children = Array.from(el.children);
  if (children.some((c) => !isEmptyElement(c))) return false;

  if (el.querySelector('img, iframe, video, audio, canvas, svg')) return false;

  const text = el.textContent ?? '';
  return /^[\s\u00a0]*$/.test(text);
}

/**
 * Unwraps layout tables, replacing them with their semantic content.
 * A table is treated as layout if it has role="presentation" OR
 * is nested 3+ levels deep and has no <th> cells.
 * @param document - The DOM document to process
 * @returns void — mutates the document in place
 */
export function unwrapLayoutTables(document: Document): void {
  for (let pass = 0; pass < 5; pass++) {
    const tables = Array.from(document.querySelectorAll('table'));
    let changed = false;
    for (const table of tables) {
      if (isLayoutTable(table)) {
        unwrapTable(table);
        changed = true;
      }
    }
    if (!changed) break;
  }
}

function isLayoutTable(table: Element): boolean {
  if (table.getAttribute('role') === 'presentation') return true;
  if (table.querySelector('th')) return false;

  let depth = 0;
  let ancestor = table.parentElement;
  while (ancestor) {
    if (ancestor.tagName === 'TABLE') depth++;
    ancestor = ancestor.parentElement;
  }
  return depth >= 2;
}

function unwrapTable(table: Element): void {
  const parent = table.parentNode;
  if (!parent) return;

  const TABLE_STRUCTURE = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH']);
  const fragment = table.ownerDocument!.createDocumentFragment();

  function extractContent(el: Element): void {
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === child.TEXT_NODE) {
        if ((child.textContent ?? '').trim()) {
          fragment.appendChild(child);
        }
      } else if (child.nodeType === child.ELEMENT_NODE) {
        const childEl = child as Element;
        if (!TABLE_STRUCTURE.has(childEl.tagName)) {
          fragment.appendChild(childEl);
        } else {
          extractContent(childEl);
        }
      }
    }
  }

  extractContent(table);
  parent.insertBefore(fragment, table);
  table.remove();
}

/**
 * Wraps sequences of 4+ consecutive <img> elements (without intervening text)
 * in a <div class="image-grid">.
 * @param document - The DOM document to process
 * @returns void — mutates the document in place
 */
export function wrapConsecutiveImages(document: Document): void {
  const containers = Array.from(document.querySelectorAll('body, div, section, article, main'));

  for (const container of containers) {
    wrapImagesInContainer(container);
  }
}

function isImageNode(node: Node): boolean {
  if (node.nodeType !== node.ELEMENT_NODE) return false;
  const el = node as Element;
  if (el.tagName === 'IMG') return true;
  if (el.tagName === 'FIGURE' || el.tagName === 'A') {
    const imgs = el.querySelectorAll('img');
    const textContent = (el.textContent ?? '').replace(/\s+/g, '').trim();
    return imgs.length === 1 && textContent.length < MIN_TEXT_BETWEEN_IMAGES;
  }
  return false;
}

function isIgnorableNode(node: Node): boolean {
  if (node.nodeType === node.TEXT_NODE) {
    return (node.textContent ?? '').replace(/\s+/g, '').length < MIN_TEXT_BETWEEN_IMAGES;
  }
  if (node.nodeType === node.ELEMENT_NODE) {
    const el = node as Element;
    if (el.tagName === 'BR') return true;
  }
  return false;
}

function wrapImagesInContainer(container: Element): void {
  // Skip already-wrapped grids (idempotency)
  if (container.getAttribute('class')?.includes('image-grid')) return;

  const children = Array.from(container.childNodes);
  const runs: Node[][] = [];
  let currentRun: Node[] = [];
  let imageCount = 0;

  for (const child of children) {
    if (isImageNode(child)) {
      currentRun.push(child);
      imageCount++;
    } else if (isIgnorableNode(child) && imageCount > 0) {
      currentRun.push(child);
    } else {
      if (imageCount >= CONSECUTIVE_IMAGE_THRESHOLD) {
        runs.push(currentRun);
      }
      currentRun = [];
      imageCount = 0;
    }
  }
  if (imageCount >= CONSECUTIVE_IMAGE_THRESHOLD) {
    runs.push(currentRun);
  }

  for (const run of runs.reverse()) {
    const wrapper = container.ownerDocument!.createElement('div');
    wrapper.setAttribute('class', 'image-grid');
    container.insertBefore(wrapper, run[0]!);
    for (const node of run) {
      wrapper.appendChild(node);
    }
  }
}

const BLOCK_TAGS = new Set([
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'PRE',
  'FIGURE',
  'TABLE',
  'SECTION',
  'ARTICLE',
  'ASIDE',
]);

/** Regex for common PDF page-number patterns. */
const PAGE_NUMBER_RE = /^(page\s+)?\d+(\s+of\s+\d+)?$|^\d+\s*\/\s*\d+$|^[-–]\s*\d+\s*[-–]$/i;

/**
 * Removes <p> elements whose text content matches common page-number patterns.
 * Only runs when isPdfContext is true (via postProcessHtml options).
 * Defensive backstop — Mistral extract_header/extract_footer now handles most cases.
 * @param document - The DOM document to process
 * @returns void — mutates the document in place
 */
export function stripPageNumbers(document: Document): void {
  const paras = Array.from(document.querySelectorAll('p'));
  for (const p of paras) {
    const text = (p.textContent ?? '').trim();
    if (PAGE_NUMBER_RE.test(text)) {
      p.remove();
    }
  }
}

/**
 * Removes <p> elements whose normalized text content appears 3+ times in the document.
 * Targets running headers and footers that OCR repeats on every page.
 * Only considers short paragraphs (≤ 100 chars after trimming).
 * Defensive backstop — Mistral extract_header/extract_footer now handles most cases.
 * @param document - The DOM document to process
 * @returns void — mutates the document in place
 */
export function stripRepeatingHeaders(document: Document): void {
  const paras = Array.from(document.querySelectorAll('p'));
  const counts = new Map<string, Element[]>();

  for (const p of paras) {
    const text = (p.textContent ?? '').trim();
    if (text.length === 0 || text.length > 100) continue;
    const key = text.toLowerCase().replace(/\s+/g, ' ');
    const group = counts.get(key) ?? [];
    group.push(p);
    counts.set(key, group);
  }

  for (const group of counts.values()) {
    if (group.length >= 3) {
      for (const p of group) p.remove();
    }
  }
}

/**
 * Collapses redundant single-child wrapper divs and spans.
 * A wrapper is redundant if it has no meaningful attributes (id, class, data-*)
 * and its only child is a block-level element.
 * @param document - The DOM document to process
 * @returns void — mutates the document in place
 */
export function collapseRedundantWrappers(document: Document): void {
  for (let pass = 0; pass < 3; pass++) {
    const wrappers = Array.from(document.querySelectorAll('div, span'));
    let changed = false;
    for (const wrapper of wrappers) {
      if (!wrapper.parentNode) continue;

      const attrs = wrapper.attributes;
      const hasMeaningfulAttr = Array.from(attrs).some(
        (a) => a.name !== 'style' && a.name !== 'align' && a.name !== 'valign',
      );
      if (hasMeaningfulAttr) continue;

      const elementChildren = Array.from(wrapper.children);
      if (elementChildren.length !== 1) continue;

      const onlyChild = elementChildren[0]!;
      if (!BLOCK_TAGS.has(onlyChild.tagName)) continue;

      const textContent = Array.from(wrapper.childNodes)
        .filter((n) => n.nodeType === n.TEXT_NODE)
        .map((n) => n.textContent ?? '')
        .join('');
      if (textContent.trim()) continue;

      // Move the child in place (no cloneNode needed)
      wrapper.parentNode.insertBefore(onlyChild, wrapper);
      wrapper.remove();
      changed = true;
    }
    if (!changed) break;
  }
}
