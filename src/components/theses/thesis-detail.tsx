'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Edit2, Trash2, BookOpen, MoreHorizontal, MessageSquare } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { TopBar, TopBarButton } from '@/components/layout/top-bar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { StatusTrack } from './status-track';
import { EvidenceSection } from './evidence-section';
import { ThesisForm } from './thesis-form';
import { DraftsSection } from '@/components/drafts/drafts-section';
import { formatDate } from '@/lib/text-utils';
import type { DraftListItem } from '@/lib/draft-api';
import type { ThesisDetailResponse, ThesisStatus } from '@/types';

interface ThesisDetailProps {
  data: ThesisDetailResponse;
  drafts: DraftListItem[];
  hasAiKey: boolean;
}

/**
 * Full thesis detail view with editing, evidence management, and research entries.
 * @param props - Full thesis detail data and AI availability flag
 */
export function ThesisDetail({ data, drafts, hasAiKey }: ThesisDetailProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [thesis, setThesis] = useState(data.thesis);
  const [highlights, setHighlights] = useState(data.highlights);
  const [research] = useState(data.research);
  const [deleting, setDeleting] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const updateStatus = async (status: ThesisStatus) => {
    const res = await fetch(`/api/theses/${thesis.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      const body = (await res.json()) as { thesis: typeof thesis };
      setThesis(body.thesis);
    }
  };

  const handleEdit = async (formData: {
    title: string;
    claim: string;
    counterarguments: string;
    implications: string;
    notes: string;
    status: ThesisStatus;
  }) => {
    const res = await fetch(`/api/theses/${thesis.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData),
    });
    if (!res.ok) throw new Error('Failed to update thesis');
    const body = (await res.json()) as { thesis: typeof thesis };
    setThesis(body.thesis);
    setEditing(false);
  };

  const handleDelete = async () => {
    setDeleting(true);
    const res = await fetch(`/api/theses/${thesis.id}`, { method: 'DELETE' });
    if (res.ok) {
      router.push('/theses');
    } else {
      setDeleting(false);
    }
  };

  const handleUnlink = async (highlightId: number) => {
    const res = await fetch(`/api/theses/${thesis.id}/highlights/${highlightId}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      setHighlights((prev) => prev.filter((h) => h.id !== highlightId));
    }
  };

  return (
    <>
      <TopBar>
        <TopBarButton onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Back</span>
        </TopBarButton>

        <div className="flex-1" />

        <TopBarButton asChild>
          <Link href={`/chat/new?scope=thesis:${thesis.id}`}>
            <MessageSquare className="h-4 w-4" />
            <span className="hidden sm:inline">Chat</span>
          </Link>
        </TopBarButton>

        {!editing && (
          <TopBarButton onClick={() => setEditing(true)}>
            <Edit2 className="h-4 w-4" />
            <span className="hidden sm:inline">Edit</span>
          </TopBarButton>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <TopBarButton>
              <MoreHorizontal className="h-4 w-4" />
            </TopBarButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onSelect={() => setIsDeleteDialogOpen(true)}>
              <Trash2 className="mr-2 h-4 w-4" />
              Delete thesis
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Dialog
          open={isDeleteDialogOpen}
          onOpenChange={(open) => !deleting && setIsDeleteDialogOpen(open)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete thesis</DialogTitle>
              <DialogDescription>
                This will permanently delete this thesis. Linked highlights and articles will be
                preserved.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setIsDeleteDialogOpen(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </TopBar>

      <div className="mx-auto max-w-3xl space-y-8 py-6">
        {/* Header */}
        <div>
          {!editing && (
            <h1 className="text-foreground text-2xl leading-tight font-semibold">{thesis.title}</h1>
          )}
          <div className="mt-2">
            <StatusTrack status={thesis.status} onChange={updateStatus} />
          </div>
        </div>

        {/* Edit form */}
        {editing && (
          <div className="bg-card border-border rounded-lg border p-4">
            <ThesisForm
              initial={{
                title: thesis.title,
                claim: thesis.claim ?? '',
                counterarguments: thesis.counterarguments ?? '',
                implications: thesis.implications ?? '',
                notes: thesis.notes ?? '',
                status: thesis.status,
              }}
              onSubmit={handleEdit}
              onCancel={() => setEditing(false)}
              submitLabel="Save changes"
            />
          </div>
        )}

        {/* Thesis content (when not editing) */}
        {!editing && (
          <div className="space-y-4">
            {thesis.claim && (
              <div>
                <h2 className="text-muted-foreground mb-1 text-xs font-semibold tracking-wide uppercase">
                  Claim
                </h2>
                <p className="text-foreground leading-relaxed">{thesis.claim}</p>
              </div>
            )}

            {thesis.counterarguments && (
              <div>
                <h2 className="text-muted-foreground mb-1 text-xs font-semibold tracking-wide uppercase">
                  Counterarguments
                </h2>
                <p className="text-foreground leading-relaxed">{thesis.counterarguments}</p>
              </div>
            )}

            {thesis.implications && (
              <div>
                <h2 className="text-muted-foreground mb-1 text-xs font-semibold tracking-wide uppercase">
                  Implications
                </h2>
                <p className="text-foreground leading-relaxed">{thesis.implications}</p>
              </div>
            )}

            {thesis.notes && (
              <div>
                <h2 className="text-muted-foreground mb-1 text-xs font-semibold tracking-wide uppercase">
                  Notes
                </h2>
                <p className="text-foreground leading-relaxed whitespace-pre-wrap">
                  {thesis.notes}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Evidence (linked highlights) */}
        <div>
          <EvidenceSection
            thesisId={thesis.id}
            highlights={highlights}
            onUnlink={handleUnlink}
            hasAiKey={hasAiKey}
          />
        </div>

        {/* Research entries */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-foreground font-medium">Research ({research.length})</h3>
          </div>

          {research.length === 0 ? (
            <p className="text-muted-foreground text-sm">No research entries yet.</p>
          ) : (
            <div className="space-y-2">
              {research.map((r) => (
                <div key={r.id} className="bg-muted/30 border-border rounded-md border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-foreground text-sm font-medium">{r.title}</p>
                      <div className="text-muted-foreground mt-1 flex items-center gap-2 text-xs">
                        <BookOpen size={12} />
                        <span>~{r.wordCount} words</span>
                        {r.source && <span>· {r.source.replace('_', ' ')}</span>}
                        <span>· {formatDate(r.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Drafts */}
        <DraftsSection
          thesis={thesis}
          highlights={highlights}
          research={research}
          initialDrafts={drafts}
        />
      </div>
    </>
  );
}
