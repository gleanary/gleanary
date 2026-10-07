import { JSDOM, VirtualConsole } from 'jsdom';

/** Suppress JSDOM noise when parsing article fragments */
const virtualConsole = new VirtualConsole();

export const CHUNK_TARGET_SIZE = 25_000;

/** Hard ceiling for a single chunk after recursion. Chunks above this are truncated. */
export const CHUNK_HARD_CEILING = 80_000;

export interface Chunk {
  index: number;
  html: string;
  charCount: number;
  /** True when the block could not be split further; may be truncated to CHUNK_HARD_CEILING. */
  isOversized: boolean;
}

function packElements(
  elements: Element[],
  targetSize: number,
): Array<{ html: string; isOversized: boolean }> {
  const result: Array<{ html: string; isOversized: boolean }> = [];
  let currentParts: string[] = [];
  let currentLen = 0;

  for (const el of elements) {
    const fragment = el.outerHTML;
    const fragLen = fragment.length;

    if (fragLen > targetSize) {
      if (currentParts.length > 0) {
        result.push({ html: currentParts.join(''), isOversized: false });
        currentParts = [];
        currentLen = 0;
      }
      result.push({ html: fragment, isOversized: true });
    } else if (currentLen + fragLen > targetSize && currentParts.length > 0) {
      result.push({ html: currentParts.join(''), isOversized: false });
      currentParts = [fragment];
      currentLen = fragLen;
    } else {
      currentParts.push(fragment);
      currentLen += fragLen;
    }
  }

  if (currentParts.length > 0) {
    result.push({ html: currentParts.join(''), isOversized: false });
  }

  return result;
}

/**
 * Split article HTML at top-level block boundaries into chunks of approximately targetSize chars.
 *
 * @param html - The article's content_html (sanitized input)
 * @param targetSize - Soft per-chunk target in chars (default: CHUNK_TARGET_SIZE)
 * @returns An ordered array of Chunk objects. Returns [] for empty/whitespace-only input.
 */
export function chunkHtml(html: string, targetSize: number = CHUNK_TARGET_SIZE): Chunk[] {
  if (!html || !html.trim()) return [];

  const dom = new JSDOM(`<body>${html}</body>`, { virtualConsole });
  const root = dom.window.document.body;
  const topLevel = Array.from(root.children);

  if (topLevel.length === 0) return [];

  const rawChunks = packElements(topLevel, targetSize);

  const expanded: Array<{ html: string; isOversized: boolean }> = [];

  for (const raw of rawChunks) {
    if (!raw.isOversized) {
      expanded.push(raw);
      continue;
    }

    const innerDom = new JSDOM(`<body>${raw.html}</body>`, { virtualConsole });
    const innerRoot = innerDom.window.document.body;
    const wrapper = innerRoot.children[0];

    if (!wrapper || wrapper.children.length === 0) {
      expanded.push(raw);
      continue;
    }

    const innerChildren = Array.from(wrapper.children);
    const subChunks = packElements(innerChildren, targetSize);

    if (subChunks.length <= 1) {
      expanded.push(raw);
    } else {
      // Re-wrap each sub-chunk in the parent's opening/closing tags so the
      // model receives valid HTML (e.g. <table> rows stay inside <table>).
      const shallowHtml = (wrapper.cloneNode(false) as Element).outerHTML;
      const tagName = wrapper.tagName.toLowerCase();
      const openTag = shallowHtml.slice(0, shallowHtml.lastIndexOf(`</${tagName}>`));
      const closeTag = `</${tagName}>`;

      for (const sub of subChunks) {
        // isOversized if recursion flagged it OR sub-chunk still exceeds target
        expanded.push({
          html: openTag + sub.html + closeTag,
          isOversized: sub.isOversized || sub.html.length > targetSize,
        });
      }
    }
  }

  return expanded.map((item, idx): Chunk => {
    let finalHtml = item.html;
    let isOversized = item.isOversized;

    if (finalHtml.length > CHUNK_HARD_CEILING) {
      finalHtml = finalHtml.slice(0, CHUNK_HARD_CEILING);
      isOversized = true;
    }

    return {
      index: idx,
      html: finalHtml,
      charCount: finalHtml.length,
      isOversized,
    };
  });
}
