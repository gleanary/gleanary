import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { cronLogger } from '@/lib/cron-logger';
import { logger } from '@/lib/logger';

describe('cron-logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes info messages to pino debug (sub-error chatter policy)', () => {
    cronLogger.info('scheduler started');

    expect(logger.debug).toHaveBeenCalledWith({ event: 'node_cron' }, 'scheduler started');
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('routes warn messages to pino debug so benign overlap blocks do not surface as warns', () => {
    cronLogger.warn('task still running');

    expect(logger.debug).toHaveBeenCalledWith({ event: 'node_cron' }, 'task still running');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('routes error strings with an optional cause to pino error', () => {
    const cause = new Error('boom');
    cronLogger.error('tick failed', cause);

    expect(logger.error).toHaveBeenCalledWith({ err: cause, event: 'node_cron' }, 'tick failed');
  });

  it('routes Error instances to pino error with the error message', () => {
    const err = new Error('boom');
    cronLogger.error(err);

    expect(logger.error).toHaveBeenCalledWith({ err, event: 'node_cron' }, 'boom');
  });

  it('routes debug messages to pino debug', () => {
    cronLogger.debug('heartbeat armed');

    expect(logger.debug).toHaveBeenCalledWith(
      { err: undefined, event: 'node_cron' },
      'heartbeat armed',
    );
  });
});
