import { NextResponse } from 'next/server';
import { config } from '@/config';
import { getCacheStats } from '@/lib/tts-cache';
import { logger } from '@/lib/logger';
import { handleApiError } from '@/lib/api-error-handler';

/**
 * GET /api/tts/cache — Returns TTS cache statistics.
 * @returns { totalSize, articleCount, oldestAccess }
 */
export async function GET() {
  if (!config.tts.cache.enabled) {
    return NextResponse.json({ error: 'TTS cache is disabled' }, { status: 503 });
  }

  try {
    const stats = await getCacheStats();
    return NextResponse.json(stats);
  } catch (error) {
    logger.error({ err: error, event: 'tts_cache_stats_error' }, 'Failed to get cache stats');
    return handleApiError(error, 'GET /api/tts/cache');
  }
}
