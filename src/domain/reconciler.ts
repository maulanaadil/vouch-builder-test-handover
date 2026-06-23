import type { Fact, Flag } from './fact.js';
import { type Thread, priorityRank } from './threader.js';
import { config } from '../config.js';

export type Bucket = 'onFire' | 'stillOpen' | 'newTonight' | 'newlyResolved' | 'flagged' | 'fyi';

export type HandoverItem = {
  threadId: string;
  bucket: Bucket;
  priority: Thread['priority'];
  room: string | null;
  topic: Thread['topic'];
  oneLiner: string;
  citations: string[];
  factDetails: Array<{
    ref: string;
    kind: 'event' | 'night-log';
    occurredAt: string;
    text: string;
    flags: Flag[];
  }>;
  flags: Flag[];
  reason: string;
};

export type Handover = {
  shiftDate: string;
  shiftWindow: { start: string; end: string };
  onFire: HandoverItem[];
  stillOpen: HandoverItem[];
  newTonight: HandoverItem[];
  newlyResolved: HandoverItem[];
  flagged: HandoverItem[];
  fyi: HandoverItem[];
};

export function shiftWindow(date: string): { start: string; end: string } {
  const tz = config.shift.timezone;
  const prev = addDays(date, -1);
  return {
    start: `${prev}T${pad(config.shift.startHour)}:00:00${tz}`,
    end: `${date}T${pad(config.shift.endHour)}:00:00${tz}`,
  };
}

export function reconcile(threads: Thread[], date: string): Handover {
  const window = shiftWindow(date);
  const handover: Handover = {
    shiftDate: date,
    shiftWindow: window,
    onFire: [],
    stillOpen: [],
    newTonight: [],
    newlyResolved: [],
    flagged: [],
    fyi: [],
  };

  for (const t of threads) {
    const inShift = t.facts.filter((f) => isInWindow(f.occurredAt, window));
    const beforeShift = t.facts.filter((f) => f.occurredAt < window.start);

    const hasInjection = t.facts.some((f) => f.flags.some((fl) => fl.kind === 'prompt-injection'));
    const hasContradiction = t.facts.some((f) => f.flags.some((fl) => fl.kind === 'contradiction'));
    const hasMissingRoom = t.facts.some((f) => f.flags.some((fl) => fl.kind === 'missing-room'));
    const hasUnverifiedAmount = t.facts.some((f) => f.flags.some((fl) => fl.kind === 'unverified-amount'));

    // Compute "current as of end of shift" status: latest fact at or before window.end
    const factsUpToShiftEnd = t.facts.filter((f) => f.occurredAt <= window.end);
    if (factsUpToShiftEnd.length === 0) {
      // Thread's facts are all in the future relative to this shift — skip.
      continue;
    }
    const latestAsOf = factsUpToShiftEnd[factsUpToShiftEnd.length - 1]!;
    const wasResolvedBefore = beforeShift.length > 0 && beforeShift[beforeShift.length - 1]!.statusSignal === 'resolved';

    const item = buildItem(t, factsUpToShiftEnd);

    // Routing decisions, in priority order. Flagged routing wins over action routing for safety review.
    if (hasInjection) {
      item.bucket = 'flagged';
      item.reason = 'Prompt-injection pattern in guest-supplied content — never auto-acted on';
      handover.flagged.push(item);
      continue;
    }

    if (hasContradiction || hasUnverifiedAmount || hasMissingRoom) {
      item.bucket = 'flagged';
      const reasons: string[] = [];
      if (hasContradiction) reasons.push('contradiction across sources');
      if (hasUnverifiedAmount) reasons.push('unverified charge / no approval');
      if (hasMissingRoom) reasons.push('room number missing');
      item.reason = `Needs human review: ${reasons.join('; ')}`;
      handover.flagged.push(item);
      continue;
    }

    if (latestAsOf.statusSignal === 'resolved') {
      if (beforeShift.length > 0 && inShift.length > 0) {
        item.bucket = 'newlyResolved';
        item.reason = 'Was open before tonight, resolved during this shift';
        handover.newlyResolved.push(item);
      } else if (inShift.length > 0) {
        item.bucket = 'fyi';
        item.reason = 'Opened and resolved within this shift';
        handover.fyi.push(item);
      }
      // Otherwise the thread was fully resolved on a previous shift — not relevant to this morning.
      continue;
    }

    if (beforeShift.length === 0) {
      item.bucket = 'newTonight';
      item.reason = 'First seen on this shift';
    } else if (!wasResolvedBefore) {
      item.bucket = 'stillOpen';
      item.reason = 'Carried over from a previous shift, not yet resolved';
    } else {
      // Was resolved before, re-opened this shift
      item.bucket = 'newTonight';
      item.reason = 'Was resolved previously, re-opened this shift';
    }

    if (item.priority === 'CRITICAL') {
      // Promote to onFire regardless of new/still-open distinction
      item.bucket = 'onFire';
      handover.onFire.push(item);
    } else if (item.bucket === 'stillOpen') {
      handover.stillOpen.push(item);
    } else {
      handover.newTonight.push(item);
    }
  }

  // Sort within each bucket by priority then earliest
  for (const k of ['onFire', 'stillOpen', 'newTonight', 'newlyResolved', 'flagged', 'fyi'] as const) {
    handover[k].sort(
      (a, b) =>
        priorityRank(a.priority) - priorityRank(b.priority) ||
        a.factDetails[0]!.occurredAt.localeCompare(b.factDetails[0]!.occurredAt),
    );
  }

  return handover;
}

function buildItem(t: Thread, factsUpToShiftEnd: Fact[]): HandoverItem {
  return {
    threadId: t.threadId,
    bucket: 'stillOpen',
    priority: t.priority,
    room: t.room,
    topic: t.topic,
    oneLiner: t.oneLiner,
    citations: factsUpToShiftEnd.map((f) => f.source.ref),
    factDetails: factsUpToShiftEnd.map((f) => ({
      ref: f.source.ref,
      kind: f.source.kind,
      occurredAt: f.occurredAt,
      text: f.text,
      flags: f.flags,
    })),
    flags: factsUpToShiftEnd.flatMap((f) => f.flags),
    reason: '',
  };
}

function isInWindow(ts: string, win: { start: string; end: string }): boolean {
  return ts >= win.start && ts <= win.end;
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
