'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DraftCard } from './draft-card';
import { DraftPickerDialog } from './draft-picker-dialog';
import type { DraftListItem } from '@/lib/draft-api';
import type { Thesis, ThesisLinkedHighlight, ThesisResearchSummary } from '@/types';

interface DraftsSectionProps {
  thesis: Thesis;
  highlights: ThesisLinkedHighlight[];
  research: ThesisResearchSummary[];
  initialDrafts: DraftListItem[];
}

export function DraftsSection({ thesis, highlights, research, initialDrafts }: DraftsSectionProps) {
  const [drafts, setDrafts] = useState(initialDrafts);
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="space-y-3" data-testid="drafts-section">
      <div className="flex items-center justify-between">
        <h3 className="text-foreground font-medium">Drafts ({drafts.length})</h3>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDialogOpen(true)}
          data-testid="new-draft-button"
        >
          <Plus className="mr-1 h-4 w-4" />
          New draft
        </Button>
      </div>

      {drafts.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Ready to publish this thesis? Start a draft.
        </p>
      ) : (
        <div className="space-y-2">
          {drafts.map((draft) => (
            <DraftCard key={draft.id} draft={draft} />
          ))}
        </div>
      )}

      <DraftPickerDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        thesis={thesis}
        highlights={highlights}
        research={research}
        onCreated={(draft) => setDrafts((prev) => [draft, ...prev])}
      />
    </div>
  );
}
