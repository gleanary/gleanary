import { desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import { sources, articles } from '@/db/schema';
import { NewsletterList } from '@/components/newsletters/newsletter-list';
import { TopBar } from '@/components/layout/top-bar';
import { deriveNewsletterStatus } from '@/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Newsletters — Gleanary' };

export default function NewslettersPage() {
  const rows = db
    .select({
      id: sources.id,
      name: sources.name,
      senderAddress: sources.senderAddress,
      isBlocked: sources.isBlocked,
      lastReceivedAt: sources.lastReceivedAt,
      articleCount: sql<number>`COUNT(${articles.id})`,
    })
    .from(sources)
    .leftJoin(articles, eq(sources.id, articles.sourceId))
    .where(eq(sources.type, 'newsletter'))
    .groupBy(sources.id)
    .all();

  const newsletters = rows.map((row) => ({
    ...row,
    status: deriveNewsletterStatus(row.isBlocked),
  }));

  const pendingCount = newsletters.filter((n) => n.status === 'pending').length;

  // Fetch recent article subjects for pending sources
  const pendingSourceIds = newsletters.filter((n) => n.status === 'pending').map((n) => n.id);
  const recentSubjects: Record<number, string[]> = {};
  if (pendingSourceIds.length > 0) {
    const pendingArticles = db
      .select({ sourceId: articles.sourceId, title: articles.title })
      .from(articles)
      .where(inArray(articles.sourceId, pendingSourceIds))
      .orderBy(desc(articles.savedAt))
      .all();
    for (const a of pendingArticles) {
      if (a.sourceId != null) {
        (recentSubjects[a.sourceId] ??= []).push(a.title);
      }
    }
  }

  return (
    <main className="px-4 pt-3 pb-6">
      <TopBar>
        <span className="text-foreground mr-1 px-2 text-sm font-semibold">Newsletters</span>
      </TopBar>
      <div className="mx-auto max-w-4xl py-6">
        <NewsletterList
          newsletters={newsletters}
          pendingCount={pendingCount}
          recentSubjects={recentSubjects}
        />
      </div>
    </main>
  );
}
