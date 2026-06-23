import type { Fact, TopicBucket, Priority, StatusSignal } from './fact.js';

export type Thread = {
  threadId: string;
  room: string | null;
  topic: TopicBucket;
  guests: string[];
  facts: Fact[];
  earliest: string;
  latest: string;
  currentStatus: StatusSignal;
  priority: Priority;
  oneLiner: string;
  citations: string[];
  hasFlags: boolean;
};

const PROPERTY_WIDE_TOPICS: TopicBucket[] = ['leak', 'compliance', 'walk_in', 'breakfast'];

function threadKey(fact: Fact): string {
  if (fact.room) return `${fact.topic}:${fact.room}`;
  if (PROPERTY_WIDE_TOPICS.includes(fact.topic)) return `${fact.topic}:_property`;
  return `${fact.topic}:${fact.factId}`;
}

export function threadFacts(facts: Fact[]): Thread[] {
  const groups = new Map<string, Fact[]>();
  for (const f of facts) {
    const key = threadKey(f);
    const arr = groups.get(key) ?? [];
    arr.push(f);
    groups.set(key, arr);
  }

  const threads: Thread[] = [];
  for (const [key, group] of groups) {
    group.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const guests = Array.from(new Set(group.map((g) => g.guest).filter((x): x is string => !!x)));
    const currentStatus = computeCurrentStatus(group);
    const citations = group.map((g) => g.source.ref);
    const priority = computePriority(group, currentStatus);
    const oneLiner = buildOneLiner(group, last, guests);

    threads.push({
      threadId: `thread_${key.replace(/[^a-z0-9_]+/gi, '_')}`,
      room: first.room,
      topic: first.topic,
      guests,
      facts: group,
      earliest: first.occurredAt,
      latest: last.occurredAt,
      currentStatus,
      priority,
      oneLiner,
      citations,
      hasFlags: group.some((f) => f.flags.length > 0),
    });
  }
  threads.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.earliest.localeCompare(b.earliest));
  return threads;
}

function computeCurrentStatus(group: Fact[]): StatusSignal {
  const last = group[group.length - 1]!;
  if (group.some((f) => f.flags.some((fl) => fl.kind === 'prompt-injection'))) return 'flagged';
  return last.statusSignal;
}

function computePriority(group: Fact[], status: StatusSignal): Priority {
  const flags = group.flatMap((f) => f.flags);
  const topics = new Set(group.map((g) => g.topic));

  if (topics.has('incident')) return status === 'resolved' ? 'MEDIUM' : 'CRITICAL';
  if (flags.some((f) => f.kind === 'imminent-checkout') && status !== 'resolved') return 'CRITICAL';
  if (topics.has('compliance') && status !== 'resolved') return 'CRITICAL';
  if (topics.has('safe') && status !== 'resolved') return 'CRITICAL';
  if (topics.has('leak') && status !== 'resolved') return 'HIGH';
  if (topics.has('aircon') && status !== 'resolved') return 'HIGH';
  if (topics.has('deposit') && status !== 'resolved') return 'HIGH';
  if (topics.has('damage') && status === 'pending') return 'HIGH';
  if (topics.has('finance') && status === 'pending') return 'HIGH';
  if (topics.has('guest_message') && flags.some((f) => f.kind === 'prompt-injection')) return 'HIGH';
  if (status === 'pending') return 'MEDIUM';
  if (status === 'opened') return 'MEDIUM';
  return 'FYI';
}

export function priorityRank(p: Priority): number {
  switch (p) {
    case 'CRITICAL': return 0;
    case 'HIGH': return 1;
    case 'MEDIUM': return 2;
    case 'FYI': return 3;
  }
}

function buildOneLiner(group: Fact[], last: Fact, guests: string[]): string {
  // Deterministic, source-grounded: room + topic + latest fact's text (truncated).
  const room = last.room ? `Room ${last.room}` : 'Property-wide';
  const guestPart = guests.length ? ` (${guests.join(', ')})` : '';
  const topicLabel = TOPIC_LABELS[last.topic] ?? last.topic;
  const latestText = clip(last.text, 220);
  return `${room}${guestPart} — ${topicLabel}: ${latestText}`;
}

const TOPIC_LABELS: Record<TopicBucket, string> = {
  aircon: 'Aircon',
  leak: 'Leak',
  noise: 'Noise complaint',
  deposit: 'Deposit',
  compliance: 'Compliance / immigration',
  safe: 'In-room safe',
  damage: 'Damage report',
  check_in: 'Check-in',
  check_out: 'Check-out',
  no_show: 'No-show',
  lost_keycard: 'Lost keycard',
  wifi: 'Wifi',
  breakfast: 'Breakfast complaint',
  incident: 'Guest incident',
  walk_in: 'Walk-in',
  parcel: 'Parcel held',
  guest_message: 'Guest message',
  finance: 'Finance note',
  other: 'Other',
};

function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}
