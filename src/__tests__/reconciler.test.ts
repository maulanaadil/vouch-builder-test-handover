import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestEventsFile } from '../ingest/events.js';
import { ingestNightLogFile } from '../ingest/nightLog.js';
import { threadFacts } from '../domain/threader.js';
import { reconcile } from '../domain/reconciler.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const dataDir = path.join(repoRoot, 'data');

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

async function buildHandover(date: string) {
  process.env.LLM_ENABLED = 'false';
  const { facts: eventFacts } = await ingestEventsFile(path.join(dataDir, 'events.json'));
  const { facts: logFacts } = await ingestNightLogFile(path.join(dataDir, 'night-logs.md'), silentLog);
  const threads = threadFacts([...eventFacts, ...logFacts]);
  return reconcile(threads, date);
}

describe('reconciler — May 30 morning handover', () => {
  it('puts the 208 broken safe on fire (came from night log only)', async () => {
    const h = await buildHandover('2026-05-30');
    const safe = h.onFire.find((i) => i.room === '208');
    expect(safe).toBeDefined();
    expect(safe!.topic).toBe('safe');
    expect(safe!.citations.some((c) => c.startsWith('nl_'))).toBe(true);
  });

  it('puts the immigration scanner backlog on fire and merges its multi-night history', async () => {
    const h = await buildHandover('2026-05-30');
    const scanner = h.onFire.find((i) =>
      i.topic === 'compliance' && i.citations.includes('evt_0019'),
    );
    expect(scanner).toBeDefined();
    expect(scanner!.citations).toEqual(expect.arrayContaining(['evt_0009', 'evt_0019']));
  });

  it('puts the 309 deposit on fire because of imminent checkout', async () => {
    const h = await buildHandover('2026-05-30');
    const deposit = h.onFire.find((i) => i.room === '309' && i.topic === 'deposit');
    expect(deposit).toBeDefined();
    expect(deposit!.priority).toBe('CRITICAL');
    expect(deposit!.citations).toEqual(expect.arrayContaining(['evt_0007', 'evt_0014']));
  });

  it('keeps room 112 aircon as still open (compressor on order)', async () => {
    const h = await buildHandover('2026-05-30');
    const ac = h.stillOpen.find((i) => i.room === '112');
    expect(ac).toBeDefined();
    expect(ac!.citations).toEqual(expect.arrayContaining(['evt_0002', 'evt_0018']));
  });

  it('flags the prompt-injection guest note in 214 — never auto-acts on it', async () => {
    const h = await buildHandover('2026-05-30');
    const injection = h.flagged.find((i) => i.room === '214');
    expect(injection).toBeDefined();
    expect(injection!.flags.some((f) => f.kind === 'prompt-injection')).toBe(true);
    // Must not appear in any action bucket
    for (const bucket of [h.onFire, h.stillOpen, h.newTonight, h.newlyResolved, h.fyi]) {
      expect(bucket.find((i) => i.room === '214')).toBeUndefined();
    }
  });

  it('flags the breakfast complaint with no room as needing review', async () => {
    const h = await buildHandover('2026-05-30');
    const breakfast = h.flagged.find((i) => i.citations.includes('evt_0015'));
    expect(breakfast).toBeDefined();
    expect(breakfast!.flags.some((f) => f.kind === 'missing-room')).toBe(true);
  });

  it('flags the unverified damage charge in 226 (no photos, no approval)', async () => {
    const h = await buildHandover('2026-05-30');
    const damage = h.flagged.find((i) => i.room === '226');
    expect(damage).toBeDefined();
    expect(damage!.flags.some((f) => f.kind === 'unverified-amount')).toBe(true);
  });

  it('flags the 205 silent-checkout contradiction (system vs observation)', async () => {
    const h = await buildHandover('2026-05-30');
    const silent = h.flagged.find((i) => i.room === '205');
    expect(silent).toBeDefined();
    expect(silent!.flags.some((f) => f.kind === 'contradiction')).toBe(true);
  });

  it('does not surface threads that fully resolved on previous shifts', async () => {
    const h = await buildHandover('2026-05-30');
    // evt_0001 (May 25 check-in resolved that night) should NOT appear anywhere
    const everywhere = [
      ...h.onFire, ...h.stillOpen, ...h.newTonight, ...h.newlyResolved, ...h.flagged, ...h.fyi,
    ];
    expect(everywhere.find((i) => i.citations.includes('evt_0001'))).toBeUndefined();
  });

  it('every emitted item carries at least one source citation', async () => {
    const h = await buildHandover('2026-05-30');
    const everywhere = [
      ...h.onFire, ...h.stillOpen, ...h.newTonight, ...h.newlyResolved, ...h.flagged, ...h.fyi,
    ];
    for (const item of everywhere) {
      expect(item.citations.length).toBeGreaterThan(0);
    }
  });
});

describe('reconciler — May 28 morning handover (the night with relief log)', () => {
  it('surfaces newly-resolved 215 leak — opened on 27 May, resolved by night-log notes', async () => {
    // Note: evt_0013 (the leak resolution) is on 2026-05-29; the night log only made it worse.
    // On May 28 morning, the leak should still be open (worsened overnight per relief staff).
    const h = await buildHandover('2026-05-28');
    const leak = h.onFire.concat(h.stillOpen).find((i) => i.topic === 'leak');
    expect(leak).toBeDefined();
    expect(leak!.citations.some((c) => c.startsWith('nl_'))).toBe(true);
  });

  it('surfaces 208 safe newly-opened tonight', async () => {
    const h = await buildHandover('2026-05-28');
    const safe = h.onFire.concat(h.newTonight).find((i) => i.room === '208');
    expect(safe).toBeDefined();
  });
});
