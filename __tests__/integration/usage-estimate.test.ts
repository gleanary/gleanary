import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/usage/estimate/route';

function req(search: string) {
  return new NextRequest(new URL(`http://localhost:3000/api/usage/estimate${search}`));
}

describe('GET /api/usage/estimate', () => {
  it('returns minUsd, maxUsd, and estimatedDurationSec for a valid request', async () => {
    const res = await GET(
      req(
        '?model=claude-haiku-4-5&maxInputTokens=10000&minOutputTokens=100&maxOutputTokens=500&maxWebSearches=0',
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('minUsd');
    expect(body).toHaveProperty('maxUsd');
    expect(body).toHaveProperty('estimatedDurationSec');
    expect(body.minUsd).toBeGreaterThanOrEqual(0);
    expect(body.maxUsd).toBeGreaterThanOrEqual(body.minUsd);
  });

  it('includes web search cost in maxUsd', async () => {
    const resWithSearch = await GET(
      req(
        '?model=claude-haiku-4-5&maxInputTokens=0&minOutputTokens=0&maxOutputTokens=0&maxWebSearches=10',
      ),
    );
    const bodyWith = await resWithSearch.json();

    const resNoSearch = await GET(
      req(
        '?model=claude-haiku-4-5&maxInputTokens=0&minOutputTokens=0&maxOutputTokens=0&maxWebSearches=0',
      ),
    );
    const bodyNo = await resNoSearch.json();

    // 10 searches × $0.01 = $0.10 more
    expect(bodyWith.maxUsd - bodyNo.maxUsd).toBeCloseTo(0.1, 5);
  });

  it('rejects unknown model with 422', async () => {
    const res = await GET(
      req(
        '?model=claude-unknown&maxInputTokens=1000&minOutputTokens=100&maxOutputTokens=500&maxWebSearches=0',
      ),
    );
    expect(res.status).toBe(422);
  });

  it('rejects missing required params with 422', async () => {
    const res = await GET(req('?model=claude-haiku-4-5'));
    expect(res.status).toBe(422);
  });
});
