import { notFound } from 'next/navigation';
import { DraftEditorPage } from '@/components/drafts/draft-editor-page';
import { getDraftOrThrow, getThesisOrThrow } from '@/lib/db-helpers';
import { getTemplate } from '@/lib/content-templates';
import { NotFoundError } from '@/lib/errors';
import type { RouteContext } from '@/types';

/**
 * Server page for `/drafts/[id]`. Resolves the draft row, parent thesis, and
 * template display name, then hands off to the client editor wrapper. Invalid
 * or unknown IDs 404.
 */
export default async function DraftPage({ params }: RouteContext) {
  const { id: idParam } = await params;
  const id = parseInt(idParam, 10);
  if (Number.isNaN(id)) notFound();

  let draft;
  let thesis;
  try {
    draft = getDraftOrThrow(id);
    thesis = getThesisOrThrow(draft.thesisId);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const templateName = getTemplate(draft.templateId).name;

  return (
    <DraftEditorPage
      draft={draft}
      thesis={{ id: thesis.id, title: thesis.title }}
      templateName={templateName}
    />
  );
}
