import 'server-only';
import { desc } from 'drizzle-orm';
import { db } from '@/db';
import { auditLog } from '@/db/schema';
import type { AuditAction, AuditLogEntry } from '@/types';

/**
 * Log a settings audit event. Never logs the setting value — only the key and action.
 * @param action - The audit action type
 * @param key - The setting key that was changed
 * @param options - Optional user ID and IP address
 */
export function logAudit(
  action: AuditAction,
  key: string,
  options?: { userId?: number; ipAddress?: string },
): void {
  db.insert(auditLog)
    .values({
      action,
      key,
      userId: options?.userId ?? 1,
      ipAddress: options?.ipAddress ?? null,
    })
    .run();
}

/**
 * Get recent audit log entries, ordered by most recent first.
 * @param limit - Maximum entries to return (default 100)
 * @returns Array of audit log entries
 */
export function getRecentAuditEntries(limit = 100): AuditLogEntry[] {
  return db.select().from(auditLog).orderBy(desc(auditLog.timestamp)).limit(limit).all();
}
