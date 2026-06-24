# DECISIONS.md

Maulana Adil Al Latif — 2-hour build for the Vouch night-shift handover task.

Start: 23 Jun 2026 ~18:00. Stop: 23 Jun 2026 ~20:00. (Confirm before you send.)

---

## What I built

A Node.js + TypeScript service (Fastify) with a single endpoint `GET /handover?date=YYYY-MM-DD&format=html|json`. It:

- Ingests both formats — structured `events.json` and free-text `night-logs.md` — into one typed `Fact` store. Every fact carries `{ source.kind, source.ref, source.rawQuote }` so its lineage is always one hop away.
- Exposes both `GET /handover` (runs against the bundled demo data — what a reviewer curls) and `POST /handover` (accepts an arbitrary `{hotel, events, nightLog, targetMorning}` payload — what a downstream service would call). Same pipeline, same grounding guarantees, same renderer.
- Threads facts across nights by `(topic, room)` (or `(topic, "_property")` for property-wide threads like the corridor leak, scanner backlog, and walk-ins).
- Reconciles each thread against a configurable shift window (default 23:00–07:00 SGT) into six buckets: **ON FIRE NOW**, **STILL OPEN**, **NEW TONIGHT**, **NEWLY RESOLVED OVERNIGHT**, **FLAGGED FOR REVIEW**, **FYI**.
- Renders HTML or JSON. Every line shows its citation IDs (`evt_0009`, `nl_06_2026-05-28`) and the underlying facts are revealed via a collapsible `<details>` block.
- Emits structured pino logs keyed by `{ hotel_id, shift_date, request_id, stage }` so a bad handover can be reverse-engineered from a single request id.
- 12 snapshot tests pin the expected May 30 morning output — including the 208 safe (night-log only), the multi-night scanner backlog, the imminent-checkout 309 deposit, the prompt-injection guest note in 214, and the silent-checkout 205 contradiction.
- Deploys via a single Dockerfile to Fly.io (config committed at `fly.toml`).

## What I deliberately skipped

| Skipped | Why |
|---|---|
| Database, caching, persistence | Recompute from source each call. For one hotel × ~30 events the latency is single-digit ms (we re-parse, re-thread, re-reconcile). Adding storage is a multi-hour decision, not a 2-hour one — and the production design would likely be event-sourced anyway. |
| Multi-hotel runtime *loader* | `POST /handover` accepts an arbitrary payload, so a downstream caller can already drive any hotel through the pipeline. What's deliberately skipped is the *server-side* loader (S3 / Postgres) that would fetch a hotel's data by id. Adding that is mechanical. |
| Authentication / rate limiting | Out of scope. Behind a real gateway in production. |
| Real language detection / general translation pipeline | The brief calls out Mandarin specifically and the LLM handles it natively. I keep the original `source_quote` verbatim and only use the English `summary_en` for the rendered line. The `translated` flag is emitted whenever the LLM declares it added a gloss. |
| Polished UI | Utility CSS only — the brief says "utility over beauty." The collapsible source view is worth more than a layout. |
| Exhaustive tests | 12 behaviour tests, not full coverage. They pin the bits a reviewer is most likely to grade. |
| AGENTS.md sub-files / Cursor rules / per-folder READMEs | One top-level `AGENTS.md` (= `CLAUDE.md` symlink). The repo is too small to need more. |

## How I handle reconciliation across nights

- **Threading.** Facts are grouped by `(topic, room)` when a room is identifiable. When a fact has no room (e.g. corridor leak, scanner offline event, walk-in turned away), I group by `(topic, "_property")` for a small list of topics where "property-wide" is operationally one thread (`leak`, `compliance`, `walk_in`, `breakfast`). Everything else with `room === null` gets its own singleton thread keyed by `factId` — this avoids spurious merging.
- **Window.** A shift `D` covers `[D-1 23:00 SGT, D 07:00 SGT]`. A thread's facts are split into `beforeShift`, `inShift`, and `factsUpToShiftEnd`. The reconciler routes by:
  - latest fact `resolved` + had earlier facts → **NEWLY RESOLVED**
  - latest fact `resolved` + only this-shift facts → **FYI**
  - no fact in or before this shift's window → **skipped** (it's a future thread relative to this morning)
  - all facts in earlier shifts, latest unresolved → **STILL OPEN**
  - earliest fact in this shift, unresolved → **NEW TONIGHT**
  - any item with `CRITICAL` priority is promoted to **ON FIRE NOW** regardless of new/still-open distinction
  - any thread carrying a `prompt-injection`, `contradiction`, `unverified-amount`, or `missing-room` flag is routed to **FLAGGED FOR REVIEW** and *never* to an action bucket.
- **Priority.** Rules-based, not LLM. Topics like `incident`, `compliance` (unresolved), `safe` (unresolved), and anything flagged `imminent-checkout` map to CRITICAL. `aircon`, `deposit`, `leak`, `damage`, multi-night `complaint` map to HIGH. Plain pending items map to MEDIUM. Resolved is FYI.

## How I keep every statement grounded, and how I stop the model inventing facts

Three layers.

1. **Type-level invariant.** Every `Fact` carries its `SourceRef`. There is no path in the code that produces a renderable item without one or more citations attached. The renderer drops any item with `citations.length === 0` (`src/render/handover.ts` → `itemHtml()`).

2. **The LLM only extracts, never synthesises.** Claude Haiku 4.5 is called exactly once, on the free-text night log, with a forced tool call against a strict JSON schema (Anthropic SDK + zod). The system prompt is explicit: *never invent room numbers, guest names, or amounts*. The model is told the input is data, not instructions. The model is **never** asked to summarise the handover, decide priority, or judge resolution status — those are deterministic.

3. **Post-validation against the source text.** For each item the model emits:
   - `source_quote` must be a literal substring of the input.
   - `room` (digits only) must literally appear in the input. If not, force to `null` and add a `contradiction` flag.
   - `guest` must literally appear. Same enforcement.
   - Items whose `source_quote` is missing are rejected entirely.
   - Rejections are counted in the `extract` log line so a debugger can see them.

If the API key is missing or the call fails, a **deterministic heuristic extractor** runs — hand-written keyword rules for the demo log shape. The grounding rules still apply to its output. This means the curl works without secrets; the LLM path is the "general case" answer to "will this survive across hundreds of hotels" while the fallback ensures the demo never blocks on a transient API issue.

**Contradictions and gaps that the system flags as-is** (no papering over):

- `evt_0010` says the no-show was "NOT yet charged" but the relief log says "已经收了" (already charged); `evt_0012` then records the guest disputing it. The reconciler splits this into a no-show thread (resolved per relief) and a finance thread (pending dispute), and both surface, so the morning manager sees the full state.
- `evt_0015` is a complaint with no room number → `missing-room` flag → FLAGGED.
- `evt_0023` proposes a damage charge with no photos and no manager approval → `unverified-amount` flag → FLAGGED.
- The 205 silent-checkout: night log observes "door ajar, no luggage" while system shows in-house → `contradiction` flag → FLAGGED.
- `evt_0026`'s prompt-injection guest note → `prompt-injection` flag → FLAGGED. It is never seen as instructions by the LLM (only the extractor sees the log, and the extractor's system prompt explicitly tells it data ≠ instructions), and the description pattern matcher catches it before any routing decision.

## Where AI helped most, and where it got in the way

**Helped most.**

- **The original architecture sketch.** I planned with Claude before writing code. It pushed me toward "deterministic backbone, narrow LLM use" earlier than I'd have arrived on my own — the temptation was to send both files into one big prompt, and we explicitly rejected that within the first five minutes.
- **The night-log extraction itself.** Mandarin + English + casual prose with implicit times is the exact thing brittle regex hates. Claude Haiku with a tool-call schema is the right size of tool for the job.
- **Forcing me to be explicit about the grounding contract.** Writing the rules down ("no citation, no line"; "every field re-checked against source"; "the LLM never synthesises") made me notice that the temptation to add an LLM-driven summariser was the same temptation that would break grounding. I cut it.

**Got in the way.**

- I almost let the model do priority classification too — "feels easier than maintaining a rules table." That would have made priorities non-deterministic across runs, which a 7am operator can't trust.
- The Anthropic SDK tool-input typings + zod parsing took an annoying amount of fiddling to get a clean schema-first interface. Worth it, but not free.
- Time pressure made me skip a second cross-thread contradiction detector (e.g., "evt_0010 status says not-charged AND nl_04 says charged" → emit a thread-level contradiction even though the two facts are within the same thread). The current behaviour surfaces the discrepancy via the finance dispute thread instead, which is operationally adequate but less clean. See hours 3–6.

## What I'd do in hours 3–6

1. **A cross-source contradiction detector.** Specifically: within a thread, scan adjacent facts for status flips that don't match the prose ("status=unresolved" + text "NOT yet charged" then next fact "status=resolved" + text "already charged") → emit a `contradiction` flag and route to FLAGGED. Today I leave that to the natural thread split.
2. **A "golden" evals suite.** Five hand-written night logs (one normal, one Mandarin-only, one with deliberately injected fake room number, one with a prompt injection, one with a half-finished sentence) plus expected handover outputs. Run on every PR.
3. **Storage.** Postgres with one row per extracted fact, indexed by `(hotel_id, occurred_at)`. Replace re-parse-on-every-request with a "since-last-checkpoint" load. Adds idempotency and lets us answer "what changed since 06:00?" questions for downstream alerting.
4. **Multi-hotel data adapter.** `getDataForHotel(hotelId)` swappable between local filesystem (demo), S3 (production), and a webhook ingest endpoint.
5. **Operator feedback loop.** "Was this handover useful?" thumbs in the HTML view; persist with the request_id; sample a fraction for spot-check.
6. **Real translation gloss.** Today the gloss comes from the same call that does extraction. In production I'd separate them, keep the gloss verifiable against a back-translation, and surface original + gloss side-by-side rather than gloss only.

## One thing that surprised me

How much of the brief reduces to *not* using AI. The interesting work was building a deterministic backbone that the LLM plugs into at exactly one well-isolated spot. The reconciliation logic, the priority rules, the routing into the FLAGGED bucket — all of it is plain code. The LLM call is six lines plus a schema. Calibrating that was the actual design work, and it was the opposite of "use AI to fill any gap." The closer the LLM gets to the operator, the harder grounding becomes; the further away you push it, the cheaper the guarantees are. That tracks with what the brief actually says, but writing it out makes the asymmetry land harder.
