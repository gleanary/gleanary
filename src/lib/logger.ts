import pino from 'pino';

/** Structured logger for the application. Never use console.log directly. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
  base: {
    env: process.env.NODE_ENV,
    service: 'gleanary',
  },
});
