'use client';

import { useState, useEffect } from 'react';
import {
  MoreHorizontal,
  Lightbulb,
  BookPlus,
  PenLine,
  Bookmark,
  BookmarkCheck,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { ChatMessageDisplay, ChatCitation } from '@/types';

interface Props {
  message: ChatMessageDisplay;
  sessionId: number;
  onFiled?: () => void;
}

interface ThesisOption {
  id: number;
  title: string;
  status: string;
}

/**
 * Full-width selectable list row used in the "add to thesis" / "annotate highlight" pickers.
 * @param props.selected - Whether this row is the current selection (filled accent)
 * @param props.onClick - Selection handler
 * @param props.children - Row content
 */
function OptionRow({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className={cn(
        'hover:bg-muted/50 dark:hover:bg-muted/50 h-auto w-full justify-start rounded-none px-3 py-2 text-sm font-normal whitespace-normal',
        selected && 'bg-accent hover:bg-accent dark:hover:bg-accent',
      )}
    >
      {children}
    </Button>
  );
}

/**
 * Dropdown menu with filing actions for assistant chat messages.
 * Supports: bookmark, save as thesis, add to thesis, annotate highlight.
 * @param props.message - The assistant message to act on
 * @param props.sessionId - Chat session ID
 * @param props.onFiled - Callback after a successful filing action
 */
export function MessageActions({ message, sessionId, onFiled }: Props) {
  const [bookmarked, setBookmarked] = useState(!!message.bookmarkedAt);
  const [showThesisDialog, setShowThesisDialog] = useState(false);
  const [showResearchDialog, setShowResearchDialog] = useState(false);
  const [showAnnotateDialog, setShowAnnotateDialog] = useState(false);

  const highlightCitations = message.citations.filter((c) => c.type === 'highlight');

  const [error, setError] = useState<string | null>(null);

  async function fileAction(action: Record<string, unknown>) {
    setError(null);
    try {
      const res = await fetch(`/api/chat/${sessionId}/file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: message.id, action }),
      });
      if (res.ok) {
        onFiled?.();
        return true;
      }
      const body = await res.json().catch(() => ({}));
      setError((body as { error?: string }).error ?? 'Filing failed');
      return false;
    } catch {
      setError('Network error');
      return false;
    }
  }

  async function handleBookmark() {
    const ok = await fileAction({ type: 'bookmark' });
    if (ok) setBookmarked(true);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Message actions"
            className="text-muted-foreground hover:text-foreground"
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={handleBookmark}>
            {bookmarked ? (
              <BookmarkCheck className="mr-2 h-4 w-4" />
            ) : (
              <Bookmark className="mr-2 h-4 w-4" />
            )}
            {bookmarked ? 'Bookmarked' : 'Bookmark'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setShowThesisDialog(true)}>
            <Lightbulb className="mr-2 h-4 w-4" />
            Save as thesis
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setShowResearchDialog(true)}>
            <BookPlus className="mr-2 h-4 w-4" />
            Add to thesis...
          </DropdownMenuItem>
          {highlightCitations.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setShowAnnotateDialog(true)}>
                <PenLine className="mr-2 h-4 w-4" />
                Annotate highlight
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {error && <p className="text-destructive mt-1 text-xs">{error}</p>}

      {showThesisDialog && (
        <CreateThesisDialog
          message={message}
          onFile={fileAction}
          onClose={() => setShowThesisDialog(false)}
        />
      )}

      {showResearchDialog && (
        <AddResearchDialog
          message={message}
          onFile={fileAction}
          onClose={() => setShowResearchDialog(false)}
        />
      )}

      {showAnnotateDialog && (
        <AnnotateHighlightDialog
          message={message}
          citations={highlightCitations}
          onFile={fileAction}
          onClose={() => setShowAnnotateDialog(false)}
        />
      )}
    </>
  );
}

function CreateThesisDialog({
  message,
  onFile,
  onClose,
}: {
  message: ChatMessageDisplay;
  onFile: (action: Record<string, unknown>) => Promise<boolean>;
  onClose: () => void;
}) {
  const firstSentence =
    message.content
      .split(/[.!?\n]/)[0]
      ?.trim()
      .slice(0, 200) ?? '';
  const [title, setTitle] = useState(firstSentence);
  const [claim, setClaim] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (!title.trim()) return;
    setSubmitting(true);
    const ok = await onFile({
      type: 'create_thesis',
      title: title.trim(),
      claim: claim.trim() || undefined,
    });
    if (ok) onClose();
    else setSubmitting(false);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save as thesis</DialogTitle>
          <DialogDescription>Create a new thesis from this insight.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <label className="text-sm font-medium">Title</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Thesis title..."
              autoFocus
            />
          </div>
          <div>
            <label className="text-sm font-medium">Claim (optional)</label>
            <textarea
              value={claim}
              onChange={(e) => setClaim(e.target.value)}
              placeholder="The core claim or argument..."
              rows={3}
              className="border-border bg-background w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !title.trim()}>
            {submitting ? 'Creating...' : 'Create thesis'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddResearchDialog({
  message,
  onFile,
  onClose,
}: {
  message: ChatMessageDisplay;
  onFile: (action: Record<string, unknown>) => Promise<boolean>;
  onClose: () => void;
}) {
  const [theses, setTheses] = useState<ThesisOption[]>([]);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/theses?limit=100', { signal: controller.signal })
      .then((r) => r.json())
      .then((body) => setTheses(body.theses ?? []))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const filtered = search
    ? theses.filter((t) => t.title.toLowerCase().includes(search.toLowerCase()))
    : theses;

  const firstLine = message.content.split('\n')[0]?.trim().slice(0, 200) ?? 'Chat insight';

  async function handleSubmit() {
    if (!selectedId) return;
    setSubmitting(true);
    const ok = await onFile({
      type: 'add_research',
      thesisId: selectedId,
      title: firstLine,
      content: message.content,
    });
    if (ok) onClose();
    else setSubmitting(false);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to thesis</DialogTitle>
          <DialogDescription>
            Save this message as a research entry on an existing thesis.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search theses..."
            autoFocus
          />
          <div className="max-h-48 overflow-y-auto rounded border">
            {filtered.length === 0 ? (
              <p className="text-muted-foreground p-3 text-center text-sm">
                {theses.length === 0 ? 'No theses found' : 'No matching theses'}
              </p>
            ) : (
              filtered.map((t) => (
                <OptionRow
                  key={t.id}
                  selected={selectedId === t.id}
                  onClick={() => setSelectedId(t.id)}
                >
                  <span className="font-medium">{t.title}</span>
                  <span className="text-muted-foreground ml-2 text-xs">{t.status}</span>
                </OptionRow>
              ))
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !selectedId}>
            {submitting ? 'Adding...' : 'Add research'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Extracts the paragraph from the message that references a specific highlight citation.
 * @param content - Full message content
 * @param highlightId - The highlight ID to find
 * @returns The relevant paragraph, or empty string if not found
 */
function extractRelevantParagraph(content: string, highlightId: number): string {
  const marker = `[highlight:${highlightId}]`;
  const paragraphs = content.split(/\n\n+/);
  const match = paragraphs.find((p) => p.includes(marker));
  if (match) {
    // Strip citation markers for cleaner note text
    return match.replace(/\[(article|highlight|thesis):\d+\]/g, '').trim();
  }
  return '';
}

function AnnotateHighlightDialog({
  message,
  citations,
  onFile,
  onClose,
}: {
  message: ChatMessageDisplay;
  citations: ChatCitation[];
  onFile: (action: Record<string, unknown>) => Promise<boolean>;
  onClose: () => void;
}) {
  const initialHighlightId = citations.length === 1 ? citations[0]!.id : null;
  const [selectedHighlightId, setSelectedHighlightId] = useState<number | null>(initialHighlightId);
  const [note, setNote] = useState(() =>
    initialHighlightId ? extractRelevantParagraph(message.content, initialHighlightId) : '',
  );
  const [submitting, setSubmitting] = useState(false);

  function selectHighlight(highlightId: number) {
    setSelectedHighlightId(highlightId);
    setNote(extractRelevantParagraph(message.content, highlightId));
  }

  async function handleSubmit() {
    if (!selectedHighlightId || !note.trim()) return;
    setSubmitting(true);
    const ok = await onFile({
      type: 'annotate_highlight',
      highlightId: selectedHighlightId,
      note: note.trim(),
    });
    if (ok) onClose();
    else setSubmitting(false);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Annotate highlight</DialogTitle>
          <DialogDescription>
            Add the AI&apos;s analysis as a note on a cited highlight.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {citations.length > 1 && (
            <div>
              <label className="mb-1 block text-sm font-medium">Select highlight</label>
              <div className="max-h-32 overflow-y-auto rounded border">
                {citations.map((c) => (
                  <OptionRow
                    key={c.id}
                    selected={selectedHighlightId === c.id}
                    onClick={() => selectHighlight(c.id)}
                  >
                    {c.title}
                  </OptionRow>
                ))}
              </div>
            </div>
          )}
          {citations.length === 1 && (
            <p className="text-muted-foreground text-sm">Highlight: {citations[0]!.title}</p>
          )}
          <div>
            <label className="mb-1 block text-sm font-medium">Note</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add analysis or context..."
              rows={4}
              className="border-border bg-background w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || !selectedHighlightId || !note.trim()}
          >
            {submitting ? 'Saving...' : 'Save note'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
