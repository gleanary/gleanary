import Link from 'next/link';
import { Plus, Lightbulb } from 'lucide-react';
import { desc, sql, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { theses, thesisHighlights, thesisResearch } from '@/db/schema';
import { Button } from '@/components/ui/button';
import { ThesisCard } from '@/components/theses/thesis-card';
import { TopBar, TopBarButton } from '@/components/layout/top-bar';
import { getConfig } from '@/lib/settings';
import type { ThesisListItem, ThesisStatus } from '@/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Theses — Gleanary' };

function getThesesWithCounts(): { theses: ThesisListItem[]; total: number } {
  const rows = db.select().from(theses).orderBy(desc(theses.updatedAt)).all();
  if (rows.length === 0) return { theses: [], total: 0 };

  const ids = rows.map((t) => t.id);

  const hlCounts = db
    .select({ thesisId: thesisHighlights.thesisId, count: sql<number>`count(*)` })
    .from(thesisHighlights)
    .where(inArray(thesisHighlights.thesisId, ids))
    .groupBy(thesisHighlights.thesisId)
    .all();

  const resCounts = db
    .select({ thesisId: thesisResearch.thesisId, count: sql<number>`count(*)` })
    .from(thesisResearch)
    .where(inArray(thesisResearch.thesisId, ids))
    .groupBy(thesisResearch.thesisId)
    .all();

  const hlMap = new Map(hlCounts.map((r) => [r.thesisId, r.count]));
  const resMap = new Map(resCounts.map((r) => [r.thesisId, r.count]));

  const thesisList: ThesisListItem[] = rows.map((t) => ({
    id: t.id,
    title: t.title,
    claim: t.claim,
    status: t.status as ThesisStatus,
    highlightCount: hlMap.get(t.id) ?? 0,
    researchCount: resMap.get(t.id) ?? 0,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }));

  return { theses: thesisList, total: thesisList.length };
}

const STATUS_GROUPS: Array<{ label: string; statuses: ThesisStatus[] }> = [
  { label: 'In Progress', statuses: ['nascent', 'developing', 'researched'] },
  { label: 'Ready', statuses: ['ready'] },
  { label: 'Used', statuses: ['used'] },
];

export default function ThesesPage() {
  const { theses: allTheses, total } = getThesesWithCounts();
  const hasAiKey = !!getConfig('anthropic_api_key');

  return (
    <main className="px-4 pt-3 pb-6">
      <TopBar>
        <span className="text-foreground mr-1 flex-1 px-2 text-sm font-semibold">Theses</span>
        {hasAiKey && (
          <TopBarButton asChild>
            <Link href="/theses/suggest">
              <Lightbulb size={14} />
              Suggest
            </Link>
          </TopBarButton>
        )}
        <TopBarButton asChild>
          <Link href="/theses/new">
            <Plus size={14} />
            New thesis
          </Link>
        </TopBarButton>
      </TopBar>
      <div className="mx-auto max-w-4xl py-6">
        {total === 0 ? (
          <div className="text-muted-foreground py-16 text-center">
            <p className="text-lg">No theses yet</p>
            <p className="mt-2 text-sm">
              Create your first thesis to start organizing your reading highlights into arguments.
            </p>
            <Button className="mt-4" asChild>
              <Link href="/theses/new">
                <Plus size={14} className="mr-1" />
                Create thesis
              </Link>
            </Button>
          </div>
        ) : (
          <div className="space-y-8">
            {STATUS_GROUPS.map(({ label, statuses }) => {
              const group = allTheses.filter((t) => statuses.includes(t.status));
              if (group.length === 0) return null;
              return (
                <div key={label}>
                  <h2 className="text-muted-foreground mb-3 text-xs font-semibold tracking-wide uppercase">
                    {label}
                  </h2>
                  <div className="space-y-2">
                    {group.map((t) => (
                      <ThesisCard key={t.id} thesis={t} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
