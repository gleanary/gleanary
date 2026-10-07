'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ThesisStatus } from '@/types';

export interface ThesisFormData {
  title: string;
  claim: string;
  counterarguments: string;
  implications: string;
  notes: string;
  status: ThesisStatus;
}

interface ThesisFormProps {
  initial?: Partial<ThesisFormData>;
  onSubmit: (data: ThesisFormData) => Promise<void>;
  onCancel?: () => void;
  submitLabel?: string;
}

const EMPTY: ThesisFormData = {
  title: '',
  claim: '',
  counterarguments: '',
  implications: '',
  notes: '',
  status: 'nascent',
};

/**
 * Form for creating or editing a thesis.
 * @param props - Initial values, submit handler, cancel handler, and submit label
 */
export function ThesisForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel = 'Create thesis',
}: ThesisFormProps) {
  const [form, setForm] = useState<ThesisFormData>({ ...EMPTY, ...initial });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set =
    (key: keyof ThesisFormData) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.title.trim().length < 3) {
      setError('Title must be at least 3 characters');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit(form);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save thesis');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="text-foreground mb-1 block text-sm font-medium">
          Title <span className="text-destructive">*</span>
        </label>
        <Input
          value={form.title}
          onChange={set('title')}
          placeholder="e.g. AI changes work, not workers"
          required
          minLength={3}
          maxLength={500}
          data-testid="thesis-title-input"
        />
        <p className="text-muted-foreground mt-1 text-xs">A short, memorable name for the thesis</p>
      </div>

      <div>
        <label className="text-foreground mb-1 block text-sm font-medium">Claim</label>
        <textarea
          value={form.claim}
          onChange={set('claim')}
          placeholder="What specifically do you believe? (1-3 sentences)"
          rows={3}
          maxLength={5000}
          className="border-input bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
          data-testid="thesis-claim-input"
        />
      </div>

      <div>
        <label className="text-foreground mb-1 block text-sm font-medium">Counterarguments</label>
        <textarea
          value={form.counterarguments}
          onChange={set('counterarguments')}
          placeholder="What would a smart skeptic say?"
          rows={2}
          maxLength={5000}
          className="border-input bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
      </div>

      <div>
        <label className="text-foreground mb-1 block text-sm font-medium">Implications</label>
        <textarea
          value={form.implications}
          onChange={set('implications')}
          placeholder="So what? Why does this matter?"
          rows={2}
          maxLength={5000}
          className="border-input bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
      </div>

      <div>
        <label className="text-foreground mb-1 block text-sm font-medium">Notes</label>
        <textarea
          value={form.notes}
          onChange={set('notes')}
          placeholder="Working notes..."
          rows={3}
          maxLength={10000}
          className="border-input bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
