'use client';

import { marked } from 'marked';
import { sanitizeArticleHtml } from '@/lib/sanitize';

/**
 * Converts a markdown string to sanitized HTML safe for dangerouslySetInnerHTML.
 * Uses DOMPurify via sanitizeArticleHtml to prevent XSS.
 * @param text - Raw markdown content
 * @returns Sanitized HTML string
 */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text) as string;
  return sanitizeArticleHtml(html);
}
