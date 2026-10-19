import renderMathInElement from 'katex/contrib/auto-render';

type AutoRenderOptions = NonNullable<Parameters<typeof renderMathInElement>[1]>;

/**
 * KaTeX auto-render delimiters. Single `$` is deliberately absent: auto-render pairs any
 * two dollars in a text node, so prose like "$1,578 … and $966" became italic math.
 * Valid single-`$` inline math is rewritten to `\(…\)` by {@link wrapInlineDollarMath}.
 */
export const MATH_DELIMITERS: AutoRenderOptions['delimiters'] = [
  { left: '$$', right: '$$', display: true },
  { left: '\\[', right: '\\]', display: true },
  { left: '\\(', right: '\\)', display: false },
];

/** Same subtrees auto-render skips by default. */
const IGNORED_TAGS = new Set(['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option']);

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);
const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';

/**
 * Finds the closing `$` of an inline span opened at `start`, using Pandoc's
 * `tex_math_dollars` rule: the closer is not preceded by whitespace and not followed by a
 * digit, and the span never crosses a newline or another `$`. Escaped characters (`\$`) are skipped.
 * @param text - Source text
 * @param start - Index of the opening `$`
 * @returns Index of the closing `$`, or -1 when there is none
 */
function findInlineClose(text: string, start: number): number {
  for (let k = start + 1; k < text.length; k++) {
    const ch = text[k];
    if (ch === '\\') {
      k++;
    } else if (ch === '\n') {
      return -1;
    } else if (ch === '$') {
      // Stop at the first `$` even when it can't close: scanning past it would let a
      // currency opener pair with real math later on ("costs $5, and later $x$").
      return !isSpace(text[k - 1]) && !isDigit(text[k + 1]) ? k : -1;
    }
  }
  return -1;
}

/**
 * Rewrites valid single-`$` inline math to `\(…\)` following Pandoc's `tex_math_dollars`
 * rule (opening `$` immediately followed by non-whitespace; closing `$` immediately
 * preceded by non-whitespace and not followed by a digit; no newline inside). Currency
 * such as "$5 and $10" or "$5-$10" is left untouched, as are escaped `\$` and `$$…$$`.
 * @param text - Plain text (e.g. a DOM text node's data)
 * @returns The text with valid inline math wrapped in `\(…\)`
 */
export function wrapInlineDollarMath(text: string): string {
  if (!text.includes('$')) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch !== '$') {
      out += ch;
      i++;
      continue;
    }
    if (text[i + 1] === '$') {
      // Display math: copy through the matching `$$` so its contents are never re-paired.
      const end = text.indexOf('$$', i + 2);
      const next = end === -1 ? i + 2 : end + 2;
      out += text.slice(i, next);
      i = next;
      continue;
    }
    const close =
      text[i + 1] !== undefined && !isSpace(text[i + 1]) ? findInlineClose(text, i) : -1;
    if (close === -1) {
      out += ch;
      i++;
    } else {
      out += `\\(${text.slice(i + 1, close)}\\)`;
      i = close + 1;
    }
  }
  return out;
}

/**
 * Applies {@link wrapInlineDollarMath} to every text node under `node`, skipping the
 * subtrees auto-render ignores (code, pre, script, …).
 * @param node - Root node to walk
 */
function wrapTextNodes(node: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child as Text;
      const wrapped = wrapInlineDollarMath(text.data);
      if (wrapped !== text.data) text.data = wrapped;
    } else if (
      child.nodeType === Node.ELEMENT_NODE &&
      !IGNORED_TAGS.has((child as Element).tagName.toLowerCase())
    ) {
      wrapTextNodes(child);
    }
  }
}

/**
 * Renders LaTeX math inside `el` with KaTeX, using the safe delimiter set
 * ({@link MATH_DELIMITERS} plus Pandoc-style single-`$` inline math). Import this module
 * lazily (`import('@/lib/math-render')`) to keep KaTeX out of the initial bundle.
 * @param el - Element whose text content should be rendered in place
 * @param opts - Extra auto-render options (e.g. `output: 'html'`)
 */
export function renderMath(el: HTMLElement, opts?: AutoRenderOptions): void {
  wrapTextNodes(el);
  renderMathInElement(el, { delimiters: MATH_DELIMITERS, throwOnError: false, ...opts });
}
