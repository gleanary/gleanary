'use client';

import { memo, useCallback, useEffect, useMemo, useRef } from 'react';

interface ArticleContentProps {
  html: string;
  /** Optional external ref to sync the content container element */
  onContentRef?: (el: HTMLDivElement | null) => void;
  /** Called after all async DOM transformations (e.g. KaTeX) complete */
  onReady?: () => void;
}

/**
 * Renders sanitized article HTML with reader-optimized typography.
 * Content is safe for dangerouslySetInnerHTML because it was sanitized
 * via DOMPurify (sanitizeArticleHtml) at ingestion time in the article parser.
 */
export const ArticleContent = memo(function ArticleContent({
  html,
  onContentRef,
  onReady,
}: ArticleContentProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  // Inject referrerpolicy="no-referrer" on every img tag before the HTML hits the DOM.
  // A useEffect approach fires too late — the browser starts fetching image sources the
  // moment dangerouslySetInnerHTML inserts them, before any effects run. In production
  // (HTTPS), the browser sends the site origin as Referer; many CDNs block unknown
  // referrers, causing ERR_FAILED. Locally (HTTP) referrer checks are loose, so it passes.
  const safeHtml = useMemo(
    () => html.replace(/<img\b/g, '<img referrerpolicy="no-referrer"'),
    [html],
  );

  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      (contentRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
      onContentRef?.(el);
    },
    [onContentRef],
  );

  // Open external links in new tab
  useEffect(() => {
    if (!contentRef.current) return;
    const links = contentRef.current.querySelectorAll('a[href]');
    for (const link of links) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
  }, [html]);

  // Wrap tables in a horizontally scrollable container
  useEffect(() => {
    if (!contentRef.current) return;
    const tables = contentRef.current.querySelectorAll('table');
    tables.forEach((table) => {
      if (table.parentElement?.classList.contains('table-scroll-wrapper')) return;
      const wrapper = document.createElement('div');
      wrapper.className = 'table-scroll-wrapper';
      table.parentNode!.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    });
  }, [html]);

  // Render LaTeX math using KaTeX. Loaded lazily to avoid bloating the initial bundle.
  // throwOnError: false so malformed equations fall back to raw text rather than crashing.
  // onReady is called unconditionally once this pass finishes (whether or not the content
  // contained math) so HighlightLayer always gets a "content settled" signal to re-apply
  // highlights against the final DOM (KaTeX splits text nodes, shifting serialized paths,
  // and — critically — HighlightLayer's very first application effect runs synchronously on
  // mount, before this async import resolves; without a guaranteed later signal it can
  // mistake still-unrendered `$...$` delimiters for a genuinely orphaned highlight).
  useEffect(() => {
    if (!contentRef.current) return;
    let mounted = true;
    const el = contentRef.current;
    void import('katex/contrib/auto-render').then(({ default: renderMathInElement }) => {
      if (mounted) {
        renderMathInElement(el, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\[', right: '\\]', display: true },
            { left: '\\(', right: '\\)', display: false },
          ],
          throwOnError: false,
        });
        onReady?.();
      }
    });
    return () => {
      mounted = false;
    };
  }, [html, onReady]);

  if (!html) {
    return (
      <div className="py-12 text-center text-[rgb(var(--reader-text))]/40">
        <p className="text-lg">No content available for this article.</p>
        <p className="mt-2 text-sm">Try viewing the original page instead.</p>
      </div>
    );
  }

  return (
    <div
      ref={setRef}
      className="article-content"
      data-testid="article-content"
      // Safe: content is sanitized via DOMPurify at ingestion time (article-parser)
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  );
});
