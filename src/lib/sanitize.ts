import DOMPurify from 'isomorphic-dompurify';

const ALLOWED_TAGS = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'br',
  'hr',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'a',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'img',
  'figure',
  'figcaption',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'span',
  'div',
  'section',
  'article',
  'sup',
  'sub',
  'mark',
];

const ALLOWED_ATTR = [
  'href',
  'src',
  'alt',
  'title',
  'class',
  'width',
  'height',
  'loading',
  'colspan',
  'rowspan',
  'data-highlight-id',
];

/**
 * Sanitizes article HTML using DOMPurify.
 * Must be called before storing any externally-sourced HTML.
 * @param html - Raw HTML string from article extraction
 * @returns Sanitized HTML safe for rendering
 */
export function sanitizeArticleHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: [
      'style',
      'script',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'noscript',
      'xmp',
      'noembed',
      'noframes',
    ],
    FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'style'],
  });
}
