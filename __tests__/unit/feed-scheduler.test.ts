import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node-cron
const mockSchedule = vi.fn();
const mockDestroy = vi.fn();
const mockOn = vi.fn();
vi.mock('node-cron', () => ({
  default: {
    schedule: (...args: unknown[]) => {
      mockSchedule(...args);
      return { destroy: mockDestroy, on: mockOn };
    },
  },
}));

// Mock feed-poller
vi.mock('@/lib/feed-poller', () => ({
  pollAllFeeds: vi.fn().mockResolvedValue([]),
}));

// Mock settings
vi.mock('@/lib/settings', () => ({
  getSetting: vi.fn().mockImplementation((key: string) => {
    if (key === 'rss_poll_interval') return Promise.resolve('1');
    return Promise.resolve(null);
  }),
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { startFeedScheduler, stopFeedScheduler } from '@/lib/feed-scheduler';

describe('feed-scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopFeedScheduler();
  });

  afterEach(() => {
    stopFeedScheduler();
  });

  it('starts a cron job at the given interval', () => {
    startFeedScheduler(1);

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockSchedule.mock.calls[0]![0]).toBe('*/1 * * * *');
  });

  it('restarts the cron job when called twice (stops old, starts new)', () => {
    startFeedScheduler(1);
    startFeedScheduler(30);

    expect(mockDestroy).toHaveBeenCalledTimes(1);
    expect(mockSchedule).toHaveBeenCalledTimes(2);
    expect(mockSchedule.mock.calls[1]![0]).toBe('*/30 * * * *');
  });

  it('stops polling when interval is 0', () => {
    startFeedScheduler(1);
    startFeedScheduler(0);

    expect(mockDestroy).toHaveBeenCalledTimes(1);
    expect(mockSchedule).toHaveBeenCalledTimes(1); // only the first call
  });

  it('stops the cron job', () => {
    startFeedScheduler(1);
    stopFeedScheduler();

    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it('does nothing when stopping without starting', () => {
    stopFeedScheduler();

    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('enables node-cron overlap prevention instead of a manual flag', () => {
    startFeedScheduler(1);

    expect(mockSchedule.mock.calls[0]![2]).toMatchObject({ noOverlap: true });
  });

  it('logs a debug skip event when a tick is blocked by overlap prevention', async () => {
    const { logger } = await import('@/lib/logger');

    startFeedScheduler(1);

    expect(mockOn).toHaveBeenCalledWith('execution:overlap', expect.any(Function));
    const overlapListener = mockOn.mock.calls.find(
      (call) => call[0] === 'execution:overlap',
    )![1] as () => void;
    overlapListener();

    expect(logger.debug).toHaveBeenCalledWith({ event: 'feed_scheduler_skip' }, expect.any(String));
  });

  it('calls pollAllFeeds when the cron job fires', async () => {
    const { pollAllFeeds } = await import('@/lib/feed-poller');

    startFeedScheduler(1);

    const cronCallback = mockSchedule.mock.calls[0]![1] as () => Promise<void>;
    await cronCallback();

    expect(pollAllFeeds).toHaveBeenCalledTimes(1);
  });
});
