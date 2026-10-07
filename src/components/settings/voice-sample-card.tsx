'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import type { VoiceSample } from '@/types';

interface Props {
  sample: VoiceSample;
  onUpdate: (id: number, updates: { title?: string; channelHint?: string | null }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

/**
 * Collapsible card displaying a writing sample.
 * Allows expanding to preview content and editing title/channelHint.
 */
export function VoiceSampleCard({ sample, onUpdate, onDelete }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [title, setTitle] = useState(sample.title);
  const [channelHint, setChannelHint] = useState(sample.channelHint ?? '');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await onUpdate(sample.id, {
        title,
        channelHint: channelHint.trim() || null,
      });
      setEditMode(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await onDelete(sample.id);
    } finally {
      setDeleting(false);
    }
  }

  const tags = sample.channelHint
    ? sample.channelHint
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  return (
    <div className="border-border bg-card space-y-2 rounded-md border p-4">
      <div className="flex items-start justify-between gap-2">
        {/* Accepted raw <button> (handover §5): bare disclosure toggle that wraps an
            editable Input in edit mode — Button's sizing/centering and button-in-button
            nesting would be inappropriate here. Classes are layout-only, not chrome styling. */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 text-left"
          aria-expanded={expanded}
          data-testid={`sample-card-${sample.id}`}
        >
          {editMode ? (
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="text-sm font-medium"
              onClick={(e) => e.stopPropagation()}
              data-testid={`sample-title-${sample.id}`}
            />
          ) : (
            <span className="text-sm font-medium">{sample.title}</span>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {editMode ? (
            <>
              <Button size="xs" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button
                variant="outline"
                size="xs"
                onClick={() => {
                  setTitle(sample.title);
                  setChannelHint(sample.channelHint ?? '');
                  setEditMode(false);
                }}
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="xs"
                onClick={() => setEditMode(true)}
                data-testid={`sample-edit-${sample.id}`}
              >
                Edit
              </Button>
              <Button
                variant="outline"
                size="xs"
                onClick={handleDelete}
                disabled={deleting}
                className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                data-testid={`sample-delete-${sample.id}`}
              >
                {deleting ? '…' : 'Delete'}
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
        <span>{sample.wordCount.toLocaleString()} words</span>
        {tags.map((tag) => (
          <span key={tag} className="bg-secondary rounded px-1.5 py-0.5 font-medium">
            {tag}
          </span>
        ))}
        <span>{new Date(sample.createdAt).toLocaleDateString()}</span>
      </div>

      {editMode && (
        <div className="space-y-1">
          <label className="text-muted-foreground text-xs font-medium">Channel hints</label>
          <Input
            value={channelHint}
            onChange={(e) => setChannelHint(e.target.value)}
            placeholder="blog, long-form, technical"
            className="text-sm"
            data-testid={`sample-hint-${sample.id}`}
          />
          <p className="text-muted-foreground text-xs">Comma-separated tags</p>
        </div>
      )}

      {expanded && (
        <pre className="bg-muted mt-2 max-h-48 overflow-y-auto rounded px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap">
          {sample.content}
        </pre>
      )}
    </div>
  );
}
