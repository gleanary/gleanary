import 'server-only';
import { gte, sql } from 'drizzle-orm';
import { db } from '@/db';
import { aiUsage } from '@/db/schema';

/**
 * Builds a Drizzle WHERE filter restricting AI usage rows to a time range.
 * @param range - Time window: 'day' (1d), 'week' (7d), 'month' (30d), or 'all' (no filter)
 * @returns A Drizzle SQL condition on `aiUsage.createdAt`, or `undefined` for 'all'
 */
export function rangeToSqlFilter(range: string) {
  if (range === 'all') return undefined;
  const days = range === 'day' ? 1 : range === 'week' ? 7 : 30;
  return gte(aiUsage.createdAt, sql`(datetime('now', ${`-${days} days`}))`);
}

/**
 * Fetches successful AI usage rows within the given time range.
 * @param range - Time window: 'day', 'week', 'month', or 'all'
 * @returns All `aiUsage` rows in range whose `status` is 'success'
 */
export function queryUsageRows(range: string) {
  const filter = rangeToSqlFilter(range);
  return (filter ? db.select().from(aiUsage).where(filter) : db.select().from(aiUsage))
    .all()
    .filter((r) => r.status === 'success');
}
