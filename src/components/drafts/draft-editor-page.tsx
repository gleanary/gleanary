'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DraftEditor } from './draft-editor';
import { DraftSidePanel } from './draft-side-panel';
import { useDraftGeneration } from './use-draft-generation';
import { shouldAutoSave } from '@/lib/draft-autosave';
import { getDraft, patchDraft, deleteDraft } from '@/lib/draft-api';
import type { DraftModelId } from '@/lib/models';
import type { Draft, DraftStatus } from '@/types';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function mergedSaveState(a: SaveState, b: SaveState): SaveState {
  if (a === 'error' || b === 'error') return 'error';
  if (a === 'saving' || b === 'saving') return 'saving';
  if (a === 'saved' || b === 'saved') return 'saved';
  return 'idle';
}

function saveIndicatorText(state: SaveState): string | null {
  switch (state) {
    case 'saving':
      return 'Saving…';
    case 'saved':
      return 'Saved';
    case 'error':
      return 'Save failed';
    default:
      return null;
  }
}

function hasLocalEdits(draft: Draft): boolean {
  if (!draft.lastEditedAt) return false;
  if (!draft.generatedAt) return true;
  return draft.lastEditedAt > draft.generatedAt;
}

interface DraftEditorPageProps {
  draft: Draft;
  thesis: { id: number; title: string };
  templateName: string;
}

/**
 * Client wrapper for `/drafts/[id]`. Owns all editor state: content/title
 * buffers, per-field debounced auto-save, streaming generation via
 * `useDraftGeneration`, preview toggle, and the shared force-confirm dialog.
 */
export function DraftEditorPage({
  draft: initialDraft,
  thesis,
  templateName,
}: DraftEditorPageProps) {
  const router = useRouter();
  const [draft, setDraft] = useState(initialDraft);
  const [title, setTitle] = useState(initialDraft.title);
  const [content, setContent] = useState(initialDraft.content);
  const [lastSavedTitle, setLastSavedTitle] = useState(initialDraft.title);
  const [lastSavedContent, setLastSavedContent] = useState(initialDraft.content);
  const [titleSaveState, setTitleSaveState] = useState<SaveState>('idle');
  const [contentSaveState, setContentSaveState] = useState<SaveState>('idle');
  const [isPreview, setIsPreview] = useState(false);
  const [forceConfirmOpen, setForceConfirmOpen] = useState(false);
  const hasStartedRef = useRef(false);

  const gen = useDraftGeneration(draft.id);

  const handleDone = useCallback(
    async (finalText: string) => {
      setContent(finalText);
      setLastSavedContent(finalText);
      try {
        // Refresh metadata only — never the title. Generation doesn't change the
        // title server-side, and syncing it here would clobber an edit the user
        // makes while this request is in flight.
        const fresh = await getDraft(draft.id);
        setDraft(fresh);
      } catch {
        // Non-fatal: editor keeps streamed text; metadata refresh is best-effort.
      }
      gen.clearStreamedText();
    },
    [gen, draft.id],
  );

  useEffect(() => {
    if (draft.generatedAt !== null) return;
    if (hasStartedRef.current) return;
    const t = setTimeout(() => {
      hasStartedRef.current = true;
      setContent('');
      setLastSavedContent('');
      gen.start(false, { onDone: handleDone });
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (gen.error?.kind === 'needs-force') {
      setForceConfirmOpen(true);
    }
  }, [gen.error]);

  useEffect(() => {
    if (
      !shouldAutoSave({
        isStreaming: gen.isStreaming,
        current: content,
        lastSaved: lastSavedContent,
      })
    ) {
      return;
    }
    const t = setTimeout(async () => {
      setContentSaveState('saving');
      try {
        const fresh = await patchDraft(draft.id, { content });
        setDraft(fresh);
        setLastSavedContent(content);
        setContentSaveState('saved');
        setTimeout(() => setContentSaveState((s) => (s === 'saved' ? 'idle' : s)), 2000);
      } catch {
        setContentSaveState('error');
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [content, lastSavedContent, gen.isStreaming, draft.id]);

  useEffect(() => {
    if (
      !shouldAutoSave({ isStreaming: gen.isStreaming, current: title, lastSaved: lastSavedTitle })
    ) {
      return;
    }
    const t = setTimeout(async () => {
      setTitleSaveState('saving');
      try {
        const fresh = await patchDraft(draft.id, { title });
        setDraft(fresh);
        setLastSavedTitle(title);
        setTitleSaveState('saved');
        setTimeout(() => setTitleSaveState((s) => (s === 'saved' ? 'idle' : s)), 2000);
      } catch {
        setTitleSaveState('error');
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [title, lastSavedTitle, gen.isStreaming, draft.id]);

  const handleRegenerateRequested = useCallback(() => {
    if (hasLocalEdits(draft)) {
      setForceConfirmOpen(true);
    } else {
      gen.start(false, { onDone: handleDone });
    }
  }, [draft, gen, handleDone]);

  const handleForceConfirm = useCallback(() => {
    gen.clearError();
    setForceConfirmOpen(false);
    gen.start(true, { onDone: handleDone });
  }, [gen, handleDone]);

  const handleForceCancel = useCallback(() => {
    gen.clearError();
    setForceConfirmOpen(false);
  }, [gen]);

  const handleRetry = useCallback(() => {
    gen.clearError();
    gen.start(false, { onDone: handleDone });
  }, [gen, handleDone]);

  const handleModelChange = useCallback(
    async (model: DraftModelId) => {
      const fresh = await patchDraft(draft.id, { model });
      setDraft(fresh);
    },
    [draft.id],
  );

  const handleStatusChange = useCallback(
    async (status: DraftStatus) => {
      const fresh = await patchDraft(draft.id, { status });
      setDraft(fresh);
    },
    [draft.id],
  );

  const handleDelete = useCallback(async () => {
    await deleteDraft(draft.id);
    router.push(`/theses/${thesis.id}`);
    router.refresh();
  }, [draft.id, thesis.id, router]);

  const indicator = saveIndicatorText(mergedSaveState(titleSaveState, contentSaveState));
  const showOtherError = gen.error?.kind === 'other';

  return (
    <div className="px-4 pt-3 pb-6">
      <div className="mb-4 flex items-center gap-3">
        <Link
          href={`/theses/${thesis.id}`}
          className="text-muted-foreground hover:text-foreground flex min-w-0 items-center gap-1 text-sm"
          data-testid="back-to-thesis"
        >
          <ArrowLeft size={16} className="shrink-0" />
          <span className="truncate">{thesis.title}</span>
        </Link>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={gen.isStreaming}
          placeholder="Untitled draft"
          className="bg-background text-foreground flex-1 border-none text-lg font-semibold focus:outline-none disabled:opacity-70"
          data-testid="draft-title"
        />
        {indicator && (
          <span className="text-muted-foreground shrink-0 text-xs" data-testid="save-indicator">
            {indicator}
          </span>
        )}
      </div>

      {showOtherError && (
        <div className="bg-destructive/10 text-destructive mb-3 flex items-center justify-between rounded-md px-3 py-2 text-sm">
          <span>Generation failed: {gen.error?.message}</span>
          <Button size="sm" variant="outline" onClick={handleRetry} data-testid="retry-generate">
            Retry
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_360px]">
        <DraftEditor
          value={content}
          onChange={setContent}
          isStreaming={gen.isStreaming}
          streamedText={gen.streamedText}
          isPreview={isPreview}
        />
        <DraftSidePanel
          draft={draft}
          thesis={thesis}
          templateName={templateName}
          isStreaming={gen.isStreaming}
          isPreview={isPreview}
          onTogglePreview={() => setIsPreview((v) => !v)}
          onRegenerateRequested={handleRegenerateRequested}
          onModelChange={handleModelChange}
          onStatusChange={handleStatusChange}
          onDelete={handleDelete}
        />
      </div>

      <Dialog open={forceConfirmOpen} onOpenChange={(open) => !open && handleForceCancel()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Regenerate draft?</DialogTitle>
            <DialogDescription>
              You have edits since the last generation. Regenerating will overwrite the current
              content.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={handleForceCancel}>
              Cancel
            </Button>
            <Button onClick={handleForceConfirm} data-testid="regenerate-confirm">
              Regenerate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
