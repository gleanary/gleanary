import 'server-only';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '@/config';
import { logger } from '@/lib/logger';
import { synthesizeArticle } from '@/lib/tts';
import { streamTTS } from '@/lib/inworld-client';
import { mockStreamTTS } from '@/lib/mock-tts';
import type {
  PreparedParagraph,
  TTSOptions,
  SynthesisEvent,
  TTSCacheMeta,
  TTSCacheParagraphData,
  TTSCacheStats,
} from '@/types';

/** Module-level guard to prevent concurrent eviction runs */
let evicting = false;

/**
 * Computes a cache key from TTS options so we invalidate when any option changes.
 * Uses JSON.stringify with sorted keys to produce a deterministic, collision-free key.
 * @param options - TTS synthesis options
 * @returns Deterministic string key
 */
function computeOptionsHash(options: TTSOptions): string {
  return JSON.stringify(options, Object.keys(options).sort());
}

/**
 * Returns the cache directory path for a given article.
 * @param articleId - Article ID
 * @returns Absolute path to the article's cache directory
 */
function articleCacheDir(articleId: number): string {
  return path.join(config.tts.cache.dir, String(articleId));
}

/**
 * Reads and validates the cache meta.json for an article directory.
 * Returns null if missing or if the options hash doesn't match.
 * @param articleDir - Path to the article cache directory
 * @param optionsHash - Expected options hash
 * @returns Cache meta or null
 */
async function readCacheMeta(
  articleDir: string,
  optionsHash: string,
): Promise<TTSCacheMeta | null> {
  const metaPath = path.join(articleDir, 'meta.json');
  try {
    const raw = await fs.readFile(metaPath, 'utf-8');
    const meta: TTSCacheMeta = JSON.parse(raw);
    if (meta.optionsHash !== optionsHash) return null;
    return meta;
  } catch {
    return null;
  }
}

/**
 * Writes audio and timestamp data for a single paragraph to disk.
 * Catches write errors (e.g. ENOSPC) and logs a warning instead of failing.
 * @param articleDir - Path to the article cache directory
 * @param paragraphIndex - Paragraph index
 * @param audioBuffer - Raw audio bytes
 * @param paragraphData - Word timestamp data
 */
async function writeParagraphCache(
  articleDir: string,
  paragraphIndex: number,
  audioBuffer: Buffer,
  paragraphData: TTSCacheParagraphData,
): Promise<void> {
  try {
    await Promise.all([
      fs.writeFile(path.join(articleDir, `${paragraphIndex}.mp3`), audioBuffer),
      fs.writeFile(path.join(articleDir, `${paragraphIndex}.json`), JSON.stringify(paragraphData)),
    ]);
  } catch (error) {
    logger.warn(
      { err: error, event: 'tts_cache_write_error', paragraphIndex },
      'Failed to write TTS cache file',
    );
  }
}

/**
 * Synthesizes an article with file-system caching.
 * For each paragraph, checks if cached audio exists on disk. If so, reads from
 * disk. Otherwise, calls the TTS API and writes the result to disk.
 * Yields the same SynthesisEvent types as synthesizeArticle().
 * @param articleId - Article ID for cache key
 * @param paragraphs - Prepared paragraphs to synthesize
 * @param options - TTS synthesis options
 * @param startIndex - Paragraph index to start from
 * @param signal - Optional AbortSignal to cancel
 * @returns AsyncGenerator of synthesis events
 */
export async function* cachedSynthesizeArticle(
  articleId: number,
  paragraphs: PreparedParagraph[],
  options: TTSOptions,
  startIndex: number,
  signal?: AbortSignal,
): AsyncGenerator<SynthesisEvent> {
  const articleDir = articleCacheDir(articleId);
  const optionsHash = computeOptionsHash(options);

  // Invalidate cache if options changed, then ensure directory exists.
  // Falls back to uncached synthesis if the cache directory is not writable.
  try {
    const meta = await readCacheMeta(articleDir, optionsHash);
    if (!meta) {
      await fs.rm(articleDir, { recursive: true, force: true });
    }
    await fs.mkdir(articleDir, { recursive: true });
  } catch (error) {
    logger.warn(
      { err: error, event: 'tts_cache_dir_error', articleId },
      'Cannot create cache directory, falling back to uncached synthesis',
    );
    yield* synthesizeArticle(paragraphs, options, startIndex, signal);
    return;
  }

  let wroteNewData = false;

  for (let i = startIndex; i < paragraphs.length; i++) {
    if (signal?.aborted) return;

    const paragraph = paragraphs[i]!;
    const mp3Path = path.join(articleDir, `${paragraph.index}.mp3`);
    const jsonPath = path.join(articleDir, `${paragraph.index}.json`);

    // Try serving from cache — read directly and handle ENOENT
    try {
      const [audioBuffer, jsonRaw] = await Promise.all([
        fs.readFile(mp3Path),
        fs.readFile(jsonPath, 'utf-8'),
      ]);
      const cached: TTSCacheParagraphData = JSON.parse(jsonRaw);

      yield {
        type: 'chunk',
        data: {
          paragraphIndex: paragraph.index,
          audioContent: audioBuffer.toString('base64'),
          words: cached.words,
          startTimes: cached.startTimes,
          endTimes: cached.endTimes,
        },
      };
      yield { type: 'paragraph-complete', paragraphIndex: paragraph.index };
      continue;
    } catch (error) {
      // ENOENT means cache miss — fall through to synthesis
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(
          { err: error, event: 'tts_cache_read_error', paragraphIndex: paragraph.index },
          'Failed to read cached TTS, falling back to synthesis',
        );
      }
    }

    // Not cached — synthesize and write to cache
    const useMock = config.tts.mock;
    const stream = useMock
      ? mockStreamTTS(paragraph.text)
      : streamTTS(paragraph.text, options, signal);

    const audioChunks: Buffer[] = [];
    const allWords: string[] = [];
    const allStartTimes: number[] = [];
    const allEndTimes: number[] = [];

    for await (const chunk of stream) {
      audioChunks.push(Buffer.from(chunk.audioContent, 'base64'));
      allWords.push(...chunk.words);
      allStartTimes.push(...chunk.wordStartTimes);
      allEndTimes.push(...chunk.wordEndTimes);

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

    // Write to cache (best-effort, non-blocking to avoid stalling the SSE stream)
    const combinedAudio = Buffer.concat(audioChunks);
    const paragraphData: TTSCacheParagraphData = {
      paragraphIndex: paragraph.index,
      words: allWords,
      startTimes: allStartTimes,
      endTimes: allEndTimes,
    };
    void writeParagraphCache(articleDir, paragraph.index, combinedAudio, paragraphData);
    wroteNewData = true;

    yield { type: 'paragraph-complete', paragraphIndex: paragraph.index };
  }

  // Touch directory mtime for LRU tracking; write meta.json only if new data was cached
  try {
    const now = new Date();
    await fs.utimes(articleDir, now, now);
    if (wroteNewData) {
      const cacheMeta: TTSCacheMeta = {
        totalParagraphs: paragraphs.length,
        optionsHash,
      };
      await fs.writeFile(path.join(articleDir, 'meta.json'), JSON.stringify(cacheMeta));
    }
  } catch (error) {
    logger.warn({ err: error, event: 'tts_cache_meta_error' }, 'Failed to update cache metadata');
  }

  if (wroteNewData) {
    void evictIfNeeded();
  }
}

/**
 * Deletes the TTS cache directory for an article. No-op if it doesn't exist.
 * @param articleId - Article ID whose cache to delete
 */
export async function deleteArticleCache(articleId: number): Promise<void> {
  const dir = articleCacheDir(articleId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    logger.info({ event: 'tts_cache_deleted', articleId }, 'Deleted TTS cache for article');
  } catch (error) {
    logger.warn(
      { err: error, event: 'tts_cache_delete_error', articleId },
      'Failed to delete TTS cache',
    );
  }
}

/**
 * Computes the total size of all files in a directory (non-recursive for one level).
 * @param dirPath - Directory to measure
 * @returns Total size in bytes
 */
async function dirSize(dirPath: string): Promise<number> {
  const entries = await fs.readdir(dirPath);
  let total = 0;
  for (const entry of entries) {
    const stat = await fs.stat(path.join(dirPath, entry));
    if (stat.isFile()) total += stat.size;
  }
  return total;
}

/**
 * Returns TTS cache statistics: total size, article count, and oldest access time.
 * @returns Cache stats object
 */
export async function getCacheStats(): Promise<TTSCacheStats> {
  const cacheDir = config.tts.cache.dir;

  try {
    const entries = await fs.readdir(cacheDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());

    if (dirs.length === 0) {
      return { totalSize: 0, articleCount: 0, oldestAccess: null };
    }

    const dirInfos = await Promise.all(
      dirs.map(async (dir) => {
        const dirPath = path.join(cacheDir, dir.name);
        const [stat, size] = await Promise.all([fs.stat(dirPath), dirSize(dirPath)]);
        return { mtimeMs: stat.mtimeMs, size };
      }),
    );

    const totalSize = dirInfos.reduce((sum, d) => sum + d.size, 0);
    const oldestMtime = Math.min(...dirInfos.map((d) => d.mtimeMs));

    return {
      totalSize,
      articleCount: dirs.length,
      oldestAccess: new Date(oldestMtime).toISOString(),
    };
  } catch (error) {
    // Cache dir doesn't exist yet
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { totalSize: 0, articleCount: 0, oldestAccess: null };
    }
    throw error;
  }
}

/**
 * Evicts least-recently-accessed article cache directories until total size
 * is under the configured maximum. Prevents concurrent eviction runs.
 */
export async function evictIfNeeded(): Promise<void> {
  if (evicting) return;
  evicting = true;

  try {
    const cacheDir = config.tts.cache.dir;
    const maxSize = config.tts.cache.maxSizeBytes;

    const entries = await fs.readdir(cacheDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());

    // Gather size and mtime for each article cache directory in parallel
    const dirInfos = await Promise.all(
      dirs.map(async (dir) => {
        const dirPath = path.join(cacheDir, dir.name);
        const [stat, size] = await Promise.all([fs.stat(dirPath), dirSize(dirPath)]);
        return { name: dir.name, size, mtimeMs: stat.mtimeMs };
      }),
    );
    let totalSize = dirInfos.reduce((sum, d) => sum + d.size, 0);

    if (totalSize <= maxSize) return;

    // Sort by mtime ascending (oldest first) for LRU eviction
    dirInfos.sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const info of dirInfos) {
      if (totalSize <= maxSize) break;

      const dirPath = path.join(cacheDir, info.name);
      await fs.rm(dirPath, { recursive: true, force: true });
      totalSize -= info.size;

      logger.info(
        {
          event: 'tts_cache_evicted',
          articleId: info.name,
          freedBytes: info.size,
          remainingSize: totalSize,
        },
        'Evicted TTS cache for LRU article',
      );
    }
  } catch (error) {
    logger.warn({ err: error, event: 'tts_cache_eviction_error' }, 'Cache eviction failed');
  } finally {
    evicting = false;
  }
}
