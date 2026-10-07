import { rawDb } from '@/db';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export function GET() {
  try {
    const result = rawDb.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;

    return Response.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      db: result?.ok === 1 ? 'connected' : 'error',
    });
  } catch (error) {
    logger.error({ err: error, route: 'GET /api/health' }, 'Health check failed');

    return Response.json({ status: 'error', message: 'Database unavailable' }, { status: 503 });
  }
}
