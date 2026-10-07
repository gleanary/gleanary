'use client';

import { useCallback, useState, useSyncExternalStore } from 'react';
import { FileText, FileIcon } from 'lucide-react';
import dynamic from 'next/dynamic';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { createPersistedToggleStore } from '@/lib/local-storage-toggle';
import { ArticleContentWithCleanup } from '@/components/reader/article-content-with-cleanup';
import type { Article, Highlight } from '@/types';

// pdf.js calls new DOMMatrix() at module-evaluation time, which crashes Node.js SSR.
// ssr: false ensures the module is only evaluated in the browser.
const PdfViewer = dynamic(
  () => import('@/components/reader/pdf-viewer').then((m) => ({ default: m.PdfViewer })),
  { ssr: false },
);

interface PdfOriginalViewProps {
  article: Article;
  highlights: Highlight[];
  ttsEnabled: boolean;
  sourceType: string | null;
  aiCleanupAvailable?: boolean;
  highlightIdToScroll?: number;
}

// Per-article toggle: key `article_view_${articleId}`, values 'original' | absent.
// Keyed by articleId (not sourceId) because each PDF is a distinct document.
const { getSnapshot, getServerSnapshot, subscribe, setShowOriginal } =
  createPersistedToggleStore('article_view_');

/**
 * Wrapper for PDF articles that adds an "original PDF" toggle.
 * When toggled on, renders the PDF inline via PdfViewer (no highlight support).
 * The preference is persisted per article in localStorage as `article_view_${id}`.
 */
export function PdfOriginalView({
  article,
  highlights,
  ttsEnabled,
  sourceType,
  aiCleanupAvailable,
  highlightIdToScroll,
}: PdfOriginalViewProps) {
  const showOriginal = useSyncExternalStore(
    (cb) => subscribe(cb, article.id),
    () => getSnapshot(article.id),
    getServerSnapshot,
  );

  const [contentHtml, setContentHtml] = useState(article.contentHtml ?? '');
  const [aiCleanedAt, setAiCleanedAt] = useState(article.aiCleanedAt);

  const handleContentPersisted = useCallback((html: string, cleanedAt: string | null) => {
    setContentHtml(html);
    setAiCleanedAt(cleanedAt);
  }, []);

  const handleToggle = useCallback(() => {
    setShowOriginal(article.id, !getSnapshot(article.id));
  }, [article.id]);

  return (
    <div className="relative">
      <div className="mb-2 flex justify-end">
        <Button
          variant="ghost"
          size="xs"
          onClick={handleToggle}
          title={showOriginal ? 'Switch to extracted view' : 'View original PDF'}
          aria-pressed={showOriginal}
          className={cn(
            'gap-1.5 font-normal text-[rgb(var(--reader-text))]/50 hover:bg-transparent hover:text-[rgb(var(--reader-text))]/80 dark:hover:bg-transparent',
            showOriginal && 'bg-[rgb(var(--reader-text))]/8 text-[rgb(var(--reader-text))]/80',
          )}
        >
          {showOriginal ? <FileText className="size-3.5" /> : <FileIcon className="size-3.5" />}
          <span>{showOriginal ? 'Extracted' : 'Original PDF'}</span>
        </Button>
      </div>

      {showOriginal ? (
        <>
          <div className="mb-4 rounded border border-[rgb(var(--reader-text))]/10 bg-[rgb(var(--reader-text))]/5 px-3 py-2 text-xs text-[rgb(var(--reader-text))]/50">
            Viewing original PDF. Highlights are unavailable in this view.
          </div>
          {/* PdfViewer is intentionally outside HighlightLayer — PDF canvas has no HTML
              anchors for highlight injection. */}
          <PdfViewer articleId={article.id} pageCount={article.pageCount} />
        </>
      ) : (
        <ArticleContentWithCleanup
          articleId={article.id}
          contentHtml={contentHtml}
          sourceType={sourceType}
          aiCleanedAt={aiCleanedAt}
          contentOriginalHtml={article.contentOriginalHtml}
          initialHighlights={highlights}
          ttsEnabled={ttsEnabled}
          extractionTier={article.extractionTier}
          aiCleanupAvailable={aiCleanupAvailable}
          pageCount={article.pageCount}
          onContentPersisted={handleContentPersisted}
          highlightIdToScroll={highlightIdToScroll}
        />
      )}
    </div>
  );
}
