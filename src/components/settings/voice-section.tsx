'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { VoiceProfileEditor } from '@/components/settings/voice-profile-editor';
import { VoiceSampleCard } from '@/components/settings/voice-sample-card';
import { VoiceSampleForm } from '@/components/settings/voice-sample-form';
import type { VoiceProfile, VoiceSample } from '@/types';

interface ProfileResponse {
  profile: VoiceProfile | null;
  sampleCount: number;
}

interface SamplesResponse {
  samples: VoiceSample[];
}

interface Props {
  hasAnthropicKey: boolean;
}

/**
 * Voice section of the settings page.
 * Orchestrates profile display/editing and sample management.
 */
export function VoiceSection({ hasAnthropicKey }: Props) {
  const [profile, setProfile] = useState<VoiceProfile | null>(null);
  const [samples, setSamples] = useState<VoiceSample[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [profRes, sampRes] = await Promise.all([
        fetch('/api/voice/profile'),
        fetch('/api/voice/samples'),
      ]);
      if (!profRes.ok || !sampRes.ok) throw new Error('Failed to load voice data');
      const profData: ProfileResponse = await profRes.json();
      const sampData: SamplesResponse = await sampRes.json();
      setProfile(profData.profile);
      setSamples(sampData.samples);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  async function handleSaveProfile(text: string) {
    const res = await fetch('/api/voice/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: text }),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error ?? 'Failed to save profile');
    }
    const data = await res.json();
    setProfile(data.profile);
  }

  async function handleExtract(force: boolean) {
    const res = await fetch('/api/voice/profile/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error ?? 'Extraction failed');
    }
    const data = await res.json();
    setProfile(data.profile);
  }

  async function handleAddSample(data: { title: string; content: string; channelHint?: string }) {
    const res = await fetch('/api/voice/samples', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error ?? 'Failed to add sample');
    }
    setShowAddForm(false);
    await fetchData();
  }

  async function handleUpdateSample(
    id: number,
    updates: { title?: string; channelHint?: string | null },
  ) {
    const res = await fetch(`/api/voice/samples/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error ?? 'Failed to update sample');
    }
    const data = await res.json();
    setSamples((prev) => prev.map((s) => (s.id === id ? data.sample : s)));
  }

  async function handleDeleteSample(id: number) {
    const res = await fetch(`/api/voice/samples/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error ?? 'Failed to delete sample');
    }
    setSamples((prev) => prev.filter((s) => s.id !== id));
    if (profile) {
      setProfile({ ...profile, sampleCount: Math.max(0, profile.sampleCount - 1) });
    }
  }

  if (loading) {
    return <div className="text-muted-foreground py-4 text-sm">Loading…</div>;
  }

  if (error) {
    return <div className="text-destructive py-4 text-sm">{error}</div>;
  }

  return (
    <div className="space-y-8">
      {/* Profile subsection */}
      <div>
        {profile && profile.profile ? (
          <VoiceProfileEditor
            profile={profile}
            sampleCount={samples.length}
            hasAnthropicKey={hasAnthropicKey}
            onSave={handleSaveProfile}
            onExtract={handleExtract}
          />
        ) : (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Voice Profile</h3>
            {hasAnthropicKey && samples.length >= 3 ? (
              <div className="space-y-2">
                <p className="text-muted-foreground text-sm">
                  You have {samples.length} samples ready. Generate your voice profile.
                </p>
                <Button onClick={() => handleExtract(false)}>Generate voice profile</Button>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                {!hasAnthropicKey
                  ? 'Add an Anthropic API key in Integrations to enable AI voice extraction. You can still write a profile manually.'
                  : `Add at least ${3 - samples.length} more writing sample${3 - samples.length === 1 ? '' : 's'}, then generate your voice profile.`}
              </p>
            )}
            {!profile?.profile && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  handleSaveProfile(
                    '# Voice Profile\n\n'.padEnd(
                      100,
                      'Edit this profile to describe your writing voice.',
                    ),
                  )
                }
              >
                Write profile manually
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Samples subsection */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            Writing Samples{' '}
            <span className="text-muted-foreground font-normal">({samples.length})</span>
          </h3>
          {!showAddForm && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAddForm(true)}
              data-testid="add-sample-button"
            >
              Add sample
            </Button>
          )}
        </div>

        {showAddForm && (
          <VoiceSampleForm onAdd={handleAddSample} onCancel={() => setShowAddForm(false)} />
        )}

        {samples.length === 0 && !showAddForm && (
          <p className="text-muted-foreground text-sm">
            No writing samples yet. Add samples to enable AI voice extraction.
          </p>
        )}

        <div className="space-y-2">
          {samples.map((sample) => (
            <VoiceSampleCard
              key={sample.id}
              sample={sample}
              onUpdate={handleUpdateSample}
              onDelete={handleDeleteSample}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
