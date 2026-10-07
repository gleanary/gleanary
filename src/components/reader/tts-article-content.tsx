'use client';

import { ArticleContent } from '@/components/reader/article-content';
import { useTTSContentRef } from '@/components/reader/tts-provider';

/**
 * Wrapper that connects ArticleContent to the TTS word highlighter.
 * Passes the content DOM ref to the TTS provider for word highlighting.
 */
export function TTSArticleContent({ html, onReady }: { html: string; onReady?: () => void }) {
  const setTTSRef = useTTSContentRef();
  return <ArticleContent html={html} onContentRef={setTTSRef} onReady={onReady} />;
}
