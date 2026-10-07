import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ db: null as unknown, rawDb: null as unknown }));
vi.mock('@/db', () => ({
  get db() {
    return mocks.db;
  },
  get rawDb() {
    return mocks.rawDb;
  },
}));

import { createTestDb } from './setup';
import { GET } from '@/app/api/health/route';

describe('GET /api/health', () => {
  beforeEach(() => {
    const { db, sqlite } = createTestDb();
    mocks.db = db;
    mocks.rawDb = sqlite;
  });

  it('returns 200 with db connected when the database responds', async () => {
    const res = GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.db).toBe('connected');
    expect(typeof body.timestamp).toBe('string');
  });

  it('returns 503 when the database is unavailable', async () => {
    mocks.rawDb = {
      prepare() {
        throw new Error('database is locked');
      },
    };

    const res = GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('error');
    expect(body.message).toBe('Database unavailable');
  });
});
