import { describe, it, expect, vi, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';
import {
  createSessionToken,
  verifySessionToken,
  verifyPassword,
  verifyBasicAuthHeader,
  isAuthDisabled,
  isAuthConfigured,
  isLoginThrottled,
  registerLoginFailure,
  clearLoginFailures,
  clearAuthCaches,
  SESSION_DURATION_MS,
} from '@/lib/auth';
import { logger } from '@/lib/logger';
import { setupAuthEnv, TEST_PASSWORD } from '../mocks/auth-env';

describe('auth', () => {
  setupAuthEnv();

  describe('configuration flags', () => {
    it('reports auth configured when both env vars are set', () => {
      expect(isAuthConfigured()).toBe(true);
    });

    it('reports auth unconfigured when SETTINGS_AUTH_HASH is missing', () => {
      delete process.env.SETTINGS_AUTH_HASH;
      expect(isAuthConfigured()).toBe(false);
    });

    describe('malformed SETTINGS_AUTH_HASH', () => {
      afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
      });

      // What a `$2b$..$` hash looks like after @next/env expands each `$NAME`
      // to an empty string under `npm run dev`
      const expandedHash = () => process.env.SETTINGS_AUTH_HASH!.replace(/^\$2b\$\d{2}\$/, '');

      it('reports auth unconfigured when the hash is not a valid bcrypt hash', () => {
        vi.stubEnv('SETTINGS_AUTH_HASH', expandedHash());
        expect(isAuthConfigured()).toBe(false);
        vi.stubEnv('SETTINGS_AUTH_HASH', 'b10N/TeNbaUnotabcrypthash');
        expect(isAuthConfigured()).toBe(false);
      });

      it('warns once without logging the hash value', () => {
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
        const malformed = expandedHash();
        vi.stubEnv('SETTINGS_AUTH_HASH', malformed);
        isAuthConfigured();
        isAuthConfigured();
        const calls = warnSpy.mock.calls.filter(
          ([obj]) => (obj as { event?: string }).event === 'auth_hash_malformed',
        );
        expect(calls).toHaveLength(1);
        expect(JSON.stringify(calls[0])).not.toContain(malformed);
        expect(String(calls[0]![1])).toContain('\\$');
      });

      it('accepts valid bcrypt hashes of any variant and cost', () => {
        const body = process.env.SETTINGS_AUTH_HASH!.slice(7);
        for (const prefix of ['$2a$10$', '$2b$12$', '$2y$04$']) {
          vi.stubEnv('SETTINGS_AUTH_HASH', prefix + body);
          expect(isAuthConfigured()).toBe(true);
        }
      });
    });

    it('reports auth disabled only when AUTH_DISABLED=true', () => {
      expect(isAuthDisabled()).toBe(false);
      process.env.AUTH_DISABLED = 'true';
      expect(isAuthDisabled()).toBe(true);
      process.env.AUTH_DISABLED = 'false';
      expect(isAuthDisabled()).toBe(false);
    });
  });

  describe('session tokens', () => {
    it('round-trips a valid token', () => {
      const token = createSessionToken();
      expect(verifySessionToken(token)).toBe(true);
    });

    it('rejects an expired token', () => {
      const past = Date.now() - SESSION_DURATION_MS - 1000;
      const token = createSessionToken(past);
      expect(verifySessionToken(token)).toBe(false);
    });

    it('rejects a tampered token', () => {
      const token = createSessionToken();
      const [exp, sig] = token.split('.');
      const farFuture = String(Number(exp) + 1000 * 60 * 60);
      expect(verifySessionToken(`${farFuture}.${sig}`)).toBe(false);
    });

    it('rejects garbage tokens', () => {
      expect(verifySessionToken('')).toBe(false);
      expect(verifySessionToken('not-a-token')).toBe(false);
      expect(verifySessionToken('123.deadbeef')).toBe(false);
    });

    it('invalidates existing sessions when the password hash changes', async () => {
      const token = createSessionToken();
      process.env.SETTINGS_AUTH_HASH = await bcrypt.hash('new-password', 4);
      expect(verifySessionToken(token)).toBe(false);
    });
  });

  describe('verifyPassword', () => {
    it('accepts the correct password', async () => {
      expect(await verifyPassword(TEST_PASSWORD)).toBe(true);
    });

    it('rejects a wrong password', async () => {
      expect(await verifyPassword('wrong')).toBe(false);
    });

    it('rejects when no hash is configured', async () => {
      delete process.env.SETTINGS_AUTH_HASH;
      expect(await verifyPassword(TEST_PASSWORD)).toBe(false);
    });
  });

  describe('verifyBasicAuthHeader', () => {
    function basicHeader(user: string, pass: string) {
      return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    }

    it('accepts a valid Basic header regardless of username', async () => {
      expect(await verifyBasicAuthHeader(basicHeader('reader', TEST_PASSWORD))).toBe(true);
      expect(await verifyBasicAuthHeader(basicHeader('anything', TEST_PASSWORD))).toBe(true);
    });

    it('rejects a wrong password', async () => {
      expect(await verifyBasicAuthHeader(basicHeader('reader', 'wrong'))).toBe(false);
    });

    it('rejects malformed headers', async () => {
      expect(await verifyBasicAuthHeader('Basic !!!not-base64!!!')).toBe(false);
      expect(await verifyBasicAuthHeader('Bearer abc')).toBe(false);
      expect(
        await verifyBasicAuthHeader(`Basic ${Buffer.from('nopassword').toString('base64')}`),
      ).toBe(false);
    });

    it('handles passwords containing colons', async () => {
      process.env.SETTINGS_AUTH_HASH = await bcrypt.hash('pass:with:colons', 4);
      clearAuthCaches();
      expect(await verifyBasicAuthHeader(basicHeader('u', 'pass:with:colons'))).toBe(true);
    });

    it('accepts a case-insensitive Basic scheme', async () => {
      const header = `basic ${Buffer.from(`reader:${TEST_PASSWORD}`).toString('base64')}`;
      expect(await verifyBasicAuthHeader(header)).toBe(true);
    });

    it('caches successful verifications for the same hash', async () => {
      const header = basicHeader('reader', TEST_PASSWORD);
      expect(await verifyBasicAuthHeader(header)).toBe(true);
      // Same hash still in place: served from cache (also true via bcrypt, but
      // the cached path is what this exercises)
      expect(await verifyBasicAuthHeader(header)).toBe(true);
    });

    it('does not honor cached headers after a password rotation', async () => {
      const header = basicHeader('reader', TEST_PASSWORD);
      expect(await verifyBasicAuthHeader(header)).toBe(true);
      process.env.SETTINGS_AUTH_HASH = await bcrypt.hash('rotated-password', 4);
      expect(await verifyBasicAuthHeader(header)).toBe(false);
    });
  });

  describe('login throttling', () => {
    it('does not throttle before the failure limit', () => {
      for (let i = 0; i < 4; i++) registerLoginFailure('1.2.3.4');
      expect(isLoginThrottled('1.2.3.4')).toBe(false);
    });

    it('throttles after repeated failures', () => {
      for (let i = 0; i < 5; i++) registerLoginFailure('1.2.3.4');
      expect(isLoginThrottled('1.2.3.4')).toBe(true);
    });

    it('tracks IPs independently', () => {
      for (let i = 0; i < 5; i++) registerLoginFailure('1.2.3.4');
      expect(isLoginThrottled('5.6.7.8')).toBe(false);
    });

    it('clears failures on successful login', () => {
      for (let i = 0; i < 5; i++) registerLoginFailure('1.2.3.4');
      clearLoginFailures('1.2.3.4');
      expect(isLoginThrottled('1.2.3.4')).toBe(false);
    });
  });
});
