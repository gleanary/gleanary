import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { setupAuthEnv, TEST_PASSWORD } from '../mocks/auth-env';
import { GET, PATCH } from '@/app/api/settings/route';
import { GET as getAudit } from '@/app/api/settings/audit/route';
import { clearSettingsCache } from '@/lib/settings';

function jsonReq(method: string, url: string, body?: object) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
      : {}),
  });
}

describe('Settings API', () => {
  setupAuthEnv();

  beforeEach(() => {
    dbMock.setup();
    clearSettingsCache();
  });

  describe('GET /api/settings', () => {
    it('returns all known settings with null values when empty', async () => {
      const res = await GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.settings).toBeDefined();
      expect(body.encryptionAvailable).toBe(true);
      // Known keys should be present
      expect(body.settings.anthropic_api_key).toBeDefined();
      expect(body.settings.inworld_api_key).toBeDefined();
      expect(body.settings.tts_default_speed).toBeDefined();
      expect(body.settings.appearance_mode).toBeDefined();
    });

    it('reports authActive: true when auth is configured', async () => {
      const res = await GET();
      const body = await res.json();
      expect(body.authActive).toBe(true);
    });

    it('reports authActive: false when AUTH_DISABLED=true', async () => {
      process.env.AUTH_DISABLED = 'true'; // setupAuthEnv's afterEach removes it
      const res = await GET();
      const body = await res.json();
      expect(body.authActive).toBe(false);
    });

    it('reports authActive: false when no auth hash is set', async () => {
      delete process.env.SETTINGS_AUTH_HASH;
      const res = await GET();
      const body = await res.json();
      expect(body.authActive).toBe(false);
    });
  });

  describe('PATCH /api/settings', () => {
    it('updates a non-encrypted setting without password', async () => {
      const res = await PATCH(
        jsonReq('PATCH', '/api/settings', {
          settings: { rss_poll_interval: '60' },
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toContain('rss_poll_interval');
    });

    it('rejects encrypted setting without password', async () => {
      const res = await PATCH(
        jsonReq('PATCH', '/api/settings', {
          settings: { anthropic_api_key: 'sk-test-123' },
        }),
      );
      expect(res.status).toBe(422);
    });

    it('updates encrypted setting with correct password', async () => {
      const res = await PATCH(
        jsonReq('PATCH', '/api/settings', {
          settings: { anthropic_api_key: 'sk-test-key-12345678' }, // gitleaks:allow (test dummy)
          confirm_password: TEST_PASSWORD,
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toContain('anthropic_api_key');
      // Value should be masked in response
      expect(body.settings.anthropic_api_key.value).toContain('••••••••');
      expect(body.settings.anthropic_api_key.value).toContain('5678');
    });

    it('rejects encrypted setting with wrong password', async () => {
      const res = await PATCH(
        jsonReq('PATCH', '/api/settings', {
          settings: { anthropic_api_key: 'sk-test-123' },
          confirm_password: 'wrong-password',
        }),
      );
      expect(res.status).toBe(403);
    });

    it('rejects unknown setting keys', async () => {
      const res = await PATCH(
        jsonReq('PATCH', '/api/settings', {
          settings: { unknown_key: 'value' },
        }),
      );
      expect(res.status).toBe(422);
    });

    it('validates setting value constraints', async () => {
      const res = await PATCH(
        jsonReq('PATCH', '/api/settings', {
          settings: { tts_default_speed: '5.0' }, // Max is 1.5
        }),
      );
      expect(res.status).toBe(422);
    });

    it('accepts valid appearance_mode values', async () => {
      for (const mode of ['automatic', 'dark', 'light']) {
        const res = await PATCH(
          jsonReq('PATCH', '/api/settings', {
            settings: { appearance_mode: mode },
          }),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.updated).toContain('appearance_mode');
      }
    });

    it('rejects invalid appearance_mode value', async () => {
      const res = await PATCH(
        jsonReq('PATCH', '/api/settings', {
          settings: { appearance_mode: 'purple' },
        }),
      );
      expect(res.status).toBe(422);
    });
  });

  describe('GET /api/settings/audit', () => {
    it('returns empty audit log initially', async () => {
      const res = await getAudit(jsonReq('GET', '/api/settings/audit'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toEqual([]);
    });

    it('records audit entries after settings changes', async () => {
      // Make a change first
      await PATCH(
        jsonReq('PATCH', '/api/settings', {
          settings: { rss_poll_interval: '45' },
        }),
      );

      const res = await getAudit(jsonReq('GET', '/api/settings/audit'));
      const body = await res.json();
      expect(body.entries.length).toBe(1);
      expect(body.entries[0].action).toBe('setting_updated');
      expect(body.entries[0].key).toBe('rss_poll_interval');
    });
  });

  describe('masking', () => {
    it('masks encrypted values in GET response', async () => {
      // Save an encrypted key
      await PATCH(
        jsonReq('PATCH', '/api/settings', {
          settings: { anthropic_api_key: 'sk-ant-api03-longkey12345678' },
          confirm_password: TEST_PASSWORD,
        }),
      );

      // Clear cache to force re-read from DB
      clearSettingsCache();

      const res = await GET();
      const body = await res.json();
      const val = body.settings.anthropic_api_key.value;
      expect(val).toContain('••••••••');
      expect(val).toContain('5678');
      expect(val).not.toContain('sk-ant');
    });
  });
});
