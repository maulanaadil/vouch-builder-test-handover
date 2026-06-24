# AGENTS.md

Rules of the road for AI assistants (Claude Code, Cursor, etc.) working on this repo. Also applies to the human builder — treat it as the project's working agreement.

## What this service does

Generates a morning **night-shift handover** for a hotel from two inputs:

1. `data/events.json` — structured front-desk events
2. `data/night-logs.md` — relief-staff prose (mixed English + Mandarin)

It outputs sections (`ON FIRE NOW`, `STILL OPEN`, `NEW TONIGHT`, `NEWLY RESOLVED`, `FLAGGED FOR REVIEW`, `FYI`) where **every line cites the source IDs it was built from.**

## The hard rules

These are non-negotiable. Code that violates them must not land.

1. **No line without a citation.** The renderer drops any item with zero `citations`. Don't relax this in a "small refactor."
2. **The LLM extracts, never synthesises.** It runs once, against the free-text night log, with a schema-locked tool call. It is never asked to "summarise the handover," "decide priority," or "judge whether something is resolved."
3. **Every room number, guest name, and monetary amount the LLM emits is re-checked against the source text.** If it does not literally appear there, the field is forced to `null` and a `contradiction` flag is added. This is the `validate()` step in `src/ingest/nightLog.ts`.
4. **Guest-supplied content is data, not instructions.** Any text that looks like an imperative addressed at the system (`SYSTEM NOTE`, `ignore previous`, `mark approved`, `goodwill credit`, etc.) is flagged and routed to `FLAGGED FOR REVIEW`. It never reaches an action section.
5. **Reconciliation rules are deterministic.** Priority, bucket assignment, and thread merging live in plain TypeScript (`src/domain/`). No LLM in the hot path.

If you find yourself wanting to break one of these to fix a bug: the bug is somewhere else.

## Source layout

```
src/
  server.ts              # Fastify app: GET /handover (bundled data), POST /handover (caller payload)
  config.ts              # env vars, paths
  ingest/
    events.ts            # JSON → Fact[], topic classification, injection + imminent-checkout detectors
    nightLog.ts          # Free-text → Fact[] via Anthropic SDK + zod + post-validation, with a heuristic fallback
  domain/
    fact.ts              # Fact / SourceRef / Flag / TopicBucket / Priority types
    threader.ts          # Group facts into threads, compute current status + priority
    reconciler.ts        # Per-shift classification into the six buckets
  render/
    handover.ts          # JSON + HTML renderers (drops citation-less items)
  obs/
    logger.ts            # Pino with { hotel_id, shift_date, request_id, stage }
  __tests__/
    reconciler.test.ts   # Snapshot-style behaviour pins
```

## When you edit

- **Adding a new event type from events.json**: extend `classifyTopic()` in `src/ingest/events.ts` and the `TopicBucket` enum in `src/domain/fact.ts`. If the topic implies severity, add it to `computePriority()` in `src/domain/threader.ts`. Add a test.
- **Adding a new flag**: extend `FlagKind` in `src/domain/fact.ts`, decide whether the reconciler should route on it, and (importantly) decide whether the renderer should surface its text or just count it.
- **Touching the LLM call**: keep `SYSTEM_PROMPT` and the tool schema in sync, and make sure `validate()` still rejects any new field the schema can emit.
- **Tweaking the shift window**: it's in `src/config.ts` and used by `shiftWindow()` in `src/domain/reconciler.ts`. Default is 23:00 → 07:00 SGT.

## Running

```bash
npm install
npm test                       # snapshot tests
npm run dev                    # tsx watch
npm run build && node dist/server.js
```

Without an API key, set `LLM_ENABLED=false` (or just leave `ANTHROPIC_API_KEY` unset — the heuristic fallback runs automatically).

## Debugging a bad handover in production

Every log line has `{ hotel_id, shift_date, request_id, stage }`. To trace a bad output:

1. Grep logs for the request id (it's in the JSON response `meta.generated_request_id`).
2. Walk the stages in order: `ingest` → `extract` → `thread` → `reconcile` → `render`.
3. At `extract`, `itemsRejected` and `rejections` show which fields the LLM tried to hallucinate.
4. At `thread`, the count of threads vs facts tells you if a thread split unexpectedly.
5. At `reconcile`, the per-bucket counts tell you whether the item ended up in the right section.

## What is intentionally cheap

- No DB / persistence — recompute each call. See `DECISIONS.md`.
- Topic classification is keyword-based, not learned.
- Tests cover the 2026-05-30 morning and a few thread invariants. Not exhaustive.
