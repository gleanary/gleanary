import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '@/db/schema';

// Re-export the shared client/server lint types so helpers have one import.
export type { LintCheck, LintRelatedRef, LintSuggestion } from '@/types';
export { LINT_CHECKS } from '@/types';
// Kept for back-compat with the original Suggestion name used by helpers.
export type { LintSuggestion as Suggestion, LintRelatedRef as RelatedRef } from '@/types';

/**
 * Dependencies passed into each lint check helper. Bundled so helpers stay
 * easy to unit-test — tests pass an in-memory Drizzle/better-sqlite3 pair.
 */
export interface LintContext {
  db: BetterSQLite3Database<typeof schema>;
  rawDb: Database.Database;
}
