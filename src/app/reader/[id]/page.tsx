import { cache } from 'react';
import { notFound } from 'next/navigation';
import { eq, desc } from 'drizzle-orm';
import { db } from '@/db';
import { articles, highlights, sources } from '@/db/schema';
import { ArticleReader } from '@/components/reader/article-reader';
import { ReaderToolbar } from '@/components/reader/reader-toolbar';
import { ArticleHeader } from '@/components/reader/article-header';
import { ArticleContentWithCleanup } from '@/components/reader/article-content-with-cleanup';
import { ReadingProgressBar } from '@/components/reader/reading-progress-bar';
import { ArchiveFooterButton } from '@/components/reader/archive-footer-button';
import { ArticleStatusProvider } from '@/components/reader/article-status-context';
import { ArticleProvider } from '@/components/reader/article-context';
import { TTSProvider } from '@/components/reader/tts-provider';
import { NewsletterOriginalView } from '@/components/reader/newsletter-original-view';
import { PdfOriginalView } from '@/components/reader/pdf-original-view';
import { config } from '@/config';
import { getConfig } from '@/lib/settings';
import type { ArticleStatus } from '@/types';

interface ReaderPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ highlight?: string }>;
}

/** Cached per-request to avoid duplicate DB queries between generateMetadata and ReaderPage. */
const getArticle = cache((id: number) => {
  return db.select().from(articles).where(eq(articles.id, id)).get() ?? null;
});

/** Fetches the source for an article by sourceId. */
const getSource = cache((sourceId: number) => {
  return db.select().from(sources).where(eq(sources.id, sourceId)).get() ?? null;
});

/** Fetches highlights for an article, ordered by creation date. */
const getHighlights = cache((articleId: number) => {
  return db
    .select()
    .from(highlights)
    .where(eq(highlights.articleId, articleId))
    .orderBy(desc(highlights.createdAt))
    .all();
});

export async function generateMetadata({ params }: ReaderPageProps) {
  const { id } = await params;
  const articleId = parseInt(id, 10);
  if (isNaN(articleId)) return { title: 'Not Found' };

  const article = getArticle(articleId);
  return { title: article ? article.title : 'Not Found' };
}

export default async function ReaderPage({ params, searchParams }: ReaderPageProps) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const articleId = parseInt(id, 10);
  const highlightIdToScroll = sp.highlight ? parseInt(sp.highlight, 10) || undefined : undefined;
  if (isNaN(articleId)) notFound();

  const article = getArticle(articleId);
  if (!article) notFound();

  const articleHighlights = getHighlights(article.id);
  const source = article.sourceId != null ? getSource(article.sourceId) : null;
  const isPdf = !!article.originalFilePath;
  const isNewsletter = !isPdf && source?.type === 'newsletter' && !!article.contentOriginalHtml;
  const showOpenOriginal = !article.url.startsWith('newsletter://');

  const ttsEnabled = !!getConfig('inworld_api_key') || config.tts.mock;

  let aiCleanupAvailable = true;
  if (article.originalFilePath) {
    aiCleanupAvailable =
      (article.pageCount == null || article.pageCount <= 1000) && !!getConfig('mistral_api_key');
  }

  return (
    <ArticleStatusProvider articleId={article.id} initialStatus={article.status as ArticleStatus}>
      <ArticleProvider initialArticle={article}>
        <TTSProvider
          ttsEnabled={ttsEnabled}
          articleId={article.id}
          initialTTSPosition={
            article.ttsParagraph != null && article.ttsTimeOffset != null
              ? { paragraph: article.ttsParagraph, timeOffset: article.ttsTimeOffset }
              : null
          }
        >
          <main className="px-4 pt-3 pb-6">
            <ReadingProgressBar />
            <ReaderToolbar ttsEnabled={ttsEnabled} showOpenOriginal={showOpenOriginal} />
            <div className="bg-[var(--reader-bg)] text-[rgb(var(--reader-text))]">
              <ArticleReader>
                <ArticleHeader article={article} />
                {/* PDF articles: URL-imported PDFs have originalFilePath set; they
                    never also have contentOriginalHtml, so newsletter branch is safe below. */}
                {isPdf ? (
                  <PdfOriginalView
                    article={article}
                    highlights={articleHighlights}
                    ttsEnabled={ttsEnabled}
                    sourceType={source?.type ?? null}
                    aiCleanupAvailable={aiCleanupAvailable}
                    highlightIdToScroll={highlightIdToScroll}
                  />
                ) : isNewsletter ? (
                  <NewsletterOriginalView
                    sourceId={article.sourceId!}
                    contentHtml={article.contentHtml ?? ''}
                    contentOriginalHtml={article.contentOriginalHtml!}
                    articleId={article.id}
                    initialHighlights={articleHighlights}
                    ttsEnabled={ttsEnabled}
                    aiCleanedAt={article.aiCleanedAt}
                    highlightIdToScroll={highlightIdToScroll}
                  />
                ) : (
                  <ArticleContentWithCleanup
                    articleId={article.id}
                    contentHtml={article.contentHtml ?? ''}
                    sourceType={source?.type ?? null}
                    aiCleanedAt={article.aiCleanedAt}
                    contentOriginalHtml={article.contentOriginalHtml}
                    initialHighlights={articleHighlights}
                    ttsEnabled={ttsEnabled}
                    extractionTier={article.extractionTier}
                    aiCleanupAvailable={aiCleanupAvailable}
                    highlightIdToScroll={highlightIdToScroll}
                  />
                )}
                <ArchiveFooterButton />
              </ArticleReader>
            </div>
          </main>
        </TTSProvider>
      </ArticleProvider>
    </ArticleStatusProvider>
  );
}
