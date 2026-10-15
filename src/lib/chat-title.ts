import { callClaude } from '@/lib/ai';
import type { TrackingContext } from '@/lib/ai-usage';
import { UTILITY_MODEL } from '@/lib/models';
import { logger } from '@/lib/logger';

const TITLE_SYSTEM_PROMPT =
  "You label chat conversations. You will receive the user's first message inside <message> tags. " +
  'Do NOT answer, respond to, or comment on it. Write a 3-8 word title describing its topic. ' +
  'Output only the title: no quotes, no trailing punctuation.';

const TITLE_MAX_TOKENS = 30;
const MAX_INPUT_CHARS = 500;
const MAX_TITLE_CHARS = 80;
const MAX_TITLE_WORDS = 12;
const FALLBACK_MAX_CHARS = 60;
const DEFAULT_TITLE = 'New chat';
/** Openers of a conversational reply (word-bounded so titles like "I Ching" or "Surety" pass). */
const ANSWER_OPENER =
  /^(I(['’]m|\s+(am|don['’]t|do not|can['’]?t|cannot|can|have|would|will))\b|Sorry\b|As an AI\b|Sure\b|Here(['’]s|\s+(is|are))\b)/i;

/** Collapses all whitespace runs (including newlines) to single spaces. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Cleans raw model output into a candidate title (first line, no wrappers). */
function sanitizeTitle(raw: string): string {
  const firstLine = raw.trim().split('\n')[0] ?? '';
  return collapseWhitespace(firstLine)
    .replace(/^title\s*:\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.:;!]+$/, '')
    .trim();
}

/** True when the cleaned output looks like a short title, not an answer. */
function isValidTitle(title: string): boolean {
  return (
    title.length > 0 &&
    title.length <= MAX_TITLE_CHARS &&
    title.split(' ').length <= MAX_TITLE_WORDS &&
    !ANSWER_OPENER.test(title)
  );
}

/** Derives a one-line title from the user's message, cut at a word boundary. */
function fallbackTitle(message: string): string {
  const oneLine = collapseWhitespace(message);
  if (!oneLine) return DEFAULT_TITLE;
  if (oneLine.length <= FALLBACK_MAX_CHARS) return oneLine;
  const cut = oneLine.slice(0, FALLBACK_MAX_CHARS + 1);
  const lastSpace = cut.lastIndexOf(' ');
  // No space to cut at: slice by code point so an emoji/surrogate pair is never split.
  const head =
    lastSpace > 0
      ? cut.slice(0, lastSpace)
      : Array.from(oneLine).slice(0, FALLBACK_MAX_CHARS).join('');
  return `${head.trimEnd()}…`;
}

/**
 * Generates a short chat session title from the user's first message.
 * Only the user's message is sent (never the assistant reply), so the model labels
 * the topic instead of continuing the conversation. Output that is empty, too long,
 * or reads like an answer is rejected; on rejection or API failure the title is
 * derived from the message itself.
 * @param firstUserMessage - The first user message of the session
 * @param ctx - AI usage tracking context (feature 'chat_title_generation')
 * @returns A short single-line title; never throws
 */
export async function generateChatTitle(
  firstUserMessage: string,
  ctx: TrackingContext,
): Promise<string> {
  try {
    const raw = await callClaude(
      TITLE_SYSTEM_PROMPT,
      `<message>\n${firstUserMessage.slice(0, MAX_INPUT_CHARS)}\n</message>`,
      ctx,
      UTILITY_MODEL,
      TITLE_MAX_TOKENS,
    );
    const title = sanitizeTitle(raw);
    if (isValidTitle(title)) return title;
    logger.warn(
      { event: 'chat_title_rejected', resourceId: ctx.resourceId, length: raw.length },
      'Generated chat title rejected, using fallback',
    );
  } catch (err) {
    logger.warn(
      { err, event: 'chat_title_failed', resourceId: ctx.resourceId },
      'Auto-title generation failed, using fallback',
    );
  }
  return fallbackTitle(firstUserMessage);
}
