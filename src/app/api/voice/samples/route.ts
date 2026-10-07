import { NextRequest, NextResponse } from 'next/server';
import { eq, desc } from 'drizzle-orm';
import { db } from '@/db';
import { voiceProfile, voiceSamples } from '@/db/schema';
import { createVoiceSampleSchema } from '@/lib/validators';
import { computeWordCount } from '@/lib/voice-extraction';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';

function ensureProfileRow(): number {
  const existing = db.select().from(voiceProfile).where(eq(voiceProfile.userId, 1)).get();
  if (existing) return existing.id;
  const now = new Date().toISOString();
  const created = db
    .insert(voiceProfile)
    .values({ userId: 1, profile: '', updatedAt: now })
    .returning()
    .get();
  return created.id;
}

/**
 * GET /api/voice/samples — List all writing samples, newest first.
 */
export const GET = withRoute('GET /api/voice/samples', async (_req: NextRequest) => {
  const existing = db.select().from(voiceProfile).where(eq(voiceProfile.userId, 1)).get();
  if (!existing) {
    return NextResponse.json({ samples: [] });
  }
  const samples = db
    .select()
    .from(voiceSamples)
    .where(eq(voiceSamples.profileId, existing.id))
    .orderBy(desc(voiceSamples.createdAt))
    .all();
  return NextResponse.json({ samples });
});

/**
 * POST /api/voice/samples — Add a writing sample. Auto-creates the profile row if missing.
 * Word count is computed server-side from content.
 * @param req - NextRequest with JSON body { title, content, channelHint? }
 */
export const POST = withRoute('POST /api/voice/samples', async (req: NextRequest) => {
  const body = await req.json();
  const { title, content, channelHint } = createVoiceSampleSchema.parse(body);

  const profileId = ensureProfileRow();
  const wordCount = computeWordCount(content);

  const sample = db
    .insert(voiceSamples)
    .values({ profileId, title, content, wordCount, channelHint: channelHint ?? null })
    .returning()
    .get();

  logger.info({ event: 'voice_sample_created', sampleId: sample.id }, 'Voice sample added');
  return NextResponse.json({ sample }, { status: 201 });
});
