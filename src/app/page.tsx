import Link from 'next/link';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { articles } from '@/db/schema';
import { ArticleCard } from '@/components/inbox/article-card';
import { ReadingCard } from '@/components/home/reading-card';
import { TopBar } from '@/components/layout/top-bar';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Gleanary' };

export default async function HomePage() {
  const readingArticles = db
    .select({
      id: articles.id,
      url: articles.url,
      title: articles.title,
      siteName: articles.siteName,
      excerpt: articles.excerpt,
      wordCount: articles.wordCount,
      pageCount: articles.pageCount,
      originalFilePath: articles.originalFilePath,
      extractionTier: articles.extractionTier,
      readingProgress: articles.readingProgress,
      status: articles.status,
      savedAt: articles.savedAt,
      isFavorite: articles.isFavorite,
    })
    .from(articles)
    .where(eq(articles.status, 'reading'))
    .orderBy(desc(articles.updatedAt))
    .all()
    .map((row) => ({ ...row, isFavorite: row.isFavorite ?? false }));

  const inboxArticles = db
    .select({
      id: articles.id,
      url: articles.url,
      title: articles.title,
      siteName: articles.siteName,
      excerpt: articles.excerpt,
      wordCount: articles.wordCount,
      pageCount: articles.pageCount,
      originalFilePath: articles.originalFilePath,
      extractionTier: articles.extractionTier,
      readingProgress: articles.readingProgress,
      status: articles.status,
      savedAt: articles.savedAt,
      isFavorite: articles.isFavorite,
    })
    .from(articles)
    .where(eq(articles.status, 'inbox'))
    .orderBy(desc(articles.savedAt))
    .limit(10)
    .all()
    .map((row) => ({ ...row, isFavorite: row.isFavorite ?? false }));

  const inboxTotal =
    db
      .select({ count: sql<number>`count(*)` })
      .from(articles)
      .where(eq(articles.status, 'inbox'))
      .get()?.count ?? 0;

  return (
    <main className="px-4 pt-3 pb-6">
      <TopBar>
        <span className="px-2 text-sm font-medium">Home</span>
      </TopBar>
      <div className="mt-6 space-y-8">
        {readingArticles.length > 0 && (
          <section>
            <h2 className="mb-3 text-sm font-semibold">Reading</h2>
            <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2">
              {readingArticles.map((article) => (
                <ReadingCard key={article.id} article={article} />
              ))}
            </div>
          </section>
        )}

        <section>
          <h2 className="mb-3 text-sm font-semibold">Inbox ({inboxTotal})</h2>
          {inboxArticles.length === 0 ? (
            <p className="text-muted-foreground text-sm">Your inbox is empty.</p>
          ) : (
            <>
              <div className="space-y-2">
                {inboxArticles.map((article) => (
                  <ArticleCard key={article.id} article={article} />
                ))}
              </div>
              {inboxTotal > 10 && (
                <Link
                  href="/inbox"
                  className="text-muted-foreground hover:text-foreground mt-3 block text-sm"
                >
                  See all →
                </Link>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
