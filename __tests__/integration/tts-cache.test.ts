import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

const testCacheDir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('node:path') as typeof import('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const o = require('node:os') as typeof import('node:os');
  return p.join(o.tmpdir(), `tts-cache-integration-${Date.now()}`);
});

vi.mock('@/config', () => ({
  config: {
    tts: {
      mock: true,
      cache: {
        enabled: true,
        dir: testCacheDir,
        maxSizeBytes: 5 * 1024 * 1024 * 1024,
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

import { GET as getCacheRoute } from '@/app/api/tts/cache/route';

describe('GET /api/tts/cache', () => {
  beforeEach(async () => {
    await fs.rm(testCacheDir, { recursive: true, force: true });
    await fs.mkdir(testCacheDir, { recursive: true });
  });

  it('returns stats for empty cache', async () => {
    const res = await getCacheRoute();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      totalSize: 0,
      articleCount: 0,
      oldestAccess: null,
    });
  });

  it('returns stats for populated cache', async () => {
    // Create a fake cached article
    const articleDir = path.join(testCacheDir, '42');
    await fs.mkdir(articleDir, { recursive: true });
    await fs.writeFile(path.join(articleDir, '0.mp3'), Buffer.alloc(500));
    await fs.writeFile(
      path.join(articleDir, '0.json'),
      JSON.stringify({ paragraphIndex: 0, words: [], startTimes: [], endTimes: [] }),
    );

    const res = await getCacheRoute();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.articleCount).toBe(1);
    expect(body.totalSize).toBeGreaterThan(0);
    expect(body.oldestAccess).toBeTruthy();
  });
});

describe('GET /api/tts/cache when disabled', () => {
  it('returns 503 when cache is disabled', async () => {
    // Temporarily disable cache
    const { config } = await import('@/config');
    const original = config.tts.cache.enabled;
    (config.tts.cache as { enabled: boolean }).enabled = false;

    try {
      const res = await getCacheRoute();
      expect(res.status).toBe(503);
    } finally {
      (config.tts.cache as { enabled: boolean }).enabled = original;
    }
  });
});
