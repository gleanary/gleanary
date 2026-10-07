'use client';

import { useCallback, useState } from 'react';
import { AiCleanupBanner } from './ai-cleanup-banner';
import { HighlightLayer } from './highlight-layer';
import { ArticleContent } from './article-content';
import { TTSArticleContent } from './tts-article-content';
import type { Highlight } from '@/types';

interface ArticleContentWithCleanupProps {
  articleId: number;
  contentHtml: string;
  sourceType: string | null;
  aiCleanedAt: string | null;
  contentOriginalHtml: string | null;
  initialHighlights: Highlight[];
  ttsEnabled: boolean;
  extractionTier?: string | null;
  aiCleanupAvailable?: boolean;
  pageCount?: number | null;
  onContentPersisted?: (html: string, aiCleanedAt: string | null) => void;
  highlightIdToScroll?: number;
}

/**
 * Client wrapper that manages dynamic content swapping for AI cleanup/revert.
 * Renders the AiCleanupBanner above the article content, and swaps the displayed
 * HTML when cleanup or revert succeeds.
 */
export function ArticleContentWithCleanup({
  articleId,
  contentHtml,
  sourceType,
  aiCleanedAt,
  contentOriginalHtml,
  initialHighlights,
  ttsEnabled,
  extractionTier,
  aiCleanupAvailable,
  pageCount,
  onContentPersisted,
  highlightIdToScroll,
}: ArticleContentWithCleanupProps) {
  const [currentHtml, setCurrentHtml] = useState(contentHtml);
  const [currentAiCleanedAt, setCurrentAiCleanedAt] = useState(aiCleanedAt);
  // Bumped after KaTeX finishes rendering so HighlightLayer re-applies highlights
  // against the post-KaTeX DOM (KaTeX splits text nodes, shifting stored paths).
  const [contentVersion, setContentVersion] = useState(0);

  const handleContentUpdate = useCallback(
    (newHtml: string, newAiCleanedAt: string | null) => {
      setCurrentHtml(newHtml);
      setCurrentAiCleanedAt(newAiCleanedAt);
      onContentPersisted?.(newHtml, newAiCleanedAt);
    },
    [onContentPersisted],
  );

  const handleContentReady = useCallback(() => {
    setContentVersion((v) => v + 1);
  }, []);

  const ContentComponent = ttsEnabled ? TTSArticleContent : ArticleContent;

  return (
    <>
      <AiCleanupBanner
        articleId={articleId}
        sourceType={sourceType}
        aiCleanedAt={currentAiCleanedAt}
        hasOriginalHtml={contentOriginalHtml !== null}
        onContentUpdate={handleContentUpdate}
        extractionTier={extractionTier ?? null}
        aiCleanupAvailable={aiCleanupAvailable}
        pageCount={pageCount}
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
  );
}
