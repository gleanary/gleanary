/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TTSPlayer } from '@/components/reader/tts-player';

const tts = vi.hoisted(() => ({
  status: 'playing',
  pause: vi.fn(),
  resume: vi.fn(),
  stop: vi.fn(),
  skipForward: vi.fn(),
  skipBack: vi.fn(),
  seekTo: vi.fn(),
  setSpeed: vi.fn(),
  currentTime: 10,
  estimatedTotalTime: 100,
  progress: 0.1,
  speed: 1,
}));

vi.mock('@/components/reader/tts-provider', () => ({ useTTS: () => tts }));

function renderWithDialog() {
  render(
    <>
      <TTSPlayer />
      <button>outside</button>
      <div role="dialog">
        <button>inside dialog</button>
      </div>
    </>,
  );
  return {
    outside: screen.getByRole('button', { name: 'outside' }),
    inside: screen.getByRole('button', { name: 'inside dialog' }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('TTSPlayer keyboard shortcuts', () => {
  it('Escape outside any dialog stops playback and is prevented', () => {
    const { outside } = renderWithDialog();
    expect(fireEvent.keyDown(outside, { key: 'Escape' })).toBe(false);
    expect(tts.stop).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape from inside a dialog so the dialog can dismiss itself', () => {
    const { inside } = renderWithDialog();
    expect(fireEvent.keyDown(inside, { key: 'Escape' })).toBe(true);
    expect(tts.stop).not.toHaveBeenCalled();
  });

  it('ignores playback shortcuts from inside a dialog', () => {
    const { inside } = renderWithDialog();
    expect(fireEvent.keyDown(inside, { key: 'p' })).toBe(true);
    expect(fireEvent.keyDown(inside, { key: 'ArrowRight' })).toBe(true);
    expect(tts.pause).not.toHaveBeenCalled();
    expect(tts.skipForward).not.toHaveBeenCalled();
  });
});
