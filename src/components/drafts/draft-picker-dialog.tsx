'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { buildSubmitPayload, initPickerState, reducer } from '@/lib/draft-picker-state';
import { createDraft, getVoiceProfile, type DraftListItem } from '@/lib/draft-api';
import { TemplatePickerStep } from './template-picker-step';
import { ContextSelectionStep } from './context-selection-step';
import type {
  Draft,
  Thesis,
  ThesisLinkedHighlight,
  ThesisResearchSummary,
  VoiceProfile,
} from '@/types';

interface DraftPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  thesis: Thesis;
  highlights: ThesisLinkedHighlight[];
  research: ThesisResearchSummary[];
  onCreated: (draft: DraftListItem) => void;
}

function draftToListItem(draft: Draft, thesisTitle: string): DraftListItem {
  return {
    id: draft.id,
    thesisId: draft.thesisId,
    thesisTitle,
    templateId: draft.templateId,
    title: draft.title,
    angle: draft.angle,
    status: draft.status,
    generatedAt: draft.generatedAt,
    lastEditedAt: draft.lastEditedAt,
    publishedAt: draft.publishedAt,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

export function DraftPickerDialog({
  open,
  onOpenChange,
  thesis,
  highlights,
  research,
  onCreated,
}: DraftPickerDialogProps) {
  const router = useRouter();
  const [state, dispatch] = useReducer(reducer, { highlights, research }, (seed) =>
    initPickerState(seed.highlights, seed.research),
  );
  const [voiceProfile, setVoiceProfile] = useState<VoiceProfile | null>(null);
  const [voiceProfileLoaded, setVoiceProfileLoaded] = useState(false);

  // Reset only on the false→true transition so sibling mutations that change
  // `highlights`/`research` identity mid-flow (e.g. unlinking a highlight)
  // don't wipe the user's in-progress selections.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      dispatch({ type: 'reset', highlights, research });
    }
    wasOpenRef.current = open;
  }, [open, highlights, research]);

  useEffect(() => {
    if (!open || voiceProfileLoaded) return;
    let cancelled = false;
    getVoiceProfile()
      .then((profile) => {
        if (!cancelled) {
          setVoiceProfile(profile);
          setVoiceProfileLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setVoiceProfile(null);
          setVoiceProfileLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, voiceProfileLoaded]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (state.submitting && !nextOpen) return;
      onOpenChange(nextOpen);
    },
    [onOpenChange, state.submitting],
  );

  const handleSubmit = useCallback(async () => {
    if (state.templateId === null || state.submitting) return;
    dispatch({ type: 'submit_start' });
    try {
      const payload = buildSubmitPayload(state, thesis.id);
      const draft = await createDraft(payload);
      onCreated(draftToListItem(draft, thesis.title));
      dispatch({ type: 'submit_success' });
      onOpenChange(false);
      router.push(`/drafts/${draft.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create draft';
      dispatch({ type: 'submit_error', message });
    }
  }, [state, thesis.id, thesis.title, onCreated, onOpenChange, router]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{state.step === 1 ? 'Choose a template' : 'Pick the context'}</DialogTitle>
          <DialogDescription>
            {state.step === 1
              ? 'Each template produces a different shape of content from the same thesis.'
              : 'Uncheck anything you want the draft to ignore.'}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto">
          {state.step === 1 ? (
            <TemplatePickerStep
              onSelect={(templateId) => dispatch({ type: 'select_template', templateId })}
            />
          ) : (
            <ContextSelectionStep
              state={state}
              dispatch={dispatch}
              thesis={thesis}
              highlights={highlights}
              research={research}
              voiceProfile={voiceProfile}
              voiceProfileLoaded={voiceProfileLoaded}
            />
          )}
        </div>

        {state.step === 2 && (
          <div className="flex justify-between gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => dispatch({ type: 'back' })}
              disabled={state.submitting}
              data-testid="picker-back"
            >
              Back
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={state.submitting || state.templateId === null}
              data-testid="picker-submit"
            >
              {state.submitting ? 'Generating…' : 'Generate'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
