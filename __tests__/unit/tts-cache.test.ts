import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TTSOptions, PreparedParagraph, InworldChunk, SynthesisEvent } from '@/types';

const testCacheDir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('node:path') as typeof import('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const o = require('node:os') as typeof import('node:os');
  return p.join(o.tmpdir(), `tts-cache-test-${Date.now()}`);
});

vi.mock('@/config', () => ({
  config: {
    tts: {
      mock: false,
      cache: {
        enabled: true,
        dir: testCacheDir,
        maxSizeBytes: 1024 * 1024, // 1 MB for tests
      },
    },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock the TTS functions
vi.mock('@/lib/inworld-client', () => ({
  streamTTS: vi.fn(),
}));

vi.mock('@/lib/mock-tts', () => ({
  mockStreamTTS: vi.fn(),
}));

import { streamTTS } from '@/lib/inworld-client';
import {
  cachedSynthesizeArticle,
  deleteArticleCache,
  getCacheStats,
  evictIfNeeded,
} from '@/lib/tts-cache';

const mockStreamTTS = vi.mocked(streamTTS);

const defaultOptions: TTSOptions = {
  voiceId: 'Dennis',
  modelId: 'inworld-tts-1.5-max',
  speed: 1.0,
  audioEncoding: 'MP3',
  sampleRateHertz: 24000,
};

const paragraphs: PreparedParagraph[] = [
  { index: 0, text: 'First paragraph.', wordCount: 2 },
  { index: 1, text: 'Second paragraph.', wordCount: 2 },
];

function createChunk(words: string[]): InworldChunk {
  return {
    audioContent: Buffer.from('fake-audio-data').toString('base64'),
    words,
    wordStartTimes: words.map((_, i) => i * 0.3),
    wordEndTimes: words.map((_, i) => i * 0.3 + 0.25),
  };
}

async function* mockGenerator(chunks: InworldChunk[]): AsyncGenerator<InworldChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function collectEvents(gen: AsyncGenerator<SynthesisEvent>): Promise<SynthesisEvent[]> {
  const events: SynthesisEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe('tts-cache', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await fs.rm(testCacheDir, { recursive: true, force: true });
    await fs.mkdir(testCacheDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testCacheDir, { recursive: true, force: true });
  });

  describe('cachedSynthesizeArticle', () => {
    it('calls TTS for uncached paragraphs and writes files to disk', async () => {
      mockStreamTTS.mockImplementation(() => mockGenerator([createChunk(['Hello', 'world'])]));

      const events = await collectEvents(
        cachedSynthesizeArticle(42, paragraphs, defaultOptions, 0),
      );

      // Should have chunk + paragraph-complete for each paragraph
      expect(events.filter((e) => e.type === 'paragraph-complete')).toHaveLength(2);
      expect(events.filter((e) => e.type === 'chunk')).toHaveLength(2);
      expect(mockStreamTTS).toHaveBeenCalledTimes(2);

      // Verify files written to disk
      const articleDir = path.join(testCacheDir, '42');
      const mp3Exists = await fs
        .access(path.join(articleDir, '0.mp3'))
        .then(() => true)
        .catch(() => false);
      const jsonExists = await fs
        .access(path.join(articleDir, '0.json'))
        .then(() => true)
        .catch(() => false);
      const metaExists = await fs
        .access(path.join(articleDir, 'meta.json'))
        .then(() => true)
        .catch(() => false);
      expect(mp3Exists).toBe(true);
      expect(jsonExists).toBe(true);
      expect(metaExists).toBe(true);
    });

    it('serves cached paragraphs from disk without calling TTS', async () => {
      // First pass: populate cache
      mockStreamTTS.mockImplementation(() => mockGenerator([createChunk(['Hello', 'world'])]));
      await collectEvents(cachedSynthesizeArticle(42, paragraphs, defaultOptions, 0));
      expect(mockStreamTTS).toHaveBeenCalledTimes(2);

      // Second pass: should serve from cache
      vi.clearAllMocks();
      const events = await collectEvents(
        cachedSynthesizeArticle(42, paragraphs, defaultOptions, 0),
      );

      expect(mockStreamTTS).not.toHaveBeenCalled();
      expect(events.filter((e) => e.type === 'chunk')).toHaveLength(2);
      expect(events.filter((e) => e.type === 'paragraph-complete')).toHaveLength(2);
    });

    it('handles mixed cached and uncached paragraphs', async () => {
      // Cache only paragraph 0
      mockStreamTTS.mockImplementation(() => mockGenerator([createChunk(['Hello'])]));
      await collectEvents(cachedSynthesizeArticle(42, [paragraphs[0]!], defaultOptions, 0));
      expect(mockStreamTTS).toHaveBeenCalledTimes(1);

      // Now request both paragraphs — paragraph 0 from cache, 1 from TTS
      vi.clearAllMocks();
      mockStreamTTS.mockImplementation(() => mockGenerator([createChunk(['Second'])]));
      const events = await collectEvents(
        cachedSynthesizeArticle(42, paragraphs, defaultOptions, 0),
      );

      // Only paragraph 1 should call TTS
      expect(mockStreamTTS).toHaveBeenCalledTimes(1);
      expect(events.filter((e) => e.type === 'paragraph-complete')).toHaveLength(2);
    });

    it('invalidates cache when options hash changes', async () => {
      // Populate cache with default options
      mockStreamTTS.mockImplementation(() => mockGenerator([createChunk(['Word'])]));
      await collectEvents(cachedSynthesizeArticle(42, paragraphs, defaultOptions, 0));

      // Change voice and re-request
      vi.clearAllMocks();
      mockStreamTTS.mockImplementation(() => mockGenerator([createChunk(['Word'])]));
      const newOptions = { ...defaultOptions, voiceId: 'Marie' };
      await collectEvents(cachedSynthesizeArticle(42, paragraphs, newOptions, 0));

      // Should call TTS again since options changed
      expect(mockStreamTTS).toHaveBeenCalledTimes(2);
    });

    it('respects startIndex parameter', async () => {
      mockStreamTTS.mockImplementation(() => mockGenerator([createChunk(['Word'])]));

      const events = await collectEvents(
        cachedSynthesizeArticle(42, paragraphs, defaultOptions, 1),
      );

      // Only paragraph 1 should be processed
      expect(mockStreamTTS).toHaveBeenCalledTimes(1);
      expect(events.filter((e) => e.type === 'paragraph-complete')).toHaveLength(1);
    });

    it('yields correct audio content from cache', async () => {
      const chunk = createChunk(['Hello', 'world']);
      mockStreamTTS.mockImplementation(() => mockGenerator([chunk]));

      // Populate cache
      await collectEvents(cachedSynthesizeArticle(42, [paragraphs[0]!], defaultOptions, 0));

      // Read from cache
      vi.clearAllMocks();
      const events = await collectEvents(
        cachedSynthesizeArticle(42, [paragraphs[0]!], defaultOptions, 0),
      );

      const chunkEvent = events.find((e) => e.type === 'chunk');
      if (chunkEvent?.type !== 'chunk') throw new Error('expected chunk event');
      expect(chunkEvent.data.words).toEqual(['Hello', 'world']);
      expect(chunkEvent.data.startTimes).toHaveLength(2);
      expect(chunkEvent.data.endTimes).toHaveLength(2);
      expect(chunkEvent.data.audioContent).toBeTruthy();
    });
  });

  describe('deleteArticleCache', () => {
    it('removes the cache directory', async () => {
      // Create a cache directory with files
      const articleDir = path.join(testCacheDir, '99');
      await fs.mkdir(articleDir, { recursive: true });
      await fs.writeFile(path.join(articleDir, '0.mp3'), 'audio');
      await fs.writeFile(path.join(articleDir, '0.json'), '{}');

      await deleteArticleCache(99);

      const exists = await fs
        .access(articleDir)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });

    it('is a no-op for missing cache', async () => {
      // Should not throw
      await expect(deleteArticleCache(999)).resolves.toBeUndefined();
    });
  });

  describe('getCacheStats', () => {
    it('returns zeros for empty cache', async () => {
      const stats = await getCacheStats();
      expect(stats).toEqual({ totalSize: 0, articleCount: 0, oldestAccess: null });
    });

    it('returns correct stats for populated cache', async () => {
      // Create two article cache directories
      const dir1 = path.join(testCacheDir, '1');
      const dir2 = path.join(testCacheDir, '2');
      await fs.mkdir(dir1, { recursive: true });
      await fs.mkdir(dir2, { recursive: true });

      const audioData = Buffer.alloc(1000);
      await fs.writeFile(path.join(dir1, '0.mp3'), audioData);
      await fs.writeFile(path.join(dir2, '0.mp3'), audioData);

      const stats = await getCacheStats();
      expect(stats.articleCount).toBe(2);
      expect(stats.totalSize).toBe(2000);
      expect(stats.oldestAccess).toBeTruthy();
    });
  });

  describe('evictIfNeeded', () => {
    it('evicts oldest articles when over limit', async () => {
      // Create articles that exceed the 1 MB test limit
      const bigData = Buffer.alloc(600 * 1024); // 600 KB each

      const dir1 = path.join(testCacheDir, '1');
      const dir2 = path.join(testCacheDir, '2');
      await fs.mkdir(dir1, { recursive: true });
      await fs.mkdir(dir2, { recursive: true });

      // dir1 is older
      await fs.writeFile(path.join(dir1, '0.mp3'), bigData);
      const pastDate = new Date(Date.now() - 100000);
      await fs.utimes(dir1, pastDate, pastDate);

      // dir2 is newer
      await fs.writeFile(path.join(dir2, '0.mp3'), bigData);

      await evictIfNeeded();

      // dir1 (oldest) should be evicted, dir2 should remain
      const dir1Exists = await fs
        .access(dir1)
        .then(() => true)
        .catch(() => false);
      const dir2Exists = await fs
        .access(dir2)
        .then(() => true)
        .catch(() => false);
      expect(dir1Exists).toBe(false);
      expect(dir2Exists).toBe(true);
    });

    it('is a no-op when under limit', async () => {
      const dir1 = path.join(testCacheDir, '1');
      await fs.mkdir(dir1, { recursive: true });
      await fs.writeFile(path.join(dir1, '0.mp3'), Buffer.alloc(100));

      await evictIfNeeded();

      const exists = await fs
        .access(dir1)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });
  });
});
