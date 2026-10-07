import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { http, HttpResponse } from 'msw';
import { server, setupHandlers } from '../mocks/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { setupAuthEnv, TEST_PASSWORD } from '../mocks/auth-env';
import { clearSettingsCache } from '@/lib/settings';
import { POST as testSettings } from '@/app/api/settings/test/route';

const INWORLD_VOICES_URL = 'https://api.inworld.ai/tts/v1/voices';
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
const MISTRAL_MODELS_URL = 'https://api.mistral.ai/v1/models';
const READWISE_AUTH_URL = 'https://readwise.io/api/v2/auth/';

// Default: every upstream returns 200 OK.
setupHandlers(
  http.get(INWORLD_VOICES_URL, () => HttpResponse.json({ voices: [] })),
  http.get(ANTHROPIC_MODELS_URL, () => HttpResponse.json({ data: [] })),
  http.get(MISTRAL_MODELS_URL, () => HttpResponse.json({ data: [] })),
  http.get(READWISE_AUTH_URL, () => new HttpResponse(null, { status: 204 })),
);

function jsonReq(method: string, url: string, body?: object) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
      : {}),
  });
}

const SERVICES = [
  { service: 'inworld', url: INWORLD_VOICES_URL },
  { service: 'anthropic', url: ANTHROPIC_MODELS_URL },
  { service: 'readwise', url: READWISE_AUTH_URL },
  { service: 'mistral', url: MISTRAL_MODELS_URL },
] as const;

describe('POST /api/settings/test', () => {
  setupAuthEnv();

  beforeEach(() => {
    dbMock.setup();
    clearSettingsCache();
  });

  for (const { service, url } of SERVICES) {
    it(`returns success:true when the ${service} upstream is 200`, async () => {
      const res = await testSettings(
        jsonReq('POST', '/api/settings/test', {
          service,
          api_key: 'test-key',
          confirm_password: TEST_PASSWORD,
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it(`returns success:false with the status when the ${service} upstream is 401`, async () => {
      server.use(
        http.get(url, () => new HttpResponse(null, { status: 401, statusText: 'Unauthorized' })),
      );

      const res = await testSettings(
        jsonReq('POST', '/api/settings/test', {
          service,
          api_key: 'bad-key',
          confirm_password: TEST_PASSWORD,
        }),
      );
      // Our route always responds 200; the upstream failure is in the body.
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.message).toContain('401');
    });
  }

  it('returns 403 for a wrong confirm_password', async () => {
    const res = await testSettings(
      jsonReq('POST', '/api/settings/test', {
        service: 'anthropic',
        api_key: 'test-key',
        confirm_password: 'wrong-password',
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 422 for an unknown service', async () => {
    const res = await testSettings(
      jsonReq('POST', '/api/settings/test', {
        service: 'openai',
        api_key: 'test-key',
        confirm_password: TEST_PASSWORD,
      }),
    );
    expect(res.status).toBe(422);
  });

  it('returns 422 for a missing api_key', async () => {
    const res = await testSettings(
      jsonReq('POST', '/api/settings/test', {
        service: 'anthropic',
        confirm_password: TEST_PASSWORD,
      }),
    );
    expect(res.status).toBe(422);
  });
});
