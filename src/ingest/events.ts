import { readFile } from 'node:fs/promises';
import type { Fact, TopicBucket, StatusSignal, Flag } from '../domain/fact.js';

type RawEvent = {
  id: string;
  timestamp: string;
  type: string;
  room: string | null;
  guest: string | null;
  description: string;
  status: 'resolved' | 'unresolved' | 'pending';
};

type RawFile = {
  hotel: { id: string; name: string; rooms: number; timezone: string };
  events: RawEvent[];
};

export type EventsIngestResult = {
  hotel: RawFile['hotel'];
  facts: Fact[];
};

const STATUS_MAP: Record<RawEvent['status'], StatusSignal> = {
  resolved: 'resolved',
  unresolved: 'opened',
  pending: 'pending',
};

export async function ingestEventsFile(path: string): Promise<EventsIngestResult> {
  const text = await readFile(path, 'utf8');
  const parsed = JSON.parse(text) as RawFile;
  const facts = parsed.events.map(toFact);
  return { hotel: parsed.hotel, facts };
}

export function toFact(e: RawEvent): Fact {
  const topic = classifyTopic(e.type, e.description);
  const flags: Flag[] = [];

  if (e.room === null && needsRoom(e.type)) {
    flags.push({ kind: 'missing-room', detail: 'Event references no room number' });
  }

  if (isPromptInjection(e.description)) {
    flags.push({
      kind: 'prompt-injection',
      detail: 'Description contains imperative language targeting the handover system',
    });
  }

  if (isImminentCheckoutContext(e.description)) {
    flags.push({
      kind: 'imminent-checkout',
      detail: 'Mentions guest leaving / checking out imminently',
    });
  }

  if (e.type === 'damage_report' && /no photos|no manager approval|not approved/i.test(e.description)) {
    flags.push({
      kind: 'unverified-amount',
      detail: 'Damage charge proposed without photos or manager approval',
    });
  }

  return {
    factId: `fact_${e.id}`,
    source: { kind: 'event', ref: e.id, rawQuote: e.description },
    occurredAt: e.timestamp,
    room: e.room,
    guest: e.guest,
    topic,
    statusSignal: STATUS_MAP[e.status],
    text: e.description,
    flags,
  };
}

const NOISE_KW = /noise|loud|shouting|music/i;
const LEAK_KW = /leak|water|wet floor|flood/i;
const AIRCON_KW = /aircon|a\/c|cooling|compressor/i;
const SCANNER_KW = /scanner|passport.*scan|immigration/i;
const SAFE_KW = /safe(?: doesn't open| won't open| broken)?|in-?room safe/i;
const BREAKFAST_KW = /breakfast|kitchen/i;
const WIFI_KW = /wifi|wi-?fi|internet/i;
const PARCEL_KW = /parcel|package|courier/i;

function classifyTopic(type: string, description: string): TopicBucket {
  switch (type) {
    case 'check_in':
    case 'check_in_issue':
      return 'check_in';
    case 'early_checkout_request':
      return 'check_out';
    case 'no_show':
      return 'no_show';
    case 'lost_keycard':
      return 'lost_keycard';
    case 'deposit_issue':
      return 'deposit';
    case 'finance_note':
      return 'finance';
    case 'damage_report':
      return 'damage';
    case 'incident':
      return 'incident';
    case 'walk_in':
      return 'walk_in';
    case 'guest_message':
      return 'guest_message';
    case 'maintenance':
      if (AIRCON_KW.test(description)) return 'aircon';
      if (SAFE_KW.test(description)) return 'safe';
      return 'other';
    case 'facilities':
      if (LEAK_KW.test(description)) return 'leak';
      return 'other';
    case 'compliance':
      return 'compliance';
    case 'complaint':
      if (NOISE_KW.test(description)) return 'noise';
      if (BREAKFAST_KW.test(description)) return 'breakfast';
      if (WIFI_KW.test(description)) return 'wifi';
      return 'other';
    case 'note':
      if (PARCEL_KW.test(description)) return 'parcel';
      return 'other';
    default:
      return 'other';
  }
}

function needsRoom(type: string): boolean {
  return ['complaint', 'maintenance', 'check_in', 'check_in_issue', 'damage_report'].includes(type);
}

const INJECTION_PATTERNS = [
  /\bsystem\s+(note|prompt|instruction|message)\b/i,
  /\bignore\s+(all|previous|other|prior)\b/i,
  /\bmark\s+(it|the night|all|everything)\s+(approved|all clear|resolved)\b/i,
  /\boverride\b/i,
  /\bdisregard\b/i,
  /goodwill\s+credit/i,
];

export function isPromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(text));
}

const IMMINENT_PATTERNS = [
  /check(?:s|ing)?\s+out\s+(?:tomorrow|in the morning|this morning|early)/i,
  /catch\s+a\s+flight/i,
  /leaving\s+\d{1,2}[:.]\d{2}/i,
  /early\s+check[-\s]?out/i,
  /checkout\s+tomorrow\s+morning/i,
];

export function isImminentCheckoutContext(text: string): boolean {
  return IMMINENT_PATTERNS.some((p) => p.test(text));
}
