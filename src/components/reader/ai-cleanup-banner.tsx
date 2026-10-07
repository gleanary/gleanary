'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, Undo2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { detectFormattingIssues, QUALITY_THRESHOLD } from '@/lib/content-quality';

interface AiCleanupBannerProps {
  articleId: number;
  sourceType: string | null;
  aiCleanedAt: string | null;
  hasOriginalHtml: boolean;
  onContentUpdate: (newHtml: string, newAiCleanedAt: string | null) => void;
  extractionTier?: string | null;
  aiCleanupAvailable?: boolean;
  pageCount?: number | null;
}

/**
 * Shows a banner when formatting issues are detected, offering AI cleanup.
 * After cleanup, shows a "Revert to original" option instead.
 */
export function AiCleanupBanner({
  articleId,
  sourceType,
  aiCleanedAt,
  hasOriginalHtml,
  onContentUpdate,
  extractionTier,
  aiCleanupAvailable = true,
  pageCount,
}: AiCleanupBannerProps) {
  const [showBanner, setShowBanner] = useState(() => aiCleanedAt === null);
  const [isCleaned, setIsCleaned] = useState(aiCleanedAt !== null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partialOutcome, setPartialOutcome] = useState<{
    chunksTotal: number;
    chunksSkipped: number;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const callApi = useCallback(
    async (
      endpoint: string,
      onSuccess: (data: {
        contentHtml: string;
        contentMarkdown: string;
        chunksTotal?: number;
        chunksSkipped?: number;
      }) => void,
    ) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setIsLoading(true);
      setError(null);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ articleId }),
          signal: controller.signal,
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || `Failed (${res.status})`);
        }
        onSuccess(data);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Request failed');
      } finally {
        setIsLoading(false);
      }
    },
    [articleId],
  );

  function handleClean() {
    callApi('/api/ai/clean', (data) => {
      onContentUpdate(data.contentHtml, new Date().toISOString());
      setIsCleaned(true);
      setShowBanner(false);
      if (data.chunksSkipped && data.chunksTotal) {
        setPartialOutcome({ chunksTotal: data.chunksTotal, chunksSkipped: data.chunksSkipped });
      }
    });
  }

  function handleRevert() {
    callApi('/api/ai/revert', (data) => {
      onContentUpdate(data.contentHtml, null);
      setIsCleaned(false);
      setPartialOutcome(null);
      const score = detectFormattingIssues(data.contentHtml, sourceType);
      setShowBanner(score >= QUALITY_THRESHOLD);
    });
  }

  if (!showBanner && !isCleaned) return null;
  if (isCleaned && !hasOriginalHtml) return null;

  const isFailedPdf = extractionTier === 'failed';

  function unavailableMessage(): string {
    if (pageCount != null && pageCount > 1000) {
      return 'AI cleanup unavailable for PDFs over 1,000 pages. Split externally.';
    }
    return 'AI cleanup unavailable — Mistral API key not configured (Settings → Integrations).';
  }

  return (
    <div className="mb-4 rounded-md border border-[rgb(var(--reader-text))]/10 bg-[rgb(var(--reader-text))]/[0.03] px-4 py-2.5 text-sm text-[rgb(var(--reader-text))]/60">
      {error && <p className="text-destructive mb-1.5">{error}</p>}

      {isCleaned ? (
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
          <span>
            {partialOutcome
              ? `Reformatted with AI (${partialOutcome.chunksTotal - partialOutcome.chunksSkipped}/${partialOutcome.chunksTotal} sections; ${partialOutcome.chunksSkipped} kept original)`
              : 'Reformatted with AI'}
          </span>
          <span className="mx-1">·</span>
          <Button
            variant="link"
            onClick={handleRevert}
            disabled={isLoading}
            className="h-auto gap-1 p-0 text-[rgb(var(--reader-text))]/60 underline decoration-dotted underline-offset-2 hover:text-[rgb(var(--reader-text))]/80"
          >
            {isLoading ? <Loader2 className="size-3 animate-spin" /> : <Undo2 className="size-3" />}
            Revert to original
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
          <span>
            {isFailedPdf
              ? 'Text extraction failed for this PDF'
              : 'This article may have formatting issues'}
          </span>
          {aiCleanupAvailable ? (
            <>
              <span className="mx-1">·</span>
              <Button
                variant="link"
                onClick={handleClean}
                disabled={isLoading}
                className="h-auto gap-1 p-0 text-[rgb(var(--reader-text))]/60 underline decoration-dotted underline-offset-2 hover:text-[rgb(var(--reader-text))]/80"
              >
                {isLoading && <Loader2 className="size-3 animate-spin" />}
                {isFailedPdf ? 'Retry extraction' : 'Reformat with AI'}
              </Button>
            </>
          ) : (
            <span className="mx-1 italic">— {unavailableMessage()}</span>
          )}
        </div>
      )}
    </div>
  );
}
