/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
import type { Dispatch, SetStateAction } from 'react';
import type { GenerationError } from '@/components/drafts/use-draft-generation';
import type { Draft } from '@/types';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

// The draft API is never reached in these scenarios (generatedAt is set, so no auto-start;
// no typing, so no auto-save), but stub it so an accidental call can't hit the network.
vi.mock('@/lib/draft-api', () => ({
  getDraft: vi.fn(),
  patchDraft: vi.fn(),
  deleteDraft: vi.fn(),
}));

// Controllable stand-in for the generation hook. It keeps `error` in real React state so
// `clearError()` re-renders the page exactly like the real hook does.
const start = vi.fn();
const clearError = vi.fn();
let setGenError: Dispatch<SetStateAction<GenerationError | null>> = () => {};

vi.mock('@/components/drafts/use-draft-generation', async () => {
  const React = await import('react');
  return {
    useDraftGeneration: () => {
      const [error, setError] = React.useState<GenerationError | null>(null);
      setGenError = setError;
      return {
        start,
        abort: vi.fn(),
        isStreaming: false,
        error,
        streamedText: '',
        clearStreamedText: vi.fn(),
        clearError: () => {
          clearError();
          setError(null);
        },
      };
    },
  };
});

import { DraftEditorPage } from '@/components/drafts/draft-editor-page';

function makeDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: 1,
    userId: 1,
    thesisId: 10,
    templateId: 'blog',
    title: 'My draft',
    content: 'Body',
    angle: null,
    contextSnapshot: null,
    model: 'claude-sonnet-4-6',
    status: 'draft',
    generatedAt: '2026-01-01 10:00:00',
    lastEditedAt: null,
    publishedAt: null,
    createdAt: '2026-01-01 09:00:00',
    updatedAt: '2026-01-01 10:00:00',
    ...overrides,
  } as Draft;
}

function renderPage(draft: Draft = makeDraft()) {
  return render(
    <DraftEditorPage draft={draft} thesis={{ id: 10, title: 'Thesis' }} templateName="Blog" />,
  );
}

const confirmButton = () => screen.queryByTestId('regenerate-confirm');

describe('DraftEditorPage force-confirm dialog', () => {
  beforeEach(() => {
    start.mockReset();
    clearError.mockReset();
  });

  afterEach(() => cleanup());

  it('is closed initially', () => {
    renderPage();
    expect(confirmButton()).toBeNull();
  });

  it('opens when the generation error kind is needs-force', async () => {
    renderPage();

    act(() => setGenError({ kind: 'needs-force', message: 'Draft has edits' }));

    await waitFor(() => expect(confirmButton()).not.toBeNull());
    expect(screen.getByText('Regenerate draft?')).toBeTruthy();
  });

  it('stays closed for a non-force generation error', () => {
    renderPage();

    act(() => setGenError({ kind: 'other', message: 'Boom' }));

    expect(confirmButton()).toBeNull();
    expect(screen.getByTestId('retry-generate')).toBeTruthy();
  });

  it('closes and clears the error on cancel', async () => {
    renderPage();
    act(() => setGenError({ kind: 'needs-force', message: 'Draft has edits' }));
    await waitFor(() => expect(confirmButton()).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(confirmButton()).toBeNull());
    expect(clearError).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('closes, clears the error and forces regeneration on confirm', async () => {
    renderPage();
    act(() => setGenError({ kind: 'needs-force', message: 'Draft has edits' }));
    await waitFor(() => expect(confirmButton()).not.toBeNull());

    fireEvent.click(screen.getByTestId('regenerate-confirm'));

    await waitFor(() => expect(confirmButton()).toBeNull());
    expect(clearError).toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0]).toBe(true);
  });

  it('opens via regenerate when the draft has local edits, without starting generation', async () => {
    renderPage(makeDraft({ lastEditedAt: '2026-01-02 10:00:00' }));

    fireEvent.click(screen.getByTestId('regenerate'));

    await waitFor(() => expect(confirmButton()).not.toBeNull());
    expect(start).not.toHaveBeenCalled();
  });

  it('regenerates directly (no dialog) when the draft has no local edits', () => {
    renderPage();

    fireEvent.click(screen.getByTestId('regenerate'));

    expect(confirmButton()).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0]).toBe(false);
  });
});
