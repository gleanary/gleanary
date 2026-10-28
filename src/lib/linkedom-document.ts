import { parseHTML } from 'linkedom';

/** Matches a `<head>` or `<body>` start tag, which a document without `<html>` may still carry. */
const HEAD_OR_BODY_TAG_RE = /<(head|body)[\s>]/i;

/** Matches an `<html>` start tag. */
const HTML_TAG_RE = /<html[\s>]/i;

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/**
 * DOM APIs Defuddle reads that linkedom leaves out, plus `URL`, which is
 * read-only per spec but mutable in linkedom.
 */
interface PolyfillableDocument {
  styleSheets?: unknown;
  URL: string;
  defaultView: { getComputedStyle?: unknown } | null;
}

/**
 * Lowercases attribute names on HTML elements, as an HTML5 parser does.
 * linkedom keeps them verbatim (to preserve SVG camelCase such as `viewBox`),
 * so legacy markup like `<META NAME="author">` or `<IMG SRC="...">` would
 * otherwise be invisible to `getAttribute('name')` and `[name=...]` selectors.
 * SVG/MathML elements are left alone. On a duplicate name the first wins.
 */
function lowercaseAttributeNames(document: Document): void {
  for (const el of Array.from(document.querySelectorAll('*'))) {
    if (el.namespaceURI !== HTML_NAMESPACE) continue;
    const attrs = Array.from(el.attributes);
    if (attrs.every((attr) => attr.name === attr.name.toLowerCase())) continue;

    const lowered = new Map<string, string>();
    for (const attr of attrs) {
      const name = attr.name.toLowerCase();
      if (!lowered.has(name)) lowered.set(name, attr.value);
    }
    for (const attr of attrs) el.removeAttribute(attr.name);
    // linkedom's setAttribute prepends, so add in reverse to keep source order.
    for (const [name, value] of Array.from(lowered).reverse()) el.setAttribute(name, value);
  }
}

/**
 * Brings a linkedom parse in line with an HTML5 parse: lowercased attribute
 * names, and adjacent text nodes merged (htmlparser2 splits text at entities).
 */
function normalizeParsedDocument(document: Document): void {
  lowercaseAttributeNames(document);
  document.documentElement.normalize();
}

/**
 * Moves everything but `<head>` into a new `<body>` when the `<body>` tag was
 * omitted (it is optional in HTML), which linkedom does not synthesise.
 */
function ensureBody(document: Document): void {
  const root = document.documentElement;
  if (Array.from(root.children).some((el) => el.tagName === 'BODY')) return;
  const body = document.createElement('body');
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeName !== 'HEAD') body.appendChild(node);
  }
  root.appendChild(body);
}

/** Wraps a fragment so linkedom builds a full html/head/body tree around it. */
function wrapFragment(html: string): string {
  return `<!DOCTYPE html><html><head></head><body>${html}</body></html>`;
}

/**
 * Parses HTML with linkedom and returns its document.
 *
 * linkedom (htmlparser2) does not synthesise the html/head/body tree the way
 * an HTML5 parser such as jsdom does: a fragment becomes the document root and
 * leaves `document.body` empty, and bare text has no root at all. When the
 * input has no `<html>` root it is re-parsed inside one, keeping its own
 * `<head>`/`<body>` when present; an omitted `<body>` tag is synthesised.
 * Attribute names are lowercased and adjacent
 * text nodes merged, as an HTML5 parser would.
 *
 * Mirrors Defuddle's own linkedom setup: polyfills `styleSheets` and
 * `getComputedStyle` (which Defuddle reads and linkedom omits) and sets
 * `document.URL` so Defuddle resolves relative links and images against it.
 *
 * @param html - A full HTML document or a fragment
 * @param url - Optional page URL, used as the document's base URL
 * @returns The parsed document, with a populated `body`
 */
export function parseHtmlDocument(html: string, url?: string): Document {
  const wrapped = HEAD_OR_BODY_TAG_RE.test(html) ? `<html>${html}</html>` : wrapFragment(html);
  // Wrap up front when there is no `<html>` tag, so fragments parse once; the
  // root check still catches an `<html>` that only appears in a comment or string.
  let { document } = parseHTML(HTML_TAG_RE.test(html) ? html : wrapped);
  if (document.documentElement?.tagName !== 'HTML') document = parseHTML(wrapped).document;
  ensureBody(document);
  normalizeParsedDocument(document);

  const doc = document as unknown as PolyfillableDocument;
  if (!doc.styleSheets) doc.styleSheets = [];
  if (doc.defaultView && !doc.defaultView.getComputedStyle) {
    doc.defaultView.getComputedStyle = () => ({ display: '' });
  }
  if (url) doc.URL = url;

  return document;
}

/**
 * Parses an HTML fragment into a document whose `body` holds the fragment's
 * nodes, the linkedom equivalent of parsing `<body>${html}</body>` with jsdom.
 * @param html - An HTML fragment (no `<html>`/`<body>` wrapper)
 * @returns A document whose `body` children are the fragment's top-level nodes
 */
export function parseHtmlFragment(html: string): Document {
  const { document } = parseHTML(wrapFragment(html));
  normalizeParsedDocument(document);
  return document;
}
