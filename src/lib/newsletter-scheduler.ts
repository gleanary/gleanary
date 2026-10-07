import cron from 'node-cron';
import { pollNewsletters } from '@/lib/newsletter-poller';
import { getSetting } from '@/lib/settings';
import { logger } from '@/lib/logger';
import { cronLogger } from '@/lib/cron-logger';

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;

/**
 * Starts or restarts the newsletter polling scheduler at the given interval.
 * Stops any existing task before starting a new one.
 * Pass 0 or a negative value to disable polling without starting a new task.
 * @param intervalMinutes - Poll frequency in minutes. 0 = disabled.
 */
export function startNewsletterScheduler(intervalMinutes: number): void {
  if (scheduledTask) {
    scheduledTask.destroy();
    scheduledTask = null;
  }

  if (intervalMinutes <= 0) {
    logger.info(
      { event: 'newsletter_scheduler_disabled' },
      'Newsletter polling disabled (interval=0)',
    );
    return;
  }

  const cronExpr = `*/${intervalMinutes} * * * *`;
  scheduledTask = cron.schedule(
    cronExpr,
    async () => {
      try {
        const result = await pollNewsletters();
        if (result.newArticles > 0) {
          logger.info(
            { event: 'newsletter_scheduler_tick', newArticles: result.newArticles },
            `Newsletter scheduler: ${result.newArticles} new article(s)`,
          );
        }
      } catch (error) {
        logger.error(
          { err: error, event: 'newsletter_scheduler_error' },
          'Newsletter scheduler tick failed',
        );
      }
    },
    { noOverlap: true, logger: cronLogger },
  );
  scheduledTask.on('execution:overlap', () => {
    logger.debug(
      { event: 'newsletter_scheduler_skip' },
      'Previous newsletter poll still running, skipping tick',
    );
  });

  logger.info(
    { event: 'newsletter_scheduler_started', intervalMinutes },
    `Newsletter scheduler started (every ${intervalMinutes}m)`,
  );
}

/**
 * Stops the newsletter polling scheduler.
 * Safe to call multiple times — does nothing if not running.
 */
export function stopNewsletterScheduler(): void {
  if (scheduledTask) {
    scheduledTask.destroy();
    scheduledTask = null;
    logger.info({ event: 'newsletter_scheduler_stopped' }, 'Newsletter scheduler stopped');
  }
}

/**
 * Initialises the newsletter scheduler on app startup.
 * Reads imap_poll_interval and imap_host from settings.
 * Does nothing if IMAP is not configured.
 */
export async function initNewsletterScheduler(): Promise<void> {
  const host = await getSetting('imap_host');
  if (!host) {
    logger.info(
      { event: 'newsletter_scheduler_skipped' },
      'IMAP not configured, skipping newsletter scheduler',
    );
    return;
  }
  const interval = parseInt((await getSetting('imap_poll_interval')) || '5', 10);
  startNewsletterScheduler(interval);
}
