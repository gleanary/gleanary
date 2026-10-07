/**
 * Builds a safe HTML snippet from FTS5 snippet() output using sentinel bytes.
 *
 * Pipeline (spec §6.1 — DO NOT REORDER STEPS):
 *   1. FTS5 snippet() is called with \x01/\x02 as open/close sentinels (not HTML).
 *   2. HTML-escape the entire raw string (&, <, >, ", ').
 *   3. Replace sentinels with <mark>/</mark>.
 *
 * Steps 2 and 3 must never be swapped. Step 2 must run first so that any <, >, &
 * characters in the stored text are neutralised before <mark> tags are inserted.
 * Note: \x01/\x02 are NOT stripped at ingestion — the escape-first ordering is the
 * only safety control. A literal sentinel byte surviving in stored text can therefore
 * only ever yield a bare, attribute-less <mark>/</mark> tag, never script or attributes.
 * The resulting string is safe for dangerouslySetInnerHTML (no HTML other than <mark>).
 * @param raw - Raw snippet string from FTS5 containing \x01/\x02 sentinel bytes
 * @returns HTML-safe snippet string with only <mark> tags
 */
export function buildSnippet(raw: string): string {
  const escaped = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return escaped.replace(/\x01/g, '<mark>').replace(/\x02/g, '</mark>');
}
