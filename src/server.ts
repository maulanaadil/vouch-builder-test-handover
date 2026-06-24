import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { logger, withCtx } from './obs/logger.js';
import { ingestEventsFile, ingestEventsArray } from './ingest/events.js';
import { ingestNightLogFile, ingestNightLog } from './ingest/nightLog.js';
import { threadFacts } from './domain/threader.js';
import { reconcile } from './domain/reconciler.js';
import { renderHandoverJson, renderHandoverHtml } from './render/handover.js';
import type { Fact } from './domain/fact.js';

const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

app.get('/health', async () => ({ ok: true }));

type CtxLog = ReturnType<typeof withCtx>;

type PipelineInputs = {
  hotel: { id: string; name: string; rooms: number; timezone: string };
  eventFacts: Fact[];
  logFacts: Fact[];
  extractStats?: object;
};

async function runPipeline(
  inputs: PipelineInputs,
  date: string,
  requestId: string,
  format: string,
): Promise<{ body?: unknown; html?: string }> {
  const { hotel, eventFacts, logFacts, extractStats } = inputs;
  const hotelId = hotel.id;

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
    extractStats,
  });

  if (format === 'html') {
    return { html: renderHandoverHtml(handover, { hotel, date, requestId }) };
  }
  return { body: renderHandoverJson(handover, { hotel, date, requestId, facts: allFacts }) };
}

app.get('/handover', async (req, reply) => {
  const requestId = randomUUID();
  const q = req.query as Record<string, string | undefined>;
  const date = q.date ?? defaultShiftDate();
  const hotelId = q.hotel ?? config.defaultHotelId;
  const format = (q.format ?? 'json').toLowerCase();
  const log = withCtx({ hotel_id: hotelId, shift_date: date, request_id: requestId, stage: 'http' });
  log.info({ msg: 'handover.start', method: 'GET', format });

  try {
    const eventsPath = path.join(config.dataDir, 'events.json');
    const nightLogPath = path.join(config.dataDir, 'night-logs.md');

    const ingestLog = withCtx({ hotel_id: hotelId, shift_date: date, request_id: requestId, stage: 'ingest' });
    const { hotel, facts: eventFacts } = await ingestEventsFile(eventsPath);
    ingestLog.info({ msg: 'events.parsed', count: eventFacts.length });

    const extractLog = withCtx({ hotel_id: hotelId, shift_date: date, request_id: requestId, stage: 'extract' });
    const { facts: logFacts, stats: extractStats } = await ingestNightLogFile(nightLogPath, extractLog);
    extractLog.info({ msg: 'night_log.extracted', count: logFacts.length, ...extractStats });

    const result = await runPipeline({ hotel, eventFacts, logFacts, extractStats }, date, requestId, format);
    if (result.html !== undefined) {
      reply.type('text/html');
      return result.html;
    }
    return result.body;
  } catch (err) {
    log.error({ msg: 'handover.error', err: (err as Error).message });
    reply.code(500);
    return { error: 'internal_error', request_id: requestId };
  }
});

type PostBody = {
  hotel?: { id?: string; name?: string; rooms?: number; timezone?: string };
  events?: unknown[];
  nightLog?: string;
  targetMorning?: string;
  format?: string;
};

app.post('/handover', async (req, reply) => {
  const requestId = randomUUID();
  const q = req.query as Record<string, string | undefined>;
  const body = (req.body ?? {}) as PostBody;

  const date = body.targetMorning ?? q.date ?? defaultShiftDate();
  const format = (body.format ?? q.format ?? 'json').toLowerCase();
  const hotelInput = body.hotel ?? {};
  const hotelId = hotelInput.id ?? q.hotel ?? config.defaultHotelId;
  const hotel = {
    id: hotelId,
    name: hotelInput.name ?? 'Unknown Hotel',
    rooms: typeof hotelInput.rooms === 'number' ? hotelInput.rooms : 0,
    timezone: hotelInput.timezone ?? '+08:00',
  };

  const log = withCtx({ hotel_id: hotelId, shift_date: date, request_id: requestId, stage: 'http' });
  log.info({ msg: 'handover.start', method: 'POST', format });

  if (!Array.isArray(body.events)) {
    reply.code(400);
    return { error: 'events_required', detail: 'Body must include an "events" array', request_id: requestId };
  }

  try {
    const ingestLog = withCtx({ hotel_id: hotelId, shift_date: date, request_id: requestId, stage: 'ingest' });
    // ingestEventsArray will throw if the items don't match the expected shape — let it bubble.
    const { facts: eventFacts } = ingestEventsArray(body.events as Parameters<typeof ingestEventsArray>[0], hotel);
    ingestLog.info({ msg: 'events.parsed', count: eventFacts.length });

    const extractLog = withCtx({ hotel_id: hotelId, shift_date: date, request_id: requestId, stage: 'extract' });
    const nightLogText = typeof body.nightLog === 'string' ? body.nightLog : '';
    let logFacts: Fact[] = [];
    let extractStats: object = { skipped: true };
    if (nightLogText.trim().length > 0) {
      const out = await ingestNightLog(nightLogText, extractLog);
      logFacts = out.facts;
      extractStats = out.stats;
    } else {
      extractLog.info({ msg: 'night_log.skipped_empty' });
    }

    const result = await runPipeline({ hotel, eventFacts, logFacts, extractStats }, date, requestId, format);
    if (result.html !== undefined) {
      reply.type('text/html');
      return result.html;
    }
    return result.body;
  } catch (err) {
    log.error({ msg: 'handover.error', err: (err as Error).message });
    reply.code(500);
    return { error: 'internal_error', detail: (err as Error).message, request_id: requestId };
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
