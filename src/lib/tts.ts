import 'server-only';
import { config } from '@/config';
import { streamTTS } from '@/lib/inworld-client';
import { mockStreamTTS } from '@/lib/mock-tts';
import type { TTSOptions, PreparedParagraph, SynthesisEvent } from '@/types';

export type { SynthesisEvent };

/**
 * Synthesizes an entire article paragraph by paragraph.
 * Yields audio chunks with paragraph indices and paragraph-complete markers.
 * Uses mock TTS when MOCK_TTS=true to avoid API costs during development.
 * @param paragraphs - Prepared paragraphs to synthesize
 * @param options - TTS synthesis options
 * @param startIndex - Paragraph index to start from
 * @param signal - Optional AbortSignal to cancel
 * @returns AsyncGenerator of synthesis events (audio chunks and paragraph-complete markers)
 */
export async function* synthesizeArticle(
  paragraphs: PreparedParagraph[],
  options: TTSOptions,
  startIndex: number,
  signal?: AbortSignal,
): AsyncGenerator<SynthesisEvent> {
  const useMock = config.tts.mock;

  for (let i = startIndex; i < paragraphs.length; i++) {
    if (signal?.aborted) return;

    const paragraph = paragraphs[i]!;
    const stream = useMock
      ? mockStreamTTS(paragraph.text)
      : streamTTS(paragraph.text, options, signal);

    for await (const chunk of stream) {
      yield {
        type: 'chunk',
        data: {
          paragraphIndex: paragraph.index,
          audioContent: chunk.audioContent,
          words: chunk.words,
          startTimes: chunk.wordStartTimes,
          endTimes: chunk.wordEndTimes,
        },
      };
    }

    yield { type: 'paragraph-complete', paragraphIndex: paragraph.index };
  }
}
