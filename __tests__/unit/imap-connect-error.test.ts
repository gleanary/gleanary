import { describe, it, expect, vi } from 'vitest';

// Pure logic: keep the DB and logger out of the picture (importing the poller module must not open SQLite)
vi.mock('@/db', () => ({ db: {} }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { describeImapConnectError } from '@/lib/newsletter-poller';

const THROTTLE_MESSAGE = 'IMAP server is throttling logins — try again later';
const AUTH_MESSAGE = 'IMAP authentication failed — check username and password';

function imapError(message: string, props: Record<string, unknown>): Error {
  return Object.assign(new Error(message), props);
}

describe('describeImapConnectError', () => {
  it('classifies an ETHROTTLE error with a retry hint rounded up to seconds', () => {
    const error = imapError('Request is throttled', { code: 'ETHROTTLE', throttleReset: 92_415 });

    expect(describeImapConnectError(error)).toEqual({
      reason: 'throttled',
      message: `${THROTTLE_MESSAGE} (retry in ~93 s)`,
    });
  });

  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['negative', -5_000],
    ['non-number', '92415'],
  ])('omits the retry hint when throttleReset is %s', (_label, throttleReset) => {
    const error = imapError('Request is throttled', { code: 'ETHROTTLE', throttleReset });

    expect(describeImapConnectError(error)).toEqual({
      reason: 'throttled',
      message: THROTTLE_MESSAGE,
    });
  });

  it('classifies as throttled when both ETHROTTLE and authenticationFailed are set', () => {
    const error = imapError('Request is throttled', {
      code: 'ETHROTTLE',
      authenticationFailed: true,
      serverResponseCode: 'AUTHENTICATIONFAILED',
      throttleReset: 1_000,
    });

    expect(describeImapConnectError(error)).toEqual({
      reason: 'throttled',
      message: `${THROTTLE_MESSAGE} (retry in ~1 s)`,
    });
  });

  it('classifies an authentication failure and appends the server response code', () => {
    const error = imapError('Command failed', {
      authenticationFailed: true,
      serverResponseCode: 'AUTHENTICATIONFAILED',
    });

    expect(describeImapConnectError(error)).toEqual({
      reason: 'auth_failed',
      message: `${AUTH_MESSAGE} (AUTHENTICATIONFAILED)`,
    });
  });

  it('classifies an authentication failure without a server response code', () => {
    const error = imapError('Command failed', { authenticationFailed: true });

    expect(describeImapConnectError(error)).toEqual({
      reason: 'auth_failed',
      message: AUTH_MESSAGE,
    });
  });

  it('returns the message of any other Error', () => {
    expect(describeImapConnectError(new Error('Connection refused'))).toEqual({
      reason: 'other',
      message: 'Connection refused',
    });
  });

  it.each([
    ['a string', 'socket hang up', 'socket hang up'],
    ['undefined', undefined, 'undefined'],
  ])('stringifies a non-Error thrown value (%s)', (_label, thrown, expected) => {
    expect(describeImapConnectError(thrown)).toEqual({ reason: 'other', message: expected });
  });
});
