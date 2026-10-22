/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTTSPlayer } from '@/hooks/useTTSPlayer';
import { isSpokenToken } from '@/lib/tts-tokens';

// ---------------------------------------------------------------------------
// Fakes: Web Audio, requestAnimationFrame and the SSE fetch (relative URL,
// which MSW cannot intercept in Node — stubbed in beforeAll per CLAUDE.md).
// ---------------------------------------------------------------------------

interface FakeSource {
  buffer: unknown;
  playbackRate: { value: number };
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}

const contexts: FakeAudioContext[] = [];

class FakeAudioContext {
  currentTime = 0;
  state: 'running' | 'suspended' | 'closed' = 'running';
  destination = {};
  sources: FakeSource[] = [];

  constructor() {
    contexts.push(this);
  }

  createBufferSource(): FakeSource {
    const source: FakeSource = {
      buffer: null,
      playbackRate: { value: 1 },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    };
    this.sources.push(source);
    return source;
  }

  /** The fake "mp3" payload is just the paragraph duration as ASCII. */
  decodeAudioData(data: ArrayBuffer): Promise<{ duration: number }> {
    const text = String.fromCharCode(...new Uint8Array(data));
    return Promise.resolve({ duration: Number(text) });
  }

  suspend(): Promise<void> {
    this.state = 'suspended';
    return Promise.resolve();
  }

  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
}

let rafId = 0;
const rafCallbacks = new Map<number, FrameRequestCallback>();

/** Run every pending animation frame once (the tracking loop re-registers itself). */
function flushFrame(): void {
  const callbacks = [...rafCallbacks.values()];
  rafCallbacks.clear();
  act(() => {
    for (const cb of callbacks) cb(0);
  });
}

const fetchMock = vi.fn();
let streamFor: (startParagraph: number) => string = () => '';

function sseResponse(payload: string) {
  const bytes = new TextEncoder().encode(payload);
  let sent = false;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: () => {
          if (sent) return Promise.resolve({ done: true, value: undefined });
          sent = true;
          return Promise.resolve({ done: false, value: bytes });
        },
      }),
    },
  };
}

function sse(event: string, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 3 paragraphs × 100 words at 150 WPM → 40s estimated each, 120s total. */
const PARAGRAPH_WORD_COUNTS = [100, 100, 100];

function metadata(withWordCounts = true): string {
  return sse('metadata', {
    totalParagraphs: 3,
    totalWords: 300,
    ...(withWordCounts ? { paragraphWordCounts: PARAGRAPH_WORD_COUNTS } : {}),
    articleTitle: 'Test',
    language: 'en',
  });
}

function audio(
  paragraphIndex: number,
  duration: number,
  words: string[] = ['word'],
  startTimes: number[] = [0],
  endTimes: number[] = [duration],
): string {
  return sse('audio', {
    paragraphIndex,
    audioContent: btoa(String(duration)),
    format: 'mp3',
    words,
    startTimes,
    endTimes,
  });
}

function requestedStartParagraphs(): number[] {
  return fetchMock.mock.calls.map(([url]) =>
    Number(new URL(String(url), 'http://localhost').searchParams.get('startParagraph')),
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function ctx(): FakeAudioContext {
  const current = contexts[contexts.length - 1];
  if (!current) throw new Error('AudioContext was never created');
  return current;
}

function lastSource(): FakeSource {
  const source = ctx().sources[ctx().sources.length - 1];
  if (!source) throw new Error('No audio source was started');
  return source;
}

/** Advance the audio clock and run one tracking frame. */
function advance(seconds: number): void {
  ctx().currentTime += seconds;
  flushFrame();
}

async function startPlayback(startParagraph = 0, startOffset = 0, onComplete = vi.fn()) {
  const hook = renderHook(() => useTTSPlayer(onComplete));
  act(() => hook.result.current.play(1, startParagraph, startOffset));
  await settle();
  return hook;
}

beforeAll(() => {
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafId++;
    rafCallbacks.set(rafId, cb);
    return rafId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafCallbacks.delete(id);
  });
  vi.stubGlobal('fetch', fetchMock);
});

beforeEach(() => {
  contexts.length = 0;
  rafCallbacks.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    const startParagraph = Number(
      new URL(url, 'http://localhost').searchParams.get('startParagraph') ?? 0,
    );
    return Promise.resolve(sseResponse(streamFor(startParagraph)));
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('isSpokenToken', () => {
  it('accepts tokens containing a letter or digit', () => {
    for (const token of ['Hi', 'Hi,', 'now.', '2026', 'élan', '"quoted"']) {
      expect(isSpokenToken(token)).toBe(true);
    }
  });

  it('rejects empty, whitespace, punctuation and emoji-only tokens', () => {
    for (const token of ['', ' ', ', ', '—', '.', '👋 ', '...']) {
      expect(isSpokenToken(token)).toBe(false);
    }
  });
});

describe('useTTSPlayer', () => {
  it('advances the progress bar during normal playback from paragraph 0', async () => {
    streamFor = () => metadata() + audio(0, 40) + audio(1, 40) + audio(2, 40);
    const { result } = await startPlayback();
    expect(result.current.status).toBe('playing');
    expect(result.current.estimatedTotalTime).toBe(120);

    advance(10);

    expect(result.current.currentTime).toBeCloseTo(10);
    expect(result.current.progress).toBeCloseTo(10 / 120);
  });

  it('drops blank and punctuation tokens while keeping their timestamps aligned', async () => {
    streamFor = () =>
      metadata() +
      audio(
        0,
        2,
        ['', 'Software', ' ', 'engineering', ', '],
        [0, 0, 0.5, 0.6, 1.2],
        [0, 0.5, 0.6, 1.2, 1.3],
      );
    const { result } = await startPlayback();

    expect(result.current.currentWords).toEqual(['Software', 'engineering']);

    advance(0.2);
    expect(result.current.currentWordIndex).toBe(0);
    advance(0.6); // t = 0.8 → inside "engineering"
    expect(result.current.currentWordIndex).toBe(1);
  });

  it('seeks within loaded audio from the exact offset without restarting the stream', async () => {
    streamFor = () => metadata() + audio(0, 40) + audio(1, 40) + audio(2, 40);
    const { result } = await startPlayback();

    act(() => result.current.seekTo(50));
    flushFrame();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastSource().start).toHaveBeenCalledWith(0, 10);
    expect(result.current.currentParagraph).toBe(1);
    expect(result.current.currentTime).toBeCloseTo(50);
    expect(result.current.progress).toBeCloseTo(50 / 120);
  });

  it('restarts the stream at the estimated paragraph when seeking into unloaded audio', async () => {
    streamFor = (start) => (start === 0 ? metadata() + audio(0, 40) : metadata() + audio(2, 40));
    const { result } = await startPlayback();

    act(() => result.current.seekTo(100));

    expect(requestedStartParagraphs()).toEqual([0, 2]);
    // The bar reflects the target immediately, before the new stream arrives
    expect(result.current.currentTime).toBeCloseTo(100);

    await settle();
    flushFrame();

    expect(result.current.status).toBe('playing');
    expect(result.current.currentParagraph).toBe(2);
    expect(lastSource().start).toHaveBeenCalledWith(0, 20);
    expect(result.current.currentTime).toBeCloseTo(100);
    expect(result.current.progress).toBeCloseTo(100 / 120);
  });

  it('starts a resumed stream at the estimated absolute position and can seek around it', async () => {
    streamFor = (start) =>
      start === 1
        ? metadata() + audio(1, 40) + audio(2, 40)
        : metadata() + audio(0, 40) + audio(1, 40) + audio(2, 40);
    const { result } = await startPlayback(1, 5);
    flushFrame();

    expect(result.current.currentParagraph).toBe(1);
    expect(result.current.currentTime).toBeCloseTo(45);
    expect(result.current.progress).toBeCloseTo(45 / 120);

    // Seek within the loaded part of the resumed stream: no new request
    act(() => result.current.seekTo(90));
    flushFrame();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.currentParagraph).toBe(2);
    expect(result.current.currentTime).toBeCloseTo(90);

    // Seek before the stream's start paragraph: restart there
    act(() => result.current.seekTo(10));
    expect(requestedStartParagraphs()).toEqual([1, 0]);
    await settle();
    flushFrame();
    expect(result.current.currentParagraph).toBe(0);
    expect(result.current.currentTime).toBeCloseTo(10);
  });

  it('falls back to the previous seek behavior when metadata has no paragraphWordCounts', async () => {
    streamFor = () => metadata(false) + audio(0, 40);
    const { result } = await startPlayback();
    advance(5);

    expect(() => act(() => result.current.seekTo(100))).not.toThrow();
    flushFrame();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.currentParagraph).toBe(0);
    expect(result.current.currentTime).toBeCloseTo(5);
  });

  it('keeps skipBack consistent with the absolute timeline after a resume', async () => {
    streamFor = () => metadata() + audio(1, 40) + audio(2, 40);
    const { result } = await startPlayback(1, 5);

    // Paragraph 1 ends naturally → paragraph 2 plays from the absolute 80s mark
    act(() => lastSource().onended?.());
    advance(5);
    expect(result.current.currentParagraph).toBe(2);
    expect(result.current.currentTime).toBeCloseTo(85);

    act(() => result.current.skipBack());
    flushFrame();

    expect(result.current.currentParagraph).toBe(1);
    expect(lastSource().start).toHaveBeenCalledWith(0, 30);
    expect(result.current.currentTime).toBeCloseTo(70);

    act(() => result.current.skipForward());
    flushFrame();
    expect(result.current.currentParagraph).toBe(2);
    expect(result.current.currentTime).toBeCloseTo(85);
  });

  it('fires onComplete and fills the bar at the natural end of the article', async () => {
    streamFor = () => metadata() + audio(0, 40) + audio(1, 40) + audio(2, 40);
    const onComplete = vi.fn();
    const { result } = await startPlayback(0, 0, onComplete);

    act(() => lastSource().onended?.());
    act(() => lastSource().onended?.());
    act(() => lastSource().onended?.());

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('idle');
    expect(result.current.progress).toBe(1);
  });

  it('stops tracking on pause and restarts it on resume', async () => {
    streamFor = () => metadata() + audio(0, 40);
    const { result } = await startPlayback();
    expect(rafCallbacks.size).toBe(1);

    act(() => result.current.pause());
    expect(result.current.status).toBe('paused');
    expect(rafCallbacks.size).toBe(0);

    act(() => result.current.resume());
    expect(result.current.status).toBe('playing');
    expect(rafCallbacks.size).toBe(1);
    advance(3);
    expect(result.current.currentTime).toBeCloseTo(3);
  });
});
