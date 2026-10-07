import { computeWordCount } from '@/lib/text-utils';
import type { PreparedParagraph, WordPosition } from '@/types';

const MAX_CHUNK_LENGTH = 2000;

/** Regex to extract text content from block-level HTML elements */
const BLOCK_REGEX =
  /<(?:p|h[1-6]|li|blockquote|figcaption|pre|td|th)\b[^>]*>([\s\S]*?)<\/(?:p|h[1-6]|li|blockquote|figcaption|pre|td|th)>/gi;

/**
 * Prepares article plain text for TTS synthesis.
 * Splits into paragraphs, cleans whitespace, and enforces the 2000-char limit.
 * @param contentText - Plain text content of the article
 * @returns Array of prepared paragraphs ready for TTS
 */
export function prepareArticleForTTS(contentText: string): PreparedParagraph[] {
  const rawParagraphs = contentText.split(/\n\n+/);
  const result: PreparedParagraph[] = [];

  for (const raw of rawParagraphs) {
    const trimmed = raw.replace(/\s+/g, ' ').trim();
    if (!trimmed) continue;

    if (trimmed.length <= MAX_CHUNK_LENGTH) {
      result.push({
        index: result.length,
        text: trimmed,
        wordCount: computeWordCount(trimmed),
      });
    } else {
      // Split at sentence boundaries
      for (const chunk of splitAtSentences(trimmed, MAX_CHUNK_LENGTH)) {
        result.push({
          index: result.length,
          text: chunk,
          wordCount: computeWordCount(chunk),
        });
      }
    }
  }

  return result;
}

/**
 * Prepares article HTML for TTS synthesis by extracting text from block elements.
 * This ensures TTS paragraphs align 1:1 with DOM blocks for accurate word highlighting.
 * Falls back to plain-text splitting if HTML has no block elements.
 * @param contentHtml - Sanitized HTML content of the article
 * @param contentText - Plain text fallback
 * @returns Array of prepared paragraphs ready for TTS
 */
export function prepareArticleFromHtml(
  contentHtml: string,
  contentText: string,
): PreparedParagraph[] {
  if (!contentHtml?.trim()) {
    return prepareArticleForTTS(contentText);
  }

  const result: PreparedParagraph[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state for each call
  BLOCK_REGEX.lastIndex = 0;
  while ((match = BLOCK_REGEX.exec(contentHtml)) !== null) {
    const innerHtml = match[1] ?? '';
    // Strip nested tags, decode entities, normalize whitespace
    const text = stripHtmlTags(innerHtml).replace(/\s+/g, ' ').trim();
    if (!text) continue;

    if (text.length <= MAX_CHUNK_LENGTH) {
      result.push({
        index: result.length,
        text,
        wordCount: computeWordCount(text),
      });
    } else {
      for (const chunk of splitAtSentences(text, MAX_CHUNK_LENGTH)) {
        result.push({
          index: result.length,
          text: chunk,
          wordCount: computeWordCount(chunk),
        });
      }
    }
  }

  return result.length > 0 ? result : prepareArticleForTTS(contentText);
}

/**
 * Strips HTML tags and decodes common HTML entities from a string.
 * @param html - HTML string to strip
 * @returns Plain text content
 */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&apos;/g, "'");
}

/**
 * Detects the primary language of a text using French stop-word frequency.
 * @param text - Text to analyze
 * @returns ISO 639-1 language code ('en' or 'fr')
 */
export function detectLanguage(text: string): string {
  if (!text.trim()) return 'en';

  // Sample first 1000 words for performance
  const words = text.split(/\s+/).slice(0, 1000);
  if (words.length === 0) return 'en';

  const frenchStopWords =
    /^(le|la|les|des|une|un|est|dans|pour|avec|sur|que|qui|pas|son|ses|sont|ont|aux|du|au|ce|cette|ces|ou|et|en|de|il|elle|nous|vous|ils|elles|leur|leurs|se|sa|mon|ton|mais|donc|car|ni|ne|si|tout|plus|moins|très|aussi|bien|peu|trop|rien|fait|été|être|avoir|comme|quand|où)$/i;

  let frenchCount = 0;
  for (const word of words) {
    if (frenchStopWords.test(word)) frenchCount++;
  }

  // If more than 10% of words are French stop words, classify as French
  return frenchCount > words.length * 0.1 ? 'fr' : 'en';
}

/**
 * Maps TTS-returned words to character offsets in the original paragraph text.
 * Uses a greedy forward scan to handle whitespace/punctuation differences.
 * @param paragraphText - Original paragraph text
 * @param ttsWords - Words returned by the TTS API
 * @returns Array of word positions with character offsets
 */
export function mapWordsToDOM(paragraphText: string, ttsWords: string[]): WordPosition[] {
  if (!ttsWords.length || !paragraphText) return [];

  const positions: WordPosition[] = [];
  let searchFrom = 0;

  for (const word of ttsWords) {
    // Find the word in the text starting from current position
    const idx = findWordInText(paragraphText, word, searchFrom);
    if (idx === -1) continue;

    positions.push({
      word,
      startOffset: idx,
      endOffset: idx + word.length,
    });
    searchFrom = idx + word.length;
  }

  return positions;
}

/**
 * Finds a word in text starting from a given offset, tolerating quote characters.
 */
function findWordInText(text: string, word: string, from: number): number {
  // Direct match first
  const directIdx = text.indexOf(word, from);
  if (directIdx !== -1) return directIdx;

  // Try stripping common quote characters from both sides
  const stripped = word.replace(/^["""''`]+|["""''`]+$/g, '');
  if (stripped !== word && stripped.length > 0) {
    const strippedIdx = text.indexOf(stripped, from);
    if (strippedIdx !== -1) return strippedIdx;
  }

  return -1;
}

/** Splits text at sentence boundaries to fit within maxLength */
function splitAtSentences(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    // Find the last sentence boundary within the limit
    const slice = remaining.slice(0, maxLength);
    const lastPeriod = Math.max(
      slice.lastIndexOf('. '),
      slice.lastIndexOf('! '),
      slice.lastIndexOf('? '),
    );

    if (lastPeriod > maxLength * 0.3) {
      // Split at the sentence boundary (include the punctuation)
      chunks.push(remaining.slice(0, lastPeriod + 1).trim());
      remaining = remaining.slice(lastPeriod + 1).trim();
    } else {
      // No good sentence boundary; split at last space
      const lastSpace = slice.lastIndexOf(' ');
      if (lastSpace > 0) {
        chunks.push(remaining.slice(0, lastSpace).trim());
        remaining = remaining.slice(lastSpace).trim();
      } else {
        // No space at all; hard cut
        chunks.push(remaining.slice(0, maxLength));
        remaining = remaining.slice(maxLength);
      }
    }
  }

  if (remaining.trim()) {
    chunks.push(remaining.trim());
  }

  return chunks;
}
