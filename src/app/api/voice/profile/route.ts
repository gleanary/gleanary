import { NextRequest, NextResponse } from 'next/server';
import { eq, count } from 'drizzle-orm';
import { db } from '@/db';
import { voiceProfile, voiceSamples } from '@/db/schema';
import { updateVoiceProfileSchema } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';

function getOrNull() {
  return db.select().from(voiceProfile).where(eq(voiceProfile.userId, 1)).get() ?? null;
}

function sampleCount(profileId: number): number {
  const row = db
    .select({ count: count() })
    .from(voiceSamples)
    .where(eq(voiceSamples.profileId, profileId))
    .get();
  return row?.count ?? 0;
}

/**
 * GET /api/voice/profile — Returns the current voice profile and sample count.
 */
export const GET = withRoute('GET /api/voice/profile', async (_req: NextRequest) => {
  const profile = getOrNull();
  return NextResponse.json({ profile, sampleCount: profile ? sampleCount(profile.id) : 0 });
});

/**
 * PUT /api/voice/profile — Create or update the voice profile text (manual edit).
 * Sets manualEditsAt to the current timestamp.
 * @param req - NextRequest with JSON body { profile: string }
 */
export const PUT = withRoute('PUT /api/voice/profile', async (req: NextRequest) => {
  const body = await req.json();
  const { profile: profileText } = updateVoiceProfileSchema.parse(body);

  const now = new Date().toISOString();
  const existing = getOrNull();

  let updated;
  if (existing) {
    updated = db
      .update(voiceProfile)
      .set({ profile: profileText, manualEditsAt: now, updatedAt: now })
      .where(eq(voiceProfile.id, existing.id))
      .returning()
      .get();
  } else {
    updated = db
      .insert(voiceProfile)
      .values({ userId: 1, profile: profileText, manualEditsAt: now, updatedAt: now })
      .returning()
      .get();
  }

  logger.info({ event: 'voice_profile_updated' }, 'Voice profile updated manually');
  return NextResponse.json({ profile: updated });
});
