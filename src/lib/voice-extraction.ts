import { callClaudeStreaming } from '@/lib/ai';
import { DEFAULT_FEATURE_MODEL } from '@/lib/models';
import { computeWordCount } from '@/lib/text-utils';
import type { VoiceSample } from '@/types';

export { computeWordCount };

const MODEL = DEFAULT_FEATURE_MODEL;

/** Maximum total character length of all samples before truncating longest ones */
const MAX_SAMPLES_CHARS = 80_000;

export const VOICE_PROFILE_PROMPT =
  `You are a writing style analyst. Analyze the following writing samples from a single ` +
  `author and produce a structured voice profile.\n\n` +
  `IMPORTANT RULES:\n` +
  `- Extract patterns at their NATURAL FREQUENCY. If analogies appear in 1 of every ` +
  `3 paragraphs, that's the target — do not amplify distinctive features.\n` +
  `- Include specific quoted evidence from the samples for every dimension.\n` +
  `- The profile must be CHANNEL-AGNOSTIC. Do not mention post length, section headers, ` +
  `emoji, platform conventions, or any format-dependent pattern. Describe HOW the author ` +
  `thinks and expresses, not how they format.\n` +
  `- Focus on what makes this author's writing distinguishable from generic AI output.\n` +
  `- Note anti-patterns (things the author never does) — these are as important as ` +
  `positive patterns.\n\n` +
  `Produce the profile using EXACTLY this structure:\n\n` +
  `## Rhythm & Sentence Structure\n` +
  `[Sentence length distribution and variation, fragments, paragraph tendencies]\n` +
  `> Evidence: "quoted phrase"\n\n` +
  `## Vocabulary & Register\n` +
  `[Technical density, formality, signature phrases, preferred/avoided words]\n` +
  `> Evidence: "quoted phrase"\n\n` +
  `## Argument Construction\n` +
  `[How cases are built: claim-first, narrative, Socratic, evidence marshaling]\n` +
  `> Evidence: "quoted phrase"\n\n` +
  `## Opening Patterns\n` +
  `[Hook strategies with frequency]\n` +
  `> Evidence: "quoted phrase"\n\n` +
  `## Closing Patterns\n` +
  `[Landing strategies with frequency]\n` +
  `> Evidence: "quoted phrase"\n\n` +
  `## Rhetorical Devices\n` +
  `[Devices used with natural frequency noted]\n` +
  `> Evidence: "quoted phrase"\n\n` +
  `## Tone & Confidence\n` +
  `[Confidence level, humor, formality shifts, emotional register]\n` +
  `> Evidence: "quoted phrase"\n\n` +
  `## Anti-Patterns\n` +
  `[Things the author avoids — enforce strictly]\n` +
  `> Evidence: absence noted\n\n` +
  `TARGET LENGTH: 800–1,500 words.`;

/**
 * Assembles writing samples into the user message payload for extraction.
 * Truncates longest samples first if total exceeds MAX_SAMPLES_CHARS.
 * @param samples - Writing samples to include
 * @returns Formatted string with sample separators
 */
export function assembleSamplesPayload(samples: VoiceSample[]): string {
  let working: VoiceSample[] = samples.map((s) => ({ ...s }));
  const totalChars = () => working.reduce((sum, s) => sum + s.content.length, 0);

  while (totalChars() > MAX_SAMPLES_CHARS && working.length > 0) {
    let longestIdx = 0;
    for (let i = 1; i < working.length; i++) {
      if ((working[i]?.content.length ?? 0) > (working[longestIdx]?.content.length ?? 0)) {
        longestIdx = i;
      }
    }
    const target = working[longestIdx];
    if (!target) break;
    const excess = totalChars() - MAX_SAMPLES_CHARS;
    if (target.content.length <= excess) {
      working = working.filter((_, i) => i !== longestIdx);
    } else {
      const suffix = '\n[truncated]';
      const truncated = target.content.slice(0, target.content.length - excess - suffix.length);
      working[longestIdx] = { ...target, content: truncated + suffix };
    }
  }

  const parts = working.map((s, i) => `--- Sample ${i + 1}: ${s.title} ---\n\n${s.content}`);
  return `WRITING SAMPLES:\n\n${parts.join('\n\n')}`;
}

/**
 * Calls Claude Sonnet to extract a structured voice profile from writing samples.
 * @param samples - At least 3 writing samples
 * @returns Extracted profile markdown and total tokens used
 * @throws ExternalServiceError if the Claude API call fails
 */
export async function extractVoiceProfile(
  samples: VoiceSample[],
): Promise<{ profile: string; tokensUsed: number }> {
  const payload = assembleSamplesPayload(samples);
  const { text, usage } = await callClaudeStreaming({
    system: VOICE_PROFILE_PROMPT,
    messages: [{ role: 'user', content: payload }],
    model: MODEL,
    maxTokens: 4096,
    ctx: { feature: 'voice_extraction' },
    onText: () => {},
  });
  return { profile: text, tokensUsed: usage.inputTokens + usage.outputTokens };
}
