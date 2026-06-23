import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'vouch-night-handover' },
});

export type LogCtx = {
  hotel_id?: string;
  shift_date?: string;
  request_id?: string;
  stage?: 'ingest' | 'extract' | 'thread' | 'reconcile' | 'render' | 'http';
};

export function withCtx(ctx: LogCtx) {
  return logger.child(ctx);
}
