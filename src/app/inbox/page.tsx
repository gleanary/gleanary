import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { articles } from '@/db/schema';
import { InboxSection } from '@/components/inbox/inbox-section';
import { articlesBySourceType, articlesExcludingSourceType } from '@/lib/db-helpers';
import { SOURCE_TYPES } from '@/types';
import type { SourceType } from '@/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Inbox | Gleanary' };

interface InboxPageProps {
  searchParams: Promise<{
    source?: string;
    sourceType?: string;
    excludeSourceType?: string;
  }>;
}

export default async function InboxPage({ searchParams }: InboxPageProps) {
  const { source, sourceType, excludeSourceType } = await searchParams;
  const sourceId = source ? Number(source) : undefined;
  const validSourceId = sourceId && Number.isFinite(sourceId) ? sourceId : undefined;
  const validSourceType = SOURCE_TYPES.includes(sourceType as SourceType)
    ? (sourceType as SourceType)
    : undefined;
  const validExcludeSourceType = SOURCE_TYPES.includes(excludeSourceType as SourceType)
    ? (excludeSourceType as SourceType)
    : undefined;

  const conditions = [eq(articles.status, 'inbox')];
  if (validSourceId) conditions.push(eq(articles.sourceId, validSourceId));
  if (validSourceType) conditions.push(articlesBySourceType(validSourceType));
  if (validExcludeSourceType) conditions.push(articlesExcludingSourceType(validExcludeSourceType));
  const where = and(...conditions);

  const rows = db
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
    .where(where)
    .orderBy(desc(articles.savedAt))
    .limit(50)
    .all()
    .map((row) => ({ ...row, isFavorite: row.isFavorite ?? false }));

  const totalResult = db
    .select({ count: sql<number>`count(*)` })
    .from(articles)
    .where(where)
    .get();

  return (
    <main className="px-4 pt-3 pb-6">
      <InboxSection
        key={`${validSourceId ?? ''}-${validSourceType ?? ''}-${validExcludeSourceType ?? ''}`}
        initialArticles={rows}
        initialTotal={totalResult?.count ?? 0}
        initialStatus="inbox"
        sourceId={validSourceId}
        sourceType={validSourceType}
        excludeSourceType={validExcludeSourceType}
      />
    </main>
  );
}
