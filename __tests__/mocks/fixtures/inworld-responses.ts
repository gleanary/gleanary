/**
 * Mock Inworld TTS API responses for testing.
 */

/** A single NDJSON line from the Inworld streaming endpoint */
export interface MockInworldStreamLine {
  result: {
    audioContent: string;
    usage: {
      processedCharactersCount: number;
      modelId: string;
    };
    timestampInfo?: {
      wordAlignment: {
        words: string[];
        wordStartTimeSeconds: number[];
        wordEndTimeSeconds: number[];
      };
    };
  };
}

/** Creates a base64-encoded string simulating a tiny MP3 audio payload */
function fakeAudioBase64(length = 100): string {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = i % 256;
  return Buffer.from(bytes).toString('base64');
}

/**
 * Creates a mock NDJSON streaming response for a given text.
 * Simulates the Inworld API returning a single chunk with word timestamps.
 */
export function createMockStreamLines(text: string): MockInworldStreamLine[] {
  const words = text.split(/\s+/).filter(Boolean);
  let time = 0;
  const startTimes: number[] = [];
  const endTimes: number[] = [];

  for (const word of words) {
    startTimes.push(time);
    const duration = 0.15 + word.length * 0.05;
    time += duration;
    endTimes.push(time);
    time += 0.05; // gap between words
  }

  return [
    {
      result: {
        audioContent: fakeAudioBase64(200),
        usage: { processedCharactersCount: text.length, modelId: 'inworld-tts-1.5-max' },
        timestampInfo: {
          wordAlignment: {
            words,
            wordStartTimeSeconds: startTimes,
            wordEndTimeSeconds: endTimes,
          },
        },
      },
    },
  ];
}

/**
 * Creates mock NDJSON lines with audio and timestamps in SEPARATE lines.
 * Simulates the Inworld API with SYNC timestamp strategy where timestamps
 * arrive as separate NDJSON objects from the audio.
 */
export function createMockSplitStreamLines(text: string): MockInworldStreamLine[] {
  const words = text.split(/\s+/).filter(Boolean);
  let time = 0;
  const startTimes: number[] = [];
  const endTimes: number[] = [];

  for (const word of words) {
    startTimes.push(time);
    const duration = 0.15 + word.length * 0.05;
    time += duration;
    endTimes.push(time);
    time += 0.05;
  }

  return [
    // Audio-only line
    {
      result: {
        audioContent: fakeAudioBase64(200),
        usage: { processedCharactersCount: text.length, modelId: 'inworld-tts-1.5-max' },
      },
    },
    // Timestamp-only line
    {
      result: {
        audioContent: undefined as unknown as string,
        usage: { processedCharactersCount: 0, modelId: 'inworld-tts-1.5-max' },
        timestampInfo: {
          wordAlignment: {
            words,
            wordStartTimeSeconds: startTimes,
            wordEndTimeSeconds: endTimes,
          },
        },
      },
    },
  ];
}

/**
 * Converts mock stream lines to an NDJSON string (newline-delimited JSON).
 */
export function toNDJSON(lines: MockInworldStreamLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

/** Mock response for GET /tts/v1/voices */
export const MOCK_VOICES_RESPONSE = {
  voices: [
    {
      voiceId: 'Dennis',
      displayName: 'Dennis',
      languages: ['en'],
      description: 'Smooth calm male voice',
      tags: ['calm', 'professional'],
      isCustom: false,
    },
    {
      voiceId: 'Marie',
      displayName: 'Marie',
      languages: ['fr'],
      description: 'Warm female voice',
      tags: ['warm', 'friendly'],
      isCustom: false,
    },
    {
      voiceId: 'Alex',
      displayName: 'Alex',
      languages: ['en'],
      description: 'Energetic male voice',
      tags: ['energetic'],
      isCustom: false,
    },
  ],
};

/** Short paragraph for testing */
export const MOCK_PARAGRAPH_TEXT = 'The quick brown fox jumps over the lazy dog.';

/** Multi-paragraph article text for testing */
export const MOCK_ARTICLE_TEXT = `The quick brown fox jumps over the lazy dog. This is a test paragraph with enough content for testing.

The second paragraph provides additional content for multi-paragraph TTS testing. It contains multiple sentences to verify chunking behavior.

A third and final paragraph concludes the test article.`;
