'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { renderMarkdown } from '@/lib/markdown-renderer';
import type { VoiceProfile } from '@/types';

interface Props {
  profile: VoiceProfile;
  sampleCount: number;
  hasAnthropicKey: boolean;
  onSave: (text: string) => Promise<void>;
  onExtract: (force: boolean) => Promise<void>;
}

/**
 * Renders the voice profile as markdown or switches to an edit textarea.
 * Handles the "Regenerate from samples" flow including manual-edits confirmation.
 */
export function VoiceProfileEditor({
  profile,
  sampleCount,
  hasAnthropicKey,
  onSave,
  onExtract,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(profile.profile);
  const [saving, setSaving] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleExtract(force = false) {
    if (profile.manualEditsAt && !force && !confirmOverwrite) {
      setConfirmOverwrite(true);
      return;
    }
    setConfirmOverwrite(false);
    setExtracting(true);
    try {
      await onExtract(force || !!profile.manualEditsAt);
    } finally {
      setExtracting(false);
    }
  }

  const metaLine = (() => {
    const parts: string[] = [];
    if (profile.extractedAt) {
      parts.push(
        `Generated from ${profile.sampleCount} sample${profile.sampleCount === 1 ? '' : 's'} on ${new Date(profile.extractedAt).toLocaleDateString()}`,
      );
    }
    if (profile.manualEditsAt) {
      parts.push(`Last edited ${new Date(profile.manualEditsAt).toLocaleDateString()}`);
    }
    return parts.join(' · ');
  })();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Voice Profile</h3>
        <div className="flex gap-2">
          {hasAnthropicKey && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleExtract(false)}
              disabled={extracting || sampleCount < 3}
              title={sampleCount < 3 ? 'Add at least 3 writing samples to regenerate' : undefined}
              className="disabled:cursor-not-allowed"
            >
              {extracting ? 'Generating…' : 'Regenerate from samples'}
            </Button>
          )}
          {!editing && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDraft(profile.profile);
                setEditing(true);
              }}
            >
              Edit
            </Button>
          )}
        </div>
      </div>

      {confirmOverwrite && (
        <div className="border-tint-amber-fg/40 bg-tint-amber rounded-md border px-4 py-3 text-sm">
          <p className="text-tint-amber-fg mb-2 font-medium">
            This will overwrite your manual edits. Continue?
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => handleExtract(true)}
              className="bg-warning text-warning-foreground hover:bg-warning/90"
            >
              Overwrite
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConfirmOverwrite(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {editing ? (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={20}
            className="border-input bg-background focus:ring-ring w-full rounded-md border px-3 py-2 font-mono text-sm focus:ring-1 focus:outline-none"
            data-testid="voice-profile-textarea"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave} disabled={saving || draft.length < 100}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div
          className="prose prose-sm dark:prose-invert max-w-none"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(profile.profile) }}
          data-testid="voice-profile-rendered"
        />
      )}

      {metaLine && <p className="text-muted-foreground text-xs">{metaLine}</p>}
    </div>
  );
}
