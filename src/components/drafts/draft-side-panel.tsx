'use client';

import { useState } from 'react';
import Link from 'next/link';
import { marked } from 'marked';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { sanitizeArticleHtml } from '@/lib/sanitize';
import { formatRelativeTime } from '@/lib/text-utils';
import { DRAFT_MODELS, type DraftModelId } from '@/lib/models';
import type { Draft, DraftStatus } from '@/types';

interface DraftSidePanelProps {
  draft: Draft;
  thesis: { id: number; title: string };
  templateName: string;
  isStreaming: boolean;
  isPreview: boolean;
  onTogglePreview: () => void;
  /** Called when the user clicks Regenerate. The parent decides whether to
   *  show the force-confirm dialog (local edits or server race) or call start
   *  directly. */
  onRegenerateRequested: () => void;
  onModelChange: (model: DraftModelId) => Promise<void>;
  onStatusChange: (status: DraftStatus) => Promise<void>;
  onDelete: () => Promise<void>;
}

/**
 * Right-hand panel with draft metadata and per-draft actions: preview toggle,
 * regenerate (with force-confirm dialog when local edits are ahead of the last
 * generation), copy markdown, copy HTML (sanitized), status toggle, delete.
 * All mutating actions are disabled while `isStreaming` is true; copy actions
 * remain available (they capture the pre-stream persisted content).
 */
export function DraftSidePanel({
  draft,
  thesis,
  templateName,
  isStreaming,
  isPreview,
  onTogglePreview,
  onRegenerateRequested,
  onModelChange,
  onStatusChange,
  onDelete,
}: DraftSidePanelProps) {
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [copiedMd, setCopiedMd] = useState(false);
  const [copiedHtml, setCopiedHtml] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const isPublished = draft.status === 'published';

  async function handleCopyMarkdown() {
    await navigator.clipboard.writeText(draft.content);
    setCopiedMd(true);
    setTimeout(() => setCopiedMd(false), 1500);
  }

  async function handleCopyHtml() {
    const html = await marked.parse(draft.content);
    const safe = sanitizeArticleHtml(html);
    await navigator.clipboard.writeText(safe);
    setCopiedHtml(true);
    setTimeout(() => setCopiedHtml(false), 1500);
  }

  async function handleModelSelect(model: string) {
    setModelSaving(true);
    try {
      await onModelChange(model as DraftModelId);
    } finally {
      setModelSaving(false);
    }
  }

  async function handleStatusToggle() {
    setStatusSaving(true);
    try {
      await onStatusChange(isPublished ? 'draft' : 'published');
    } finally {
      setStatusSaving(false);
    }
  }

  async function handleDeleteConfirm() {
    setDeleting(true);
    try {
      await onDelete();
    } catch {
      setDeleting(false);
    }
  }

  const actionsDisabled = isStreaming || statusSaving;
  const regenerateDisabled = actionsDisabled || modelSaving;

  return (
    <aside
      data-testid="draft-side-panel"
      className="bg-card border-border flex h-fit flex-col gap-4 rounded-md border p-4"
    >
      <div className="space-y-2">
        <Link
          href={`/theses/${thesis.id}`}
          className="text-foreground hover:text-primary block truncate text-sm font-medium"
        >
          {thesis.title}
        </Link>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{templateName}</Badge>
          <Badge variant={isPublished ? 'default' : 'outline'}>
            {isPublished ? 'Published' : 'Draft'}
          </Badge>
        </div>
      </div>

      <div className="text-muted-foreground space-y-1 text-xs">
        <div>Generated {draft.generatedAt ? formatRelativeTime(draft.generatedAt) : 'never'}</div>
        <div>
          Last edited {draft.lastEditedAt ? formatRelativeTime(draft.lastEditedAt) : 'never'}
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-muted-foreground text-xs font-medium">Model</label>
        <Select
          value={draft.model ?? undefined}
          onValueChange={handleModelSelect}
          disabled={regenerateDisabled}
        >
          <SelectTrigger className="h-8 w-full text-xs" data-testid="draft-model-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DRAFT_MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id} className="text-xs">
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onTogglePreview}
          disabled={isStreaming}
          data-testid="toggle-preview"
        >
          {isPreview ? 'Edit' : 'Preview'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onRegenerateRequested}
          disabled={regenerateDisabled}
          data-testid="regenerate"
        >
          Regenerate
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleCopyMarkdown}
          data-testid="copy-markdown"
        >
          {copiedMd ? 'Copied!' : 'Copy markdown'}
        </Button>
        <Button variant="outline" size="sm" onClick={handleCopyHtml} data-testid="copy-html">
          {copiedHtml ? 'Copied!' : 'Copy as HTML'}
        </Button>
        <Button
          variant={isPublished ? 'outline' : 'default'}
          size="sm"
          onClick={handleStatusToggle}
          disabled={actionsDisabled}
          data-testid="toggle-status"
        >
          {statusSaving ? 'Saving…' : isPublished ? 'Revert to draft' : 'Publish'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDeleteConfirmOpen(true)}
          disabled={actionsDisabled}
          data-testid="delete-draft"
          className="text-destructive hover:text-destructive"
        >
          Delete
        </Button>
      </div>

      <Dialog
        open={deleteConfirmOpen}
        onOpenChange={(open) => !deleting && setDeleteConfirmOpen(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete draft</DialogTitle>
            <DialogDescription>
              This will permanently delete this draft. The parent thesis is unaffected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteConfirm}
              disabled={deleting}
              data-testid="delete-confirm"
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
