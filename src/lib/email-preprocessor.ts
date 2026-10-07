import { JSDOM, VirtualConsole } from 'jsdom';
import { postProcessDocument, isEmptyElement } from './html-post-processor';

const virtualConsole = new VirtualConsole();

/** MSO conditional comment pattern (downlevel-hidden: content inside comment block). */
const MSO_CONDITIONAL_RE = /<!--\[if[^\]]*\]>[\s\S]*?<!\[endif\]-->/gi;

/**
 * Pre-processes raw email HTML to remove email-client noise before content extraction.
 *
 * Operations (in order):
 *  1. Strip MSO conditional comments (email-specific)
 *  2. Remove spacer elements — empty td/tr (email-specific: table cells aren't
 *     cleaned by the shared post-processor)
 *  3. Shared post-processing via postProcessDocument (tracking pixels, empty
 *     elements, layout tables, image-grid wrapping, wrapper collapse)
 *
 * This is NOT a security boundary — DOMPurify remains the XSS layer.
 * When in doubt, content is kept rather than removed.
 *
 * @param html - Raw email HTML string
 * @returns Cleaned HTML string (body innerHTML)
 */
export function preprocessEmailHtml(html: string): string {
  if (!html) return html;

  // Strip MSO conditionals before JSDOM parse (comment nodes)
  const stripped = html.replace(MSO_CONDITIONAL_RE, '');

  const dom = new JSDOM(stripped, { virtualConsole });
  const { document } = dom.window;

  // Email-specific: remove spacer td/tr elements
  removeSpacerElements(document);

  // Shared transforms on the same DOM (no redundant re-parse)
  postProcessDocument(document);

  return document.body?.innerHTML ?? html;
}

/**
 * Removes spacer elements: td or tr whose entire text content is blank and
 * that contain no meaningful child elements (including embedded media).
 *
 * This is kept email-specific because td/tr spacers are an email-layout pattern
 * that doesn't occur in web articles.
 */
function removeSpacerElements(document: Document): void {
  const candidates = Array.from(document.querySelectorAll('td, tr')).reverse();
  for (const el of candidates) {
    if (isEmptyElement(el)) {
      el.remove();
    }
  }
}
