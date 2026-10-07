import type { Logger as CronLogger } from 'node-cron';
import { logger } from '@/lib/logger';

function split(message: string | Error, err?: Error): { err?: Error; text: string } {
  return message instanceof Error
    ? { err: message, text: message.message }
    : { err, text: message };
}

/**
 * Adapter that routes node-cron's internal log output through the app's pino
 * logger instead of node-cron's colored console default. Pass via the
 * `logger` task option.
 *
 * Everything below error maps to pino debug: node-cron's warn-level chatter
 * (overlap blocks, missed-execution warnings) reflects benign conditions the
 * schedulers already log themselves as structured, attributed events — the
 * old manual guard logged them at debug, and surfacing them at warn would
 * trip level-keyed monitoring on normal slow polls.
 */
export const cronLogger: CronLogger = {
  info(message: string): void {
    logger.debug({ event: 'node_cron' }, message);
  },
  warn(message: string): void {
    logger.debug({ event: 'node_cron' }, message);
  },
  error(message: string | Error, err?: Error): void {
    const { err: cause, text } = split(message, err);
    logger.error({ err: cause, event: 'node_cron' }, text);
  },
  debug(message: string | Error, err?: Error): void {
    const { err: cause, text } = split(message, err);
    logger.debug({ err: cause, event: 'node_cron' }, text);
  },
};
