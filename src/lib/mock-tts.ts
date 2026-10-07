import type { InworldChunk } from '@/types';

/** Average word duration in seconds for mock TTS */
const AVG_WORD_DURATION = 0.35;
/** Gap between words in seconds */
const WORD_GAP = 0.08;
/** Sample rate for generated silent WAV */
const SAMPLE_RATE = 24000;

/**
 * Mock TTS stream that generates silent audio with realistic word timestamps.
 * Produces valid WAV audio that decodeAudioData can handle in any browser.
 * Used when MOCK_TTS=true to avoid Inworld API costs during development.
 * @param text - Text to synthesize
 */
export async function* mockStreamTTS(text: string): AsyncGenerator<InworldChunk> {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return;

  const wordStartTimes: number[] = [];
  const wordEndTimes: number[] = [];
  let time = 0.05; // Small initial pause

  for (const word of words) {
    wordStartTimes.push(time);
    // Longer words take slightly longer
    const duration = AVG_WORD_DURATION + word.length * 0.02;
    time += duration;
    wordEndTimes.push(time);
    time += WORD_GAP;
  }

  const totalDuration = time;
  const audioContent = generateSilentWavBase64(totalDuration);

  // Simulate network latency
  await new Promise((r) => setTimeout(r, 50));

  yield {
    audioContent,
    words,
    wordStartTimes,
    wordEndTimes,
  };
}

/**
 * Generates a silent WAV file as a base64 string.
 * WAV is used instead of MP3 because it's universally supported by decodeAudioData.
 */
function generateSilentWavBase64(durationSeconds: number): string {
  const numSamples = Math.ceil(durationSeconds * SAMPLE_RATE);
  const dataSize = numSamples * 2; // 16-bit PCM = 2 bytes per sample
  const fileSize = 44 + dataSize; // 44 byte WAV header + PCM data

  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);

  // WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, fileSize - 8, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  // PCM data is all zeros (silence) — ArrayBuffer is zero-initialized

  // Convert to base64
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(binary);
}

/** Writes an ASCII string to a DataView at a given offset */
function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
