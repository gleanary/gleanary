import 'server-only';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { highlightTags, tags } from '@/db/schema';
import type { TagInfo } from '@/types';

/**
 * Fetches tags associated with a highlight.
 * @param highlightId - The highlight ID
 * @returns Array of tag objects with id, name, and color
 */
export function getHighlightTags(highlightId: number) {
  return db
    .select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
    })
    .from(highlightTags)
    .innerJoin(tags, eq(highlightTags.tagId, tags.id))
    .where(eq(highlightTags.highlightId, highlightId))
    .all();
}

/**
 * Replaces all tags on a highlight with the given tag IDs.
 * Deletes existing associations and creates new ones in a single batch.
 * @param highlightId - The highlight ID
 * @param tagIds - Array of tag IDs to associate
 */
export function replaceHighlightTags(highlightId: number, tagIds: number[]): void {
  db.delete(highlightTags).where(eq(highlightTags.highlightId, highlightId)).run();
  // Dedupe: a repeated tag id would violate the highlight_tags_unique index.
  const uniqueTagIds = [...new Set(tagIds)];
  if (uniqueTagIds.length > 0) {
    db.insert(highlightTags)
      .values(uniqueTagIds.map((tagId) => ({ highlightId, tagId })))
      .run();
  }
}

/**
 * Links tags to a highlight in a single batch insert.
 * Use for new highlights where no existing associations exist.
 * @param highlightId - The highlight ID
 * @param tagIds - Array of tag IDs to associate
 */
export function linkHighlightTags(highlightId: number, tagIds: number[]): void {
  // Dedupe: a repeated tag id would violate the highlight_tags_unique index.
  const uniqueTagIds = [...new Set(tagIds)];
  if (uniqueTagIds.length > 0) {
    db.insert(highlightTags)
      .values(uniqueTagIds.map((tagId) => ({ highlightId, tagId })))
      .run();
  }
}

/**
 * Batch-fetches tags for multiple highlights in a single query.
 * Returns a Map from highlightId to its tags array.
 * @param highlightIds - Array of highlight IDs
 * @returns Map of highlightId → TagInfo[]
 */
export function getTagsForHighlights(highlightIds: number[]): Map<number, TagInfo[]> {
  if (highlightIds.length === 0) return new Map();

  const rows = db
    .select({
      highlightId: highlightTags.highlightId,
      id: tags.id,
      name: tags.name,
      color: tags.color,
    })
    .from(highlightTags)
    .innerJoin(tags, eq(highlightTags.tagId, tags.id))
    .where(inArray(highlightTags.highlightId, highlightIds))
    .all();

  const result = new Map<number, TagInfo[]>();
  for (const row of rows) {
    const list = result.get(row.highlightId) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    result.set(row.highlightId, list);
  }
  return result;
}
