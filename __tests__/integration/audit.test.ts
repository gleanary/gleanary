import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { auditLog } from '@/db/schema';
import { logAudit, getRecentAuditEntries } from '@/lib/audit';

/**
 * Integration tests for the settings audit log. audit.ts imports `server-only`
 * (aliased to an empty stub under vitest) and talks to the real Drizzle DB, so
 * these run against a fresh in-memory database per test.
 */
describe('audit log', () => {
  let db: ReturnType<typeof dbMock.setup>['db'];

  beforeEach(() => {
    db = dbMock.setup().db;
  });

  describe('logAudit', () => {
    it('inserts a row with the given action and key, defaulting userId to 1 and ipAddress to null', () => {
      logAudit('setting_updated', 'rss_poll_interval');

      const rows = db.select().from(auditLog).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe('setting_updated');
      expect(rows[0]!.key).toBe('rss_poll_interval');
      expect(rows[0]!.userId).toBe(1);
      expect(rows[0]!.ipAddress).toBeNull();
    });

    it('persists an explicit userId and ipAddress when provided', () => {
      logAudit('api_key_changed', 'anthropic_api_key', { userId: 7, ipAddress: '10.0.0.4' });

      const rows = db.select().from(auditLog).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.userId).toBe(7);
      expect(rows[0]!.ipAddress).toBe('10.0.0.4');
    });

    it('never stores the setting value anywhere in the row', () => {
      // The caller only ever passes an action + key; there is no column or path
      // through which a secret setting value could land in the audit table.
      logAudit('api_key_changed', 'anthropic_api_key', { userId: 1 });

      const rows = db.select().from(auditLog).all();
      const row = rows[0]!;
      expect(Object.keys(row)).not.toContain('value');
      // Defensive: the sensitive value string appears in no serialized field.
      expect(JSON.stringify(row)).not.toContain('sk-ant-secret');
    });
  });

  describe('getRecentAuditEntries', () => {
    it('returns entries most-recent-first by timestamp', () => {
      db.insert(auditLog)
        .values({
          action: 'setting_updated',
          key: 'oldest',
          timestamp: sql`datetime('now', '-2 days')`,
        })
        .run();
      db.insert(auditLog)
        .values({
          action: 'setting_updated',
          key: 'middle',
          timestamp: sql`datetime('now', '-1 days')`,
        })
        .run();
      db.insert(auditLog)
        .values({ action: 'setting_updated', key: 'newest', timestamp: sql`datetime('now')` })
        .run();

      const entries = getRecentAuditEntries();
      expect(entries.map((e) => e.key)).toEqual(['newest', 'middle', 'oldest']);
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        db.insert(auditLog)
          .values({
            action: 'setting_updated',
            key: `key_${i}`,
            timestamp: sql`datetime('now', '-${sql.raw(String(i))} days')`,
          })
          .run();
      }

      const entries = getRecentAuditEntries(2);
      expect(entries).toHaveLength(2);
    });

    it('returns an empty array when there are no entries', () => {
      expect(getRecentAuditEntries()).toEqual([]);
    });
  });
});
