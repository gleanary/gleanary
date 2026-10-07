import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { voiceSamples } from '@/db/schema';
import { updateVoiceSampleSchema, parseIdParam } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { NotFoundError } from '@/lib/errors';
import type { RouteContext } from '@/types';

/**
 * PATCH /api/voice/samples/[id] — Update sample title and/or channelHint.
 * Content is immutable after creation.
 */
export const PATCH = withRoute(
  'PATCH /api/voice/samples/[id]',
  async (req: NextRequest, context: RouteContext) => {
    const sampleId = await parseIdParam(context);
    const body = await req.json();
    const updates = updateVoiceSampleSchema.parse(body);

    const existing = db.select().from(voiceSamples).where(eq(voiceSamples.id, sampleId)).get();
    if (!existing) {
      throw new NotFoundError('Sample', sampleId);
    }

    const patch: Partial<typeof voiceSamples.$inferInsert> = {};
    if (updates.title !== undefined) patch.title = updates.title;
    if ('channelHint' in updates) patch.channelHint = updates.channelHint;

    const updated = db
      .update(voiceSamples)
      .set(patch)
      .where(eq(voiceSamples.id, sampleId))
      .returning()
      .get();

    logger.info({ event: 'voice_sample_updated', sampleId }, 'Voice sample updated');
    return NextResponse.json({ sample: updated });
  },
);

/**
 * DELETE /api/voice/samples/[id] — Remove a writing sample.
 */
export const DELETE = withRoute(
  'DELETE /api/voice/samples/[id]',
  async (_req: NextRequest, context: RouteContext) => {
    const sampleId = await parseIdParam(context);

    const result = db.delete(voiceSamples).where(eq(voiceSamples.id, sampleId)).run();
    if (result.changes === 0) {
      throw new NotFoundError('Sample', sampleId);
    }

    logger.info({ event: 'voice_sample_deleted', sampleId }, 'Voice sample deleted');
    return NextResponse.json({ deleted: true });
  },
);
