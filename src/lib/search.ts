/**
 * Escapes user input for safe use in SQLite FTS5 queries.
 * Removes special FTS5 syntax characters that could alter query semantics.
 * @param query - Raw user search input
 * @returns Escaped string safe for FTS5 MATCH
 */
export function escapeFts5Query(query: string): string {
  return query
    .replace(/"/g, '""')
    .replace(/[*():^{}[\]]/g, ' ')
    .trim();
}

/**
 * Appends a prefix-match wildcard to the last token of an already-escaped FTS5 query.
 * Must be called AFTER escapeFts5Query() — never on raw user input.
 *
 * escapeFts5Query() produces plain whitespace-separated tokens with no wrapping quotes,
 * so * appends cleanly to the last token regardless of its content (spec §6.2).
 * @param escaped - Output of escapeFts5Query()
 * @returns Query with * appended to the last token, or empty string if input is empty
 */
export function applyPrefixStar(escaped: string): string {
  const trimmed = escaped.trim();
  if (!trimmed) return trimmed;
  const tokens = trimmed.split(/\s+/);
  tokens[tokens.length - 1] += '*';
  return tokens.join(' ');
}
