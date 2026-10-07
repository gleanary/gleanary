import { desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { articles, highlights, highlightTags, tags } from '@/db/schema';
import { getTagsForHighlights } from '@/lib/highlight-utils';
import { HighlightLibrary } from '@/components/library/highlight-library';
import { TopBar } from '@/components/layout/top-bar';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Highlight Library — Gleanary' };

export default function LibraryPage() {
  // Fetch initial highlights with article context
  const rows = db
    .select({
      highlight: highlights,
      articleTitle: articles.title,
      articleUrl: articles.url,
      articleSiteName: articles.siteName,
    })
    .from(highlights)
    .innerJoin(articles, eq(highlights.articleId, articles.id))
    .orderBy(desc(highlights.createdAt))
    .limit(50)
    .all();

  const totalResult = db
    .select({ count: sql<number>`count(*)` })
    .from(highlights)
    .get();

  // Batch-fetch tags for all highlights (avoids N+1)
  const highlightIds = rows.map((r) => r.highlight.id);
  const tagsMap = getTagsForHighlights(highlightIds);

  const initialHighlights = rows.map((r) => ({
    ...r.highlight,
    article: {
      title: r.articleTitle,
      url: r.articleUrl,
      siteName: r.articleSiteName,
    },
    tags: tagsMap.get(r.highlight.id) ?? [],
  }));

  // Fetch tags with counts
  const allTags = db
    .select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      highlightCount: sql<number>`count(${highlightTags.highlightId})`,
    })
    .from(tags)
    .leftJoin(highlightTags, eq(tags.id, highlightTags.tagId))
    .groupBy(tags.id)
    .all();

  return (
    <main className="px-4 pt-3 pb-6">
      <TopBar>
        <span className="text-foreground mr-1 px-2 text-sm font-semibold">Highlights</span>
      </TopBar>
      <div className="mx-auto max-w-4xl py-6">
        <HighlightLibrary
          initialHighlights={initialHighlights}
          initialTotal={totalResult?.count ?? 0}
          initialTags={allTags}
        />
      </div>
    </main>
  );
}
