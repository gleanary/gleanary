import { NextRequest, NextResponse } from 'next/server';
import { handleApiError } from '@/lib/api-error-handler';
import { logger } from '@/lib/logger';
import { getConfig } from '@/lib/settings';
import { startReadwiseImportSchema } from '@/lib/validators';
import { runReadwiseImport } from '@/lib/readwise-import';
import { sseEvent, SSE_HEADERS } from '@/lib/sse';

/**
 * POST /api/import/readwise — Start a Readwise import, streamed as SSE.
 * Query param: mode ('full' | 'incremental', default: 'full')
 */
export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const { mode } = startReadwiseImportSchema.parse({
      mode: searchParams.get('mode') ?? undefined,
    });

    const token = getConfig('readwise_api_token');
    if (!token) {
      return NextResponse.json(
        { error: 'Readwise API token is not configured. Add it in Settings.' },
        { status: 503 },
      );
    }

    logger.info({ event: 'readwise_import_started', mode }, 'Readwise import started');

    const stream = new ReadableStream({
      async start(controller) {
        try {
          await runReadwiseImport(token, mode, (event, data) => {
            controller.enqueue(sseEvent(event, data));
          });
        } catch (err) {
          logger.error({ err, event: 'readwise_import_error' }, 'Readwise import failed');
          controller.enqueue(
            sseEvent('error', {
              message: err instanceof Error ? err.message : 'Import failed',
            }),
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: SSE_HEADERS,
    });
  } catch (error) {
    return handleApiError(error, 'POST /api/import/readwise');
  }
}
