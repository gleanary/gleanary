import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
});

// Preserve images as ![alt](src)
turndown.keep(['img']);

// Remove empty links (no text content)
turndown.addRule('emptyLinks', {
  filter(node) {
    return node.nodeName === 'A' && node.textContent?.trim() === '';
  },
  replacement() {
    return '';
  },
});

// Remove empty paragraphs
turndown.addRule('emptyParagraphs', {
  filter(node) {
    return node.nodeName === 'P' && node.textContent?.trim() === '';
  },
  replacement() {
    return '';
  },
});

turndown.addRule('preserveEmbeds', {
  filter: ['iframe', 'video', 'source'],
  replacement(_content, node) {
    return '\n\n' + node.outerHTML + '\n\n';
  },
});

/**
 * Converts sanitized article HTML to markdown for AI context.
 * Preserves images, tables, blockquotes. Strips empty links and paragraphs.
 * @param html - Sanitized HTML string
 * @returns Markdown string
 */
export function convertHtmlToMarkdown(html: string): string {
  if (!html) return '';
  return turndown.turndown(html);
}
