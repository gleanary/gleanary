import 'server-only';
import { ExternalServiceError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { getConfig } from '@/lib/settings';
import type { InworldChunk, TTSOptions, TTSVoice } from '@/types';

const INWORLD_STREAM_URL = 'https://api.inworld.ai/tts/v1/voice:stream';
const INWORLD_VOICES_URL = 'https://api.inworld.ai/tts/v1/voices';
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Streams TTS audio from the Inworld API for a given text.
 * Yields chunks containing base64 audio and word timestamp alignment.
 * @param text - Text to synthesize (max 2000 chars)
 * @param options - TTS synthesis options
 * @param signal - Optional AbortSignal to cancel the stream
 */
export async function* streamTTS(
  text: string,
  options: TTSOptions,
  signal?: AbortSignal,
): AsyncGenerator<InworldChunk> {
  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

  let timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(INWORLD_STREAM_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${getConfig('inworld_api_key')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        voiceId: options.voiceId,
        modelId: options.modelId,
        audioConfig: {
          audioEncoding: options.audioEncoding,
          sampleRateHertz: options.sampleRateHertz,
          speakingRate: options.speed,
        },
        temperature: 1.0,
        timestampType: 'WORD',
        timestampTransportStrategy: 'SYNC',
      }),
      signal: combinedSignal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new ExternalServiceError('Inworld TTS', `HTTP ${response.status}: ${errorText}`);
    }

    if (!response.body) {
      throw new ExternalServiceError('Inworld TTS', 'No response body');
    }

    // Parse NDJSON stream — audio and timestamps may arrive in separate lines
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let pendingAudio: string | null = null;
    let pendingWords: string[] = [];
    let pendingStartTimes: number[] = [];
    let pendingEndTimes: number[] = [];

    const flushPending = function* (): Generator<InworldChunk> {
      if (pendingAudio) {
        yield {
          audioContent: pendingAudio,
          words: pendingWords,
          wordStartTimes: pendingStartTimes,
          wordEndTimes: pendingEndTimes,
        };
        pendingAudio = null;
        pendingWords = [];
        pendingStartTimes = [];
        pendingEndTimes = [];
      }
    };

    const processLine = function* (line: string): Generator<InworldChunk> {
      const parsed = parseInworldLine(line);
      if (!parsed) return;

      if (parsed.audioContent && parsed.words.length > 0) {
        // Line has both audio and timestamps (inline) — flush previous, yield directly
        yield* flushPending();
        yield parsed;
      } else if (parsed.audioContent) {
        // Audio-only line — flush previous audio, buffer this one
        yield* flushPending();
        pendingAudio = parsed.audioContent;
      } else if (parsed.words.length > 0) {
        // Timestamp-only line — attach to pending audio
        pendingWords.push(...parsed.words);
        pendingStartTimes.push(...parsed.wordStartTimes);
        pendingEndTimes.push(...parsed.wordEndTimes);
      }
    };

    while (true) {
      // Reset timeout for each chunk
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // Keep incomplete last line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        yield* processLine(trimmed);
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      yield* processLine(buffer.trim());
    }

    // Flush any remaining pending audio
    yield* flushPending();
  } catch (error) {
    if (error instanceof ExternalServiceError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') return;
    throw new ExternalServiceError(
      'Inworld TTS',
      error instanceof Error ? error.message : 'Stream failed',
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Lists available voices from the Inworld API.
 * @param language - Optional language filter (ISO 639-1 code)
 * @returns Array of available TTS voices
 */
export async function listVoices(language?: string): Promise<TTSVoice[]> {
  const url = new URL(INWORLD_VOICES_URL);
  if (language) url.searchParams.set('filter', `language=${language}`);

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Basic ${getConfig('inworld_api_key')}`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new ExternalServiceError('Inworld TTS', `Voices API HTTP ${response.status}`);
  }

  const data = await response.json();
  const voices: TTSVoice[] = (data.voices ?? []).map(
    (v: { voiceId: string; displayName: string; languages?: string[] }) => ({
      voiceId: v.voiceId,
      name: v.displayName,
      language: v.languages?.[0] ?? 'en',
    }),
  );

  return voices;
}

/** Parses a single NDJSON line from the Inworld response */
function parseInworldLine(line: string): InworldChunk | null {
  try {
    const parsed = JSON.parse(line);
    const result = parsed.result;
    if (!result) return null;

    const alignment = result.timestampInfo?.wordAlignment;
    const audioContent = result.audioContent ?? '';
    const words = alignment?.words ?? [];

    // Skip lines that have neither audio nor timestamps
    if (!audioContent && words.length === 0) return null;

    return {
      audioContent,
      words,
      wordStartTimes: alignment?.wordStartTimeSeconds ?? [],
      wordEndTimes: alignment?.wordEndTimeSeconds ?? [],
    };
  } catch {
    logger.warn({ line: line.slice(0, 100) }, 'Failed to parse Inworld NDJSON line');
    return null;
  }
}
