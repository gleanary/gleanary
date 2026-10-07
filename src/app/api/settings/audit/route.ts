import { NextRequest, NextResponse } from 'next/server';
import { withRoute } from '@/lib/api-error-handler';
import { listAuditSchema } from '@/lib/validators';
import { getRecentAuditEntries } from '@/lib/audit';

/**
 * GET /api/settings/audit — Returns recent audit log entries.
 */
export const GET = withRoute('GET /api/settings/audit', async (req: NextRequest) => {
  const url = new URL(req.url);
  const { limit } = listAuditSchema.parse({
    limit: url.searchParams.get('limit') ?? undefined,
  });

  const entries = getRecentAuditEntries(limit);
  return NextResponse.json({ entries });
});
