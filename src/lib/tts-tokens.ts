/**
 * Shared, client-safe helpers for TTS word tokens.
 *
 * Inworld returns whitespace and punctuation as their own word tokens (e.g.
 * `["Building", " ", "better"]`, `[", "]`, `[""]`). Both the player hook and the
 * DOM word highlighter must agree on what counts as a spoken word so that word
 * indices line up.
 */

const SPOKEN_CHAR = /[\p{L}\p{N}]/u;

/**
 * Whether a token is a spoken word (contains at least one letter or digit).
 * @param token - A TTS word token or a whitespace-split DOM text part
 * @returns true for words like "Hi," or "2026", false for "", " ", ", " or "—"
 */
export function isSpokenToken(token: string): boolean {
  return SPOKEN_CHAR.test(token);
}
