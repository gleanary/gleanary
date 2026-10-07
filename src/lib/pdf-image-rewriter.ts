import { isValidPdfImageName } from '@/lib/pdf-storage';

// Matches ![alt](href) and ![alt](href "title") — captures href in group 2.
// Title form: title is dropped during rewrite (valid output, no data loss for figures).
const IMAGE_REF_RE = /!\[([^\]]*)\]\(([^)\s"]+)(?:\s+"[^"]*")?\)/g;

/**
 * Rewrites Mistral OCR image refs in Markdown to API URLs.
 * Refs in storedNames → /api/articles/<id>/images/<name>.
 * All other refs (orphans, bad names) → stripped (replaced with "").
 * @param markdown - Raw markdown from Mistral OCR
 * @param storedNames - Set of image filenames successfully written to disk
 * @param articleId - Article id used to build the serving URL
 */
export function rewriteImageRefs(
  markdown: string,
  storedNames: Set<string>,
  articleId: number,
): string {
  return markdown.replace(IMAGE_REF_RE, (_, alt: string, href: string) => {
    if (isValidPdfImageName(href) && storedNames.has(href)) {
      return `![${alt}](/api/articles/${articleId}/images/${href})`;
    }
    return '';
  });
}
