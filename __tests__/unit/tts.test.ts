import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TTSOptions, PreparedParagraph, InworldChunk } from '@/types';

// Mock the inworld-client module
vi.mock('@/lib/inworld-client', () => ({
  streamTTS: vi.fn(),
}));

import { streamTTS } from '@/lib/inworld-client';
import { synthesizeArticle } from '@/lib/tts';

const mockStreamTTS = vi.mocked(streamTTS);

const defaultOptions: TTSOptions = {
  voiceId: 'Dennis',
  modelId: 'inworld-tts-1.5-max',
  speed: 1.0,
  audioEncoding: 'MP3',
  sampleRateHertz: 24000,
};

function createMockChunk(words: string[], startTime = 0): InworldChunk {
  const startTimes: number[] = [];
  const endTimes: number[] = [];
  let time = startTime;
  for (const word of words) {
    startTimes.push(time);
    time += 0.2 + word.length * 0.05;
    endTimes.push(time);
    time += 0.05;
  }
  return {
    audioContent: Buffer.from('fake-audio').toString('base64'),
    words,
    wordStartTimes: startTimes,
    wordEndTimes: endTimes,
  };
}

async function* mockGenerator(chunks: InworldChunk[]): AsyncGenerator<InworldChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe('synthesizeArticle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const paragraphs: PreparedParagraph[] = [
    { index: 0, text: 'First paragraph.', wordCount: 2 },
    { index: 1, text: 'Second paragraph.', wordCount: 2 },
    { index: 2, text: 'Third paragraph.', wordCount: 2 },
  ];

  it('yields chunks with correct paragraph indices', async () => {
    mockStreamTTS.mockImplementation(() => mockGenerator([createMockChunk(['Test', 'words'])]));

    const events: Array<{ type: string; paragraphIndex?: number }> = [];
    for await (const event of synthesizeArticle(paragraphs, defaultOptions, 0)) {
      if (event.type === 'chunk') {
        events.push({ type: 'chunk', paragraphIndex: event.data.paragraphIndex });
      } else {
        events.push({ type: 'paragraph-complete', paragraphIndex: event.paragraphIndex });
      }
    }

    // Should have chunks and paragraph-complete events for all 3 paragraphs
    const completeEvents = events.filter((e) => e.type === 'paragraph-complete');
    expect(completeEvents).toHaveLength(3);
    expect(completeEvents.map((e) => e.paragraphIndex)).toEqual([0, 1, 2]);
  });

  it('respects startIndex parameter', async () => {
    mockStreamTTS.mockImplementation(() => mockGenerator([createMockChunk(['Test'])]));

    const events: Array<{ type: string; paragraphIndex?: number }> = [];
    for await (const event of synthesizeArticle(paragraphs, defaultOptions, 1)) {
      if (event.type === 'paragraph-complete') {
        events.push({ type: 'paragraph-complete', paragraphIndex: event.paragraphIndex });
      }
    }

    // Should only process paragraphs 1 and 2
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.paragraphIndex)).toEqual([1, 2]);
  });

  it('handles empty paragraphs array', async () => {
    const events = [];
    for await (const event of synthesizeArticle([], defaultOptions, 0)) {
      events.push(event);
    }
    expect(events).toHaveLength(0);
  });

  it('calls streamTTS once per paragraph', async () => {
    mockStreamTTS.mockImplementation(() => mockGenerator([createMockChunk(['Word'])]));

    for await (const _event of synthesizeArticle(paragraphs, defaultOptions, 0)) {
      // consume
    }

    expect(mockStreamTTS).toHaveBeenCalledTimes(3);
  });
});
