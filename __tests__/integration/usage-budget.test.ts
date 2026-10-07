import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { GET, PATCH } from '@/app/api/usage/budget/route';
import { clearSettingsCache } from '@/lib/settings';

function patchReq(body: object) {
  return new NextRequest(new URL('http://localhost:3000/api/usage/budget'), {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GET + PATCH /api/usage/budget', () => {
  beforeEach(() => {
    dbMock.setup();
    clearSettingsCache();
  });

  it('GET returns null when no budget set', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.budgetUsd).toBeNull();
  });

  it('PATCH sets a budget and GET reads it back', async () => {
    const patchRes = await PATCH(patchReq({ budgetUsd: 50 }));
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.budgetUsd).toBe(50);

    clearSettingsCache();
    const getRes = await GET();
    const getBody = await getRes.json();
    expect(getBody.budgetUsd).toBeCloseTo(50, 5);
  });

  it('PATCH with null clears the budget', async () => {
    await PATCH(patchReq({ budgetUsd: 100 }));
    clearSettingsCache();
    await PATCH(patchReq({ budgetUsd: null }));
    clearSettingsCache();
    const res = await GET();
    const body = await res.json();
    expect(body.budgetUsd).toBeNull();
  });

  it('PATCH rejects negative budgets with 422', async () => {
    const res = await PATCH(patchReq({ budgetUsd: -5 }));
    expect(res.status).toBe(422);
  });

  it('PATCH rejects missing budgetUsd with 422', async () => {
    const res = await PATCH(patchReq({}));
    expect(res.status).toBe(422);
  });
});
