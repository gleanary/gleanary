import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { theses } from '@/db/schema';
import { ThesisDetail } from '@/components/theses/thesis-detail';
import { getConfig } from '@/lib/settings';
import { getDraftsForThesis, getThesisDetail } from '@/lib/db-helpers';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params;
  const thesisId = parseInt(id, 10);
  if (isNaN(thesisId)) return { title: 'Thesis — Gleanary' };
  const thesis = db
    .select({ title: theses.title })
    .from(theses)
    .where(eq(theses.id, thesisId))
    .get();
  return { title: thesis ? `${thesis.title} — Gleanary` : 'Thesis — Gleanary' };
}

export default async function ThesisPage({ params }: PageProps) {
  const { id } = await params;
  const thesisId = parseInt(id, 10);
  if (isNaN(thesisId)) notFound();

  const data = getThesisDetail(thesisId);
  if (!data) notFound();

  const drafts = getDraftsForThesis(thesisId);
  const hasAiKey = !!getConfig('anthropic_api_key');

  return (
    <main className="px-4 pt-3 pb-6">
      <ThesisDetail data={data} drafts={drafts} hasAiKey={hasAiKey} />
    </main>
  );
}
