import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { logger, withCtx } from './obs/logger.js';
import { ingestEventsFile } from './ingest/events.js';
import { ingestNightLogFile } from './ingest/nightLog.js';
import { threadFacts } from './domain/threader.js';
import { reconcile } from './domain/reconciler.js';
import { renderHandoverJson, renderHandoverHtml } from './render/handover.js';

const app = Fastify({ logger: false });

app.get('/health', async () => ({ ok: true }));

app.get('/handover', async (req, reply) => {
  const requestId = randomUUID();
  const q = req.query as Record<string, string | undefined>;
  const date = q.date ?? defaultShiftDate();
  const hotelId = q.hotel ?? config.defaultHotelId;
  const format = (q.format ?? 'json').toLowerCase();
  const log = withCtx({ hotel_id: hotelId, shift_date: date, request_id: requestId, stage: 'http' });
  log.info({ msg: 'handover.start', format });

  try {
    const eventsPath = path.join(config.dataDir, 'events.json');
    const nightLogPath = path.join(config.dataDir, 'night-logs.md');

    const ingestLog = withCtx({ hotel_id: hotelId, shift_date: date, request_id: requestId, stage: 'ingest' });
    const { hotel, facts: eventFacts } = await ingestEventsFile(eventsPath);
    ingestLog.info({ msg: 'events.parsed', count: eventFacts.length });

    const extractLog = withCtx({ hotel_id: hotelId, shift_date: date, request_id: requestId, stage: 'extract' });
    const { facts: logFacts, stats: extractStats } = await ingestNightLogFile(nightLogPath, extractLog);
    extractLog.info({ msg: 'night_log.extracted', count: logFacts.length, ...extractStats });

    const allFacts = [...eventFacts, ...logFacts];

    const threadLog = withCtx({ hotel_id: hotelId, shift_date: date, request_id: requestId, stage: 'thread' });
    const threads = threadFacts(allFacts);
    threadLog.info({ msg: 'threads.built', threads: threads.length, facts: allFacts.length });

    const reconLog = withCtx({ hotel_id: hotelId, shift_date: date, request_id: requestId, stage: 'reconcile' });
    const handover = reconcile(threads, date);
    reconLog.info({
      msg: 'reconciled',
      onFire: handover.onFire.length,
      stillOpen: handover.stillOpen.length,
      newTonight: handover.newTonight.length,
      newlyResolved: handover.newlyResolved.length,
      flagged: handover.flagged.length,
    });

    if (format === 'html') {
      reply.type('text/html');
      return renderHandoverHtml(handover, { hotel, date, requestId });
    }
    return renderHandoverJson(handover, { hotel, date, requestId, facts: allFacts });
  } catch (err) {
    log.error({ msg: 'handover.error', err: (err as Error).message });
    reply.code(500);
    return { error: 'internal_error', request_id: requestId };
  }
});

function defaultShiftDate(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

app
  .listen({ port: config.port, host: config.host })
  .then((addr) => logger.info({ msg: 'listening', addr }))
  .catch((err) => {
    logger.error({ msg: 'startup_failed', err: (err as Error).message });
    process.exit(1);
  });
