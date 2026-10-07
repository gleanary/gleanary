import { NextRequest, NextResponse } from 'next/server';
import { eq, count } from 'drizzle-orm';
import { db } from '@/db';
import { voiceProfile, voiceSamples } from '@/db/schema';
import { extractVoiceProfileSchema } from '@/lib/validators';
import { extractVoiceProfile } from '@/lib/voice-extraction';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';

const MIN_SAMPLES = 3;

/**
 * POST /api/voice/profile/extract — Generate a voice profile from writing samples using Claude.
 * Requires at least 3 samples. Returns 409 if manual edits exist and force=false.
 * @param req - NextRequest with JSON body { force?: boolean }
 */
export const POST = withRoute('POST /api/voice/profile/extract', async (req: NextRequest) => {
  const body = await req.json();
  const { force } = extractVoiceProfileSchema.parse(body);

  const existing = db.select().from(voiceProfile).where(eq(voiceProfile.userId, 1)).get();

  if (existing?.manualEditsAt && !force) {
    return NextResponse.json(
      {
        error: 'Profile has manual edits. Set force=true to overwrite.',
        manualEditsAt: existing.manualEditsAt,
      },
      { status: 409 },
    );
  }

  const currentSampleCount = existing
    ? (db
        .select({ count: count() })
        .from(voiceSamples)
        .where(eq(voiceSamples.profileId, existing.id))
        .get()?.count ?? 0)
    : 0;

  if (currentSampleCount < MIN_SAMPLES) {
    return NextResponse.json(
      {
        error: `At least ${MIN_SAMPLES} writing samples are required for extraction.`,
        currentCount: currentSampleCount,
      },
      { status: 422 },
    );
  }

  // existing is guaranteed non-null here: if it were null, currentSampleCount would be 0
  // and the < MIN_SAMPLES guard above would have returned early.
  const samples = db
    .select()
    .from(voiceSamples)
    .where(eq(voiceSamples.profileId, existing!.id))
    .all();

  const { profile: profileText, tokensUsed } = await extractVoiceProfile(samples);

  const now = new Date().toISOString();
  let updated;
  if (existing) {
    updated = db
      .update(voiceProfile)
      .set({
        profile: profileText,
        extractedAt: now,
        sampleCount: currentSampleCount,
        manualEditsAt: null,
        updatedAt: now,
      })
      .where(eq(voiceProfile.id, existing.id))
      .returning()
      .get();
  } else {
    updated = db
      .insert(voiceProfile)
      .values({
        userId: 1,
        profile: profileText,
        extractedAt: now,
        sampleCount: currentSampleCount,
        updatedAt: now,
      })
      .returning()
      .get();
  }

  logger.info(
    { event: 'voice_profile_extracted', sampleCount: currentSampleCount, tokensUsed },
    'Voice profile extracted',
  );
  return NextResponse.json({ profile: updated, tokensUsed });
});
