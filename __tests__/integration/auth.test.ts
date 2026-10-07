import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';

import proxy from '@/proxy';
import { POST as login } from '@/app/api/auth/login/route';
import { POST as logout } from '@/app/api/auth/logout/route';
import { createSessionToken, SESSION_COOKIE_NAME } from '@/lib/auth';
import { setupAuthEnv, TEST_PASSWORD } from '../mocks/auth-env';

interface ReqInit {
  method?: string;
  body?: string;
  headers?: HeadersInit;
  cookie?: string;
  basic?: string;
  ip?: string;
}

function req(path: string, init: ReqInit = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', init.cookie);
  if (init.basic) {
    headers.set('authorization', `Basic ${Buffer.from(init.basic).toString('base64')}`);
  }
  if (init.ip) headers.set('x-forwarded-for', init.ip);
  return new NextRequest(new URL(path, 'http://localhost:3000'), {
    method: init.method,
    body: init.body,
    headers,
  });
}

function loginReq(password: string, ip = '10.0.0.1') {
  return req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
    headers: { 'Content-Type': 'application/json' },
    ip,
  });
}

describe('Auth', () => {
  setupAuthEnv();

  describe('proxy (request gate)', () => {
    it('redirects unauthenticated page requests to /login', async () => {
      const res = await proxy(req('/'));
      expect(res.status).toBe(307);
      expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
    });

    it('preserves the destination in the next param', async () => {
      const res = await proxy(req('/search'));
      const location = new URL(res.headers.get('location')!);
      expect(location.searchParams.get('next')).toBe('/search');
    });

    it('preserves the query string in the next param (mobile save flow)', async () => {
      const res = await proxy(req('/save?url=https%3A%2F%2Fexample.com%2Fa'));
      const location = new URL(res.headers.get('location')!);
      expect(location.searchParams.get('next')).toBe('/save?url=https%3A%2F%2Fexample.com%2Fa');
    });

    it('lets /api/auth/logout through without a session (expired-cookie logout)', async () => {
      const res = await proxy(req('/api/auth/logout'));
      expect(res.status).toBe(200);
    });

    it('throttles repeated wrong Basic auth attempts per IP', async () => {
      for (let i = 0; i < 5; i++) {
        await proxy(req('/api/articles', { basic: 'reader:wrong', ip: '7.7.7.7' }));
      }
      // Correct password now rejected without a bcrypt compare: IP is throttled
      const res = await proxy(
        req('/api/articles', { basic: `reader:${TEST_PASSWORD}`, ip: '7.7.7.7' }),
      );
      expect(res.status).toBe(401);
      // A different IP is unaffected
      const other = await proxy(
        req('/api/articles', { basic: `reader:${TEST_PASSWORD}`, ip: '8.8.8.8' }),
      );
      expect(other.status).toBe(200);
    });

    it('returns 401 JSON for unauthenticated API requests', async () => {
      const res = await proxy(req('/api/articles'));
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Basic');
    });

    it('lets /login, /api/auth/login and /api/health through', async () => {
      for (const path of ['/login', '/api/auth/login', '/api/health']) {
        const res = await proxy(req(path));
        expect(res.status, path).toBe(200);
      }
    });

    it('accepts a valid session cookie', async () => {
      const token = createSessionToken();
      const res = await proxy(req('/', { cookie: `${SESSION_COOKIE_NAME}=${token}` }));
      expect(res.status).toBe(200);
    });

    it('rejects an invalid session cookie', async () => {
      const res = await proxy(req('/', { cookie: `${SESSION_COOKIE_NAME}=123.bogus` }));
      expect(res.status).toBe(307);
    });

    it('accepts a valid Basic auth header (extension flow)', async () => {
      const res = await proxy(req('/api/articles/parse', { basic: `reader:${TEST_PASSWORD}` }));
      expect(res.status).toBe(200);
    });

    it('rejects a wrong Basic auth password', async () => {
      const res = await proxy(req('/api/articles/parse', { basic: 'reader:wrong' }));
      expect(res.status).toBe(401);
    });

    it('bypasses auth entirely when AUTH_DISABLED=true', async () => {
      process.env.AUTH_DISABLED = 'true';
      const res = await proxy(req('/'));
      expect(res.status).toBe(200);
    });

    it('still blocks when auth is unconfigured (safe by default)', async () => {
      delete process.env.SETTINGS_AUTH_HASH;
      const res = await proxy(req('/'));
      expect(res.status).toBe(307);
    });
  });

  describe('POST /api/auth/login', () => {
    it('sets a session cookie on correct password', async () => {
      const res = await login(loginReq(TEST_PASSWORD));
      expect(res.status).toBe(200);
      const setCookie = res.headers.get('set-cookie')!;
      expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
      expect(setCookie.toLowerCase()).toContain('httponly');
      expect(setCookie.toLowerCase()).toContain('samesite=lax');
    });

    it('rejects a wrong password with 403', async () => {
      const res = await login(loginReq('wrong-password'));
      expect(res.status).toBe(403);
    });

    it('rejects an invalid body with 422', async () => {
      const res = await login(
        req('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ nope: true }),
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      expect(res.status).toBe(422);
    });

    it('returns 503 when auth is not configured', async () => {
      delete process.env.SETTINGS_AUTH_HASH;
      const res = await login(loginReq(TEST_PASSWORD));
      expect(res.status).toBe(503);
    });

    it('throttles after repeated failures from the same IP', async () => {
      for (let i = 0; i < 5; i++) {
        await login(loginReq('wrong-password', '9.9.9.9'));
      }
      const res = await login(loginReq(TEST_PASSWORD, '9.9.9.9'));
      expect(res.status).toBe(429);
    });

    it('issued cookie is accepted by the proxy', async () => {
      const res = await login(loginReq(TEST_PASSWORD));
      const setCookie = res.headers.get('set-cookie')!;
      const token = /gleanary_session=([^;]+)/.exec(setCookie)![1];
      const gate = await proxy(req('/', { cookie: `${SESSION_COOKIE_NAME}=${token}` }));
      expect(gate.status).toBe(200);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('clears the session cookie', async () => {
      const res = await logout(req('/api/auth/logout', { method: 'POST' }));
      expect(res.status).toBe(200);
      const setCookie = res.headers.get('set-cookie')!;
      expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
    });
  });
});
