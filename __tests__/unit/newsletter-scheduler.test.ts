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

// Mock newsletter-poller
vi.mock('@/lib/newsletter-poller', () => ({
  pollNewsletters: vi.fn().mockResolvedValue({ newArticles: 0, skipped: 0, errors: [] }),
}));

// Mock settings
vi.mock('@/lib/settings', () => ({
  getSetting: vi.fn().mockImplementation((key: string) => {
    if (key === 'imap_host') return Promise.resolve('imap.example.com');
    if (key === 'imap_poll_interval') return Promise.resolve('5');
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

import {
  startNewsletterScheduler,
  stopNewsletterScheduler,
  initNewsletterScheduler,
} from '@/lib/newsletter-scheduler';
import { getSetting } from '@/lib/settings';

describe('newsletter-scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopNewsletterScheduler();
  });

  afterEach(() => {
    stopNewsletterScheduler();
  });

  it('starts a cron job at the given interval', () => {
    startNewsletterScheduler(5);

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockSchedule.mock.calls[0]![0]).toBe('*/5 * * * *');
  });

  it('restarts the cron job when called twice (stops old, starts new)', () => {
    startNewsletterScheduler(5);
    startNewsletterScheduler(10);

    expect(mockDestroy).toHaveBeenCalledTimes(1);
    expect(mockSchedule).toHaveBeenCalledTimes(2);
    expect(mockSchedule.mock.calls[1]![0]).toBe('*/10 * * * *');
  });

  it('stops polling when interval is 0', () => {
    startNewsletterScheduler(5);
    startNewsletterScheduler(0);

    expect(mockDestroy).toHaveBeenCalledTimes(1);
    expect(mockSchedule).toHaveBeenCalledTimes(1); // only the first call
  });

  it('stops the cron job', () => {
    startNewsletterScheduler(5);
    stopNewsletterScheduler();

    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it('does nothing when stopping without starting', () => {
    stopNewsletterScheduler();

    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('initNewsletterScheduler starts scheduler when imap_host is configured', async () => {
    await initNewsletterScheduler();

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockSchedule.mock.calls[0]![0]).toBe('*/5 * * * *');
  });

  it('initNewsletterScheduler does nothing when imap_host is not configured', async () => {
    vi.mocked(getSetting).mockResolvedValue(null);

    await initNewsletterScheduler();

    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('enables node-cron overlap prevention instead of a manual flag', () => {
    startNewsletterScheduler(5);

    expect(mockSchedule.mock.calls[0]![2]).toMatchObject({ noOverlap: true });
  });

  it('logs a debug skip event when a tick is blocked by overlap prevention', async () => {
    const { logger } = await import('@/lib/logger');

    startNewsletterScheduler(5);

    expect(mockOn).toHaveBeenCalledWith('execution:overlap', expect.any(Function));
    const overlapListener = mockOn.mock.calls.find(
      (call) => call[0] === 'execution:overlap',
    )![1] as () => void;
    overlapListener();

    expect(logger.debug).toHaveBeenCalledWith(
      { event: 'newsletter_scheduler_skip' },
      expect.any(String),
    );
  });

  it('calls pollNewsletters when the cron job fires', async () => {
    const { pollNewsletters } = await import('@/lib/newsletter-poller');

    startNewsletterScheduler(5);

    const cronCallback = mockSchedule.mock.calls[0]![1] as () => Promise<void>;
    await cronCallback();

    expect(pollNewsletters).toHaveBeenCalledTimes(1);
  });
});
