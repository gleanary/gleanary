import cron from 'node-cron';
import { pollAllFeeds } from '@/lib/feed-poller';
import { getSetting } from '@/lib/settings';
import { logger } from '@/lib/logger';
import { cronLogger } from '@/lib/cron-logger';

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;

/**
 * Starts or restarts the feed polling scheduler at the given interval.
 * Stops any existing task before starting a new one.
 * Pass 0 or a negative value to disable polling without starting a new task.
 * @param intervalMinutes - Poll frequency in minutes. 0 = disabled.
 */
export function startFeedScheduler(intervalMinutes: number): void {
  if (scheduledTask) {
    scheduledTask.destroy();
    scheduledTask = null;
  }

  if (intervalMinutes <= 0) {
    logger.info({ event: 'feed_scheduler_disabled' }, 'Feed polling disabled (interval=0)');
    return;
  }

  const cronExpr = `*/${intervalMinutes} * * * *`;
  scheduledTask = cron.schedule(
    cronExpr,
    async () => {
      try {
        const results = await pollAllFeeds();
        if (results.length > 0) {
          const totalNew = results.reduce((sum, r) => sum + r.newArticles, 0);
          logger.info(
            { event: 'feed_scheduler_tick', feeds: results.length, newArticles: totalNew },
            `Scheduler: polled ${results.length} feed(s), ${totalNew} new article(s)`,
          );
        }
      } catch (error) {
        logger.error({ err: error, event: 'feed_scheduler_error' }, 'Feed scheduler tick failed');
      }
    },
    { noOverlap: true, logger: cronLogger },
  );
  scheduledTask.on('execution:overlap', () => {
    logger.debug({ event: 'feed_scheduler_skip' }, 'Previous poll still running, skipping tick');
  });

  logger.info(
    { event: 'feed_scheduler_started', intervalMinutes },
    `Feed scheduler started (every ${intervalMinutes}m)`,
  );
}

/**
 * Stops the feed polling scheduler.
 * Safe to call multiple times — does nothing if not running.
 */
export function stopFeedScheduler(): void {
  if (scheduledTask) {
    scheduledTask.destroy();
    scheduledTask = null;
    logger.info({ event: 'feed_scheduler_stopped' }, 'Feed scheduler stopped');
  }
}

/**
 * Initialises the feed scheduler on app startup.
 * Reads rss_poll_interval from settings (defaults to 1 minute).
 */
export async function initFeedScheduler(): Promise<void> {
  const interval = parseInt((await getSetting('rss_poll_interval')) || '1', 10);
  startFeedScheduler(interval);
}
