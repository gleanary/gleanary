'use client';

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { FileText, Newspaper } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ArticleContent } from '@/components/reader/article-content';
import { TTSArticleContent } from '@/components/reader/tts-article-content';
import { HighlightLayer } from '@/components/reader/highlight-layer';
import { AiCleanupBanner } from '@/components/reader/ai-cleanup-banner';
import { sanitizeArticleHtml } from '@/lib/sanitize';
import { createPersistedToggleStore } from '@/lib/local-storage-toggle';
import type { Highlight } from '@/types';

interface NewsletterOriginalViewProps {
  sourceId: number;
  contentHtml: string;
  contentOriginalHtml: string;
  articleId: number;
  initialHighlights: Highlight[];
  ttsEnabled: boolean;
  aiCleanedAt: string | null;
  highlightIdToScroll?: number;
}

// Per-source toggle: key `newsletter-view-${sourceId}`, values 'original' | absent.
const { getSnapshot, getServerSnapshot, subscribe, setShowOriginal } =
  createPersistedToggleStore('newsletter-view-');

/**
 * Wrapper for newsletter articles that adds an "original view" toggle.
 * When toggled on, renders the raw email HTML (sanitized via DOMPurify) without
 * highlight support. The preference is persisted per source in localStorage.
 */
export function NewsletterOriginalView({
  sourceId,
  contentHtml,
  contentOriginalHtml,
  articleId,
  initialHighlights,
  ttsEnabled,
  aiCleanedAt,
  highlightIdToScroll,
}: NewsletterOriginalViewProps) {
  const showOriginal = useSyncExternalStore(
    (cb) => subscribe(cb, sourceId),
    () => getSnapshot(sourceId),
    getServerSnapshot,
  );

  const handleToggle = useCallback(() => {
    setShowOriginal(sourceId, !getSnapshot(sourceId));
  }, [sourceId]);

  const sanitizedOriginalHtml = useMemo(
    () => sanitizeArticleHtml(contentOriginalHtml),
    [contentOriginalHtml],
  );

  const [currentHtml, setCurrentHtml] = useState(contentHtml);
  const [currentAiCleanedAt, setCurrentAiCleanedAt] = useState(aiCleanedAt);
  // Bumped after KaTeX finishes so HighlightLayer re-applies highlights against the post-KaTeX DOM.
  const [contentVersion, setContentVersion] = useState(0);

  const handleContentUpdate = useCallback((newHtml: string, newAiCleanedAt: string | null) => {
    setCurrentHtml(newHtml);
    setCurrentAiCleanedAt(newAiCleanedAt);
  }, []);

  const handleContentReady = useCallback(() => {
    setContentVersion((v) => v + 1);
  }, []);

  const ContentComponent = ttsEnabled ? TTSArticleContent : ArticleContent;

  return (
    <div className="relative">
      <div className="mb-2 flex justify-end">
        <Button
          variant="ghost"
          size="xs"
          onClick={handleToggle}
          title={showOriginal ? 'Switch to extracted view' : 'View original email'}
          aria-pressed={showOriginal}
          className={cn(
            'gap-1.5 font-normal text-[rgb(var(--reader-text))]/50 hover:bg-transparent hover:text-[rgb(var(--reader-text))]/80 dark:hover:bg-transparent',
            showOriginal && 'bg-[rgb(var(--reader-text))]/8 text-[rgb(var(--reader-text))]/80',
          )}
        >
          {showOriginal ? <Newspaper className="size-3.5" /> : <FileText className="size-3.5" />}
          <span>{showOriginal ? 'Extracted' : 'Original'}</span>
        </Button>
      </div>

      {showOriginal ? (
        <div>
          <div className="mb-4 rounded border border-[rgb(var(--reader-text))]/10 bg-[rgb(var(--reader-text))]/5 px-3 py-2 text-xs text-[rgb(var(--reader-text))]/50">
            Viewing original email. Highlights are unavailable in this view.
          </div>
          <ArticleContent html={sanitizedOriginalHtml} />
        </div>
      ) : (
        <>
          <AiCleanupBanner
            articleId={articleId}
            sourceType="newsletter"
            aiCleanedAt={currentAiCleanedAt}
            hasOriginalHtml={true}
            onContentUpdate={handleContentUpdate}
          />
          <HighlightLayer
            articleId={articleId}
            initialHighlights={initialHighlights}
            contentVersion={contentVersion}
            highlightIdToScroll={highlightIdToScroll}
          >
            <ContentComponent html={currentHtml} onReady={handleContentReady} />
          </HighlightLayer>
        </>
      )}
    </div>
  );
}
