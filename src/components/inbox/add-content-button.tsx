'use client';

import { useState, useRef, useCallback, type FormEvent } from 'react';
import { Plus, FileUp, Loader2, Link as LinkIcon } from 'lucide-react';
import type { ArticleListItem } from '@/types';
import { parseArticleByUrl } from '@/lib/article-api';
import { useHandlePdfUpload } from '@/lib/use-pdf-upload';
import { isPdfFile } from '@/lib/upload-validation';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface AddContentButtonProps {
  onSaved?: (article: ArticleListItem) => void;
  triggerClassName?: string;
}

/**
 * "+" button with a dropdown to add content by URL or PDF upload.
 * URL option opens a save-by-URL modal; PDF option opens an upload modal.
 * @param onSaved - Called with the new article on successful URL save
 */
export function AddContentButton({ onSaved, triggerClassName }: AddContentButtonProps) {
  const [modal, setModal] = useState<'url' | 'pdf' | null>(null);
  const close = useCallback(() => setModal(null), []);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Add content"
            className={
              triggerClassName ??
              'text-muted-foreground hover:text-foreground hover:bg-transparent dark:hover:bg-transparent'
            }
          >
            <Plus className="size-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4}>
          <DropdownMenuItem onSelect={() => setModal('url')}>
            <LinkIcon size={14} className="mr-2" />
            URL
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setModal('pdf')}>
            <FileUp size={14} className="mr-2" />
            PDF
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {modal === 'url' && <UrlModal onClose={close} onSaved={onSaved} />}
      {modal === 'pdf' && <PdfModal onClose={close} />}
    </>
  );
}

interface ModalShellProps {
  title: string;
  isPending: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

function ModalShell({ title, isPending, onClose, children }: ModalShellProps) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isPending) onClose();
      }}
    >
      <DialogContent
        className="max-w-md"
        onInteractOutside={(e) => {
          if (isPending) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (isPending) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm font-medium">{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

interface UrlModalProps {
  onClose: () => void;
  onSaved?: (article: ArticleListItem) => void;
}

function UrlModal({ onClose, onSaved }: UrlModalProps) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const url = inputRef.current?.value.trim() ?? '';
    if (!url) return;

    setIsPending(true);
    setError(null);

    try {
      const result = await parseArticleByUrl(url);

      if (result.duplicate) {
        setError(
          result.existingId
            ? `Already saved. Open article #${result.existingId} from your inbox.`
            : 'Already saved.',
        );
        return;
      }
      if (!result.ok) {
        setError(result.error ?? 'Could not save article.');
        return;
      }

      onSaved?.(result.article as unknown as ArticleListItem);
      onClose();
    } finally {
      setIsPending(false);
    }
  }

  return (
    <ModalShell title="Save article" isPending={isPending} onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <input
          ref={inputRef}
          type="url"
          placeholder="https://..."
          required
          autoFocus
          disabled={isPending}
          className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-1 focus-visible:outline-none disabled:opacity-50"
        />
        {error && <p className="text-destructive text-xs">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={isPending}
            className="text-muted-foreground hover:text-foreground hover:bg-transparent dark:hover:bg-transparent"
          >
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={isPending}>
            {isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}

interface PdfModalProps {
  onClose: () => void;
}

function PdfModal({ onClose }: PdfModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const { handleFile, isPending, error } = useHandlePdfUpload(onClose);

  return (
    <ModalShell title="Upload PDF" isPending={isPending} onClose={onClose}>
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload PDF — drop file or press Enter to browse"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          e.nativeEvent.stopPropagation();
          setIsDragOver(false);
          const f = e.dataTransfer.files[0];
          if (f && isPdfFile(f)) handleFile(f);
        }}
        onClick={() => inputRef.current?.click()}
        className={cn(
          'text-muted-foreground focus-visible:ring-ring flex cursor-pointer flex-col items-center justify-center gap-3 rounded-md border border-dashed py-10 transition-colors focus-visible:ring-2 focus-visible:outline-none',
          isDragOver && 'border-primary text-primary bg-primary/5',
          isPending && 'pointer-events-none opacity-60',
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
        {isPending ? (
          <>
            <Loader2 className="h-6 w-6 animate-spin" />
            <span className="text-sm">Uploading…</span>
          </>
        ) : (
          <>
            <FileUp className="h-6 w-6" />
            <span className="text-sm">Drop a PDF or click to browse</span>
            <span className="text-xs opacity-60">Max 50 MB</span>
          </>
        )}
      </div>
      {error && <p className="text-destructive mt-3 text-xs">{error}</p>}
    </ModalShell>
  );
}
