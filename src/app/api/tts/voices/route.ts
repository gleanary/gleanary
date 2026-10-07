import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { ttsVoicesSchema } from '@/lib/validators';
import { listVoices } from '@/lib/inworld-client';
import { getConfig } from '@/lib/settings';

/**
 * GET /api/tts/voices
 * Returns available TTS voices, optionally filtered by language.
 */
export const GET = withRoute('GET /api/tts/voices', async (req: NextRequest) => {
  if (!getConfig('inworld_api_key')) {
    return NextResponse.json({ error: 'TTS not configured' }, { status: 503 });
  }

  const params = ttsVoicesSchema.parse(Object.fromEntries(req.nextUrl.searchParams));

  const voices = await listVoices(params.language);

  logger.info(
    { event: 'tts_voices_listed', count: voices.length, language: params.language },
    'Listed TTS voices',
  );

  return NextResponse.json({ voices });
});
