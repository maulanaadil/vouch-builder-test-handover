export type TopicBucket =
  | 'aircon'
  | 'leak'
  | 'noise'
  | 'deposit'
  | 'compliance'
  | 'safe'
  | 'damage'
  | 'check_in'
  | 'check_out'
  | 'no_show'
  | 'lost_keycard'
  | 'wifi'
  | 'breakfast'
  | 'incident'
  | 'walk_in'
  | 'parcel'
  | 'guest_message'
  | 'finance'
  | 'other';

export type StatusSignal = 'opened' | 'updated' | 'resolved' | 'pending' | 'flagged';

export type SourceRef =
  | { kind: 'event'; ref: string; rawQuote: string }
  | { kind: 'night-log'; ref: string; rawQuote: string; approxTime?: string };

export type FlagKind =
  | 'missing-room'
  | 'missing-guest'
  | 'contradiction'
  | 'prompt-injection'
  | 'translated'
  | 'imminent-checkout'
  | 'unverified-amount';

export type Flag = { kind: FlagKind; detail: string };

export type Fact = {
  factId: string;
  source: SourceRef;
  occurredAt: string;
  occurredAtApprox?: boolean;
  room: string | null;
  guest: string | null;
  topic: TopicBucket;
  statusSignal: StatusSignal;
  text: string;
  flags: Flag[];
};

export type Priority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'FYI';
