'use client';

import { useState, useRef } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface Props {
  onAdd: (data: { title: string; content: string; channelHint?: string }) => Promise<void>;
  onCancel: () => void;
}

/**
 * Form for adding a new writing sample via paste or file upload.
 * File upload accepts .txt and .md files; content is read client-side.
 */
export function VoiceSampleForm({ onAdd, onCancel }: Props) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [channelHint, setChannelHint] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setContent(text);
      if (!title) {
        setTitle(file.name.replace(/\.[^.]+$/, ''));
      }
    } catch {
      setError('Could not read file');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (content.length < 100) {
      setError('Sample must be at least 100 characters');
      return;
    }
    if (content.length > 50000) {
      setError('Sample exceeds 50,000 character limit');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onAdd({
        title: title.trim(),
        content,
        channelHint: channelHint.trim() || undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save sample');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border-border space-y-4 rounded-md border p-4">
      <h3 className="text-sm font-semibold">Add writing sample</h3>

      <div className="space-y-1">
        <label className="text-muted-foreground text-xs font-medium">Title</label>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Blog: AI pair programming"
          required
          data-testid="sample-form-title"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label className="text-muted-foreground text-xs font-medium">Content</label>
          <label className="border-border hover:bg-accent cursor-pointer rounded border px-2 py-0.5 text-xs font-medium">
            Upload .txt / .md
            <input
              type="file"
              accept=".txt,.md,text/plain,text/markdown"
              onChange={handleFileChange}
              ref={fileRef}
              className="hidden"
              data-testid="sample-form-file"
            />
          </label>
        </div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={10}
          placeholder="Paste your writing sample here (minimum 100 characters)…"
          required
          className="border-input bg-background focus:ring-ring w-full rounded-md border px-3 py-2 text-sm focus:ring-1 focus:outline-none"
          data-testid="sample-form-content"
        />
        <p className="text-muted-foreground text-xs">
          {content.length.toLocaleString()} / 50,000 characters
        </p>
      </div>

      <div className="space-y-1">
        <label className="text-muted-foreground text-xs font-medium">
          Channel hints (optional)
        </label>
        <Input
          value={channelHint}
          onChange={(e) => setChannelHint(e.target.value)}
          placeholder="blog, long-form, technical"
          data-testid="sample-form-hint"
        />
        <p className="text-muted-foreground text-xs">
          Comma-separated tags used for sample selection at generation time
        </p>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="flex gap-2">
        <Button type="submit" disabled={saving || !title.trim()}>
          {saving ? 'Adding…' : 'Add sample'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
