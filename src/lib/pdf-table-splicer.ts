/**
 * Splices Mistral OCR HTML tables into page markdown at their positional markers.
 *
 * Mistral embeds markers like `[tbl-2.html](tbl-2.html)` in the markdown field where
 * each table appears. The actual HTML is in `table.html`.
 * Tables with no marker found are appended at the end as a fallback.
 *
 * @param markdown - Page markdown content
 * @param tables - Tables from Mistral page response (table_format: 'html')
 * @returns Markdown with table HTML spliced in at marker positions
 */
export function appendPageTables(
  markdown: string,
  tables: Array<{ id: string; html: string }> | null | undefined,
): string {
  if (!tables?.length) return markdown;

  const tableMap = new Map(tables.map((t) => [t.id, t.html]));
  const unplaced = new Set(tableMap.keys());

  // Replace both link and image-link variants. Mistral uses table IDs like "tbl-0.html"
  // (the .html suffix is part of the ID), so capture the full href as the lookup key.
  let result = markdown.replace(/!?\[[^\]]*\]\((tbl-\d+\.html)\)/g, (_, id) => {
    const html = tableMap.get(id);
    if (!html) return _;
    unplaced.delete(id);
    return html;
  });

  // Append any tables whose markers weren't found in the markdown
  for (const id of unplaced) {
    result += '\n\n' + tableMap.get(id);
  }

  return result;
}
