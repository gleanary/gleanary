import { describe, it, expect } from 'vitest';
import {
  computeWordCount,
  assembleSamplesPayload,
  VOICE_PROFILE_PROMPT,
} from '@/lib/voice-extraction';
import type { VoiceSample } from '@/types';

function makeSample(overrides: Partial<VoiceSample> = {}): VoiceSample {
  return {
    id: 1,
    profileId: 1,
    title: 'Test sample',
    content: 'This is a sample. '.repeat(10),
    wordCount: 40,
    channelHint: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('computeWordCount', () => {
  it('returns 0 for empty string', () => {
    expect(computeWordCount('')).toBe(0);
  });

  it('returns 0 for whitespace-only string', () => {
    expect(computeWordCount('   \n\t  ')).toBe(0);
  });

  it('counts single word', () => {
    expect(computeWordCount('hello')).toBe(1);
  });

  it('counts multiple words', () => {
    expect(computeWordCount('one two three')).toBe(3);
  });

  it('handles multiple spaces between words', () => {
    expect(computeWordCount('one  two   three')).toBe(3);
  });

  it('handles newlines', () => {
    expect(computeWordCount('first\nsecond\nthird')).toBe(3);
  });

  it('handles punctuation attached to words', () => {
    expect(computeWordCount('Hello, world!')).toBe(2);
  });
});

describe('assembleSamplesPayload', () => {
  it('formats a single sample with separator and title', () => {
    const sample = makeSample({ id: 1, title: 'My Blog Post', content: 'Content here.' });
    const result = assembleSamplesPayload([sample]);
    expect(result).toContain('--- Sample 1: My Blog Post ---');
    expect(result).toContain('Content here.');
    expect(result).toContain('WRITING SAMPLES:');
  });

  it('numbers multiple samples sequentially', () => {
    const samples = [
      makeSample({ id: 1, title: 'First', content: 'First content.' }),
      makeSample({ id: 2, title: 'Second', content: 'Second content.' }),
    ];
    const result = assembleSamplesPayload(samples);
    expect(result).toContain('--- Sample 1: First ---');
    expect(result).toContain('--- Sample 2: Second ---');
  });

  it('truncates longest sample when total exceeds 80K chars', () => {
    const bigContent = 'x'.repeat(60_000);
    const mediumContent = 'y'.repeat(30_000);
    const samples = [
      makeSample({ id: 1, title: 'Big', content: bigContent }),
      makeSample({ id: 2, title: 'Medium', content: mediumContent }),
    ];
    const result = assembleSamplesPayload(samples);
    // Total was 90K; big sample should be truncated
    expect(result).toContain('[truncated]');
    expect(result.length).toBeLessThanOrEqual(80_500); // small overhead for separators
  });

  it('truncates only the longest sample, preserves shorter ones intact', () => {
    const bigContent = 'a'.repeat(70_000);
    const shortContent = 'b'.repeat(1_000);
    const samples = [
      makeSample({ id: 1, title: 'Big', content: bigContent }),
      makeSample({ id: 2, title: 'Short', content: shortContent }),
    ];
    const result = assembleSamplesPayload(samples);
    expect(result).toContain('--- Sample 2: Short ---');
    expect(result).toContain('b'.repeat(1_000));
  });

  it('returns valid output for empty samples array', () => {
    const result = assembleSamplesPayload([]);
    expect(result).toBe('WRITING SAMPLES:\n\n');
  });
});

describe('VOICE_PROFILE_PROMPT', () => {
  it('is exported and non-empty', () => {
    expect(VOICE_PROFILE_PROMPT).toBeTruthy();
    expect(VOICE_PROFILE_PROMPT.length).toBeGreaterThan(100);
  });

  it('includes the channel-agnostic constraint', () => {
    expect(VOICE_PROFILE_PROMPT).toContain('CHANNEL-AGNOSTIC');
  });

  it('includes all required section headers', () => {
    const requiredSections = [
      '## Rhythm & Sentence Structure',
      '## Vocabulary & Register',
      '## Argument Construction',
      '## Opening Patterns',
      '## Closing Patterns',
      '## Rhetorical Devices',
      '## Tone & Confidence',
      '## Anti-Patterns',
    ];
    for (const section of requiredSections) {
      expect(VOICE_PROFILE_PROMPT).toContain(section);
    }
  });

  it('instructs natural frequency extraction (no amplification)', () => {
    expect(VOICE_PROFILE_PROMPT).toContain('NATURAL FREQUENCY');
  });
});
