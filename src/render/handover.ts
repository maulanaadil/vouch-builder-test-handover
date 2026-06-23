import type { Fact } from '../domain/fact.js';
import type { Handover, HandoverItem } from '../domain/reconciler.js';

type Meta = {
  hotel: { id: string; name: string; rooms: number; timezone: string };
  date: string;
  requestId: string;
};

export function renderHandoverJson(
  h: Handover,
  meta: Meta & { facts: Fact[] },
) {
  return {
    meta: {
      hotel: meta.hotel,
      shift_date: meta.date,
      shift_window: h.shiftWindow,
      generated_request_id: meta.requestId,
      grounding_policy:
        'Every item lists every source it relies on under "citations". Renderer drops any item with no citations. Rooms/guests/amounts emitted by the LLM are rejected unless they appear literally in the source text.',
    },
    sections: {
      on_fire: h.onFire,
      still_open: h.stillOpen,
      new_tonight: h.newTonight,
      newly_resolved: h.newlyResolved,
      flagged_for_review: h.flagged,
      fyi: h.fyi,
    },
    sources_loaded: dedupSources(meta.facts),
  };
}

function dedupSources(facts: Fact[]) {
  const events = facts.filter((f) => f.source.kind === 'event').length;
  const night = facts.filter((f) => f.source.kind === 'night-log').length;
  return { events, night_log_entries: night };
}

export function renderHandoverHtml(h: Handover, meta: Meta): string {
  const head = `<!doctype html><html><head><meta charset="utf-8"><title>Handover ${esc(meta.date)} — ${esc(meta.hotel.name)}</title>${STYLE}</head><body>`;
  const banner = `<h1>HANDOVER — ${formatDate(meta.date)}</h1>
    <p class="meta">${esc(meta.hotel.name)} (${esc(meta.hotel.id)}) · shift window ${esc(h.shiftWindow.start)} → ${esc(h.shiftWindow.end)} · req <code>${esc(meta.requestId)}</code></p>
    <p class="meta">Every line below cites the source IDs it was built from. No citation, no line.</p>`;

  const sections = [
    section('🔥 ON FIRE NOW', h.onFire, 'Take action this morning. Critical or imminent.'),
    section('📌 STILL OPEN', h.stillOpen, 'Carried over from previous shifts.'),
    section('🆕 NEW TONIGHT', h.newTonight, 'First seen on this shift.'),
    section('✅ NEWLY RESOLVED OVERNIGHT', h.newlyResolved, 'Was open before, handled overnight.'),
    section('⚠️ FLAGGED FOR REVIEW', h.flagged, 'Contradictions, gaps, or guest-supplied content that looked like instructions. NEVER auto-acted on.'),
    section('🗒️ FYI', h.fyi, 'Opened and resolved within this shift, or low-signal notes.'),
  ].join('\n');

  return head + banner + sections + '</body></html>';
}

function section(title: string, items: HandoverItem[], subtitle: string): string {
  if (items.length === 0) {
    return `<section><h2>${esc(title)}</h2><p class="subtitle">${esc(subtitle)}</p><p class="empty">— none —</p></section>`;
  }
  const list = items.map(itemHtml).join('\n');
  return `<section><h2>${esc(title)}</h2><p class="subtitle">${esc(subtitle)}</p><ul>${list}</ul></section>`;
}

function itemHtml(it: HandoverItem): string {
  if (it.citations.length === 0) {
    // Renderer invariant: no citation, no line.
    return '';
  }
  const cites = it.citations.map((c) => `<code>${esc(c)}</code>`).join(', ');
  const prio = `<span class="prio prio-${it.priority.toLowerCase()}">${esc(it.priority)}</span>`;
  const flags = it.flags.length
    ? `<div class="flags">${it.flags.map((f) => `<span class="flag flag-${esc(f.kind)}">${esc(f.kind)}: ${esc(f.detail)}</span>`).join(' ')}</div>`
    : '';
  const facts = it.factDetails
    .map((f) => `<li class="fact"><code>${esc(f.ref)}</code> <span class="kind">${esc(f.kind)}</span> @ ${esc(f.occurredAt)}<br>${esc(f.text)}</li>`)
    .join('');
  return `<li class="thread">
    ${prio} <strong>${esc(it.oneLiner)}</strong>
    <div class="reason">${esc(it.reason)}</div>
    ${flags}
    <details><summary>Sources [${cites}]</summary><ul class="facts">${facts}</ul></details>
  </li>`;
}

function formatDate(d: string): string {
  try {
    const dt = new Date(`${d}T00:00:00Z`);
    return dt.toUTCString().slice(0, 16) + ' (shift ending 07:00 SGT)';
  } catch {
    return d;
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLE = `<style>
  body { font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; max-width: 880px; margin: 24px auto; padding: 0 16px; color: #1a1a1a; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  h2 { margin: 24px 0 4px; font-size: 16px; border-bottom: 1px solid #e5e5e5; padding-bottom: 4px; }
  .meta, .subtitle { color: #666; margin: 2px 0; font-size: 12px; }
  .empty { color: #999; font-style: italic; }
  ul { padding-left: 18px; }
  li.thread { margin: 10px 0; padding: 8px 12px; background: #fafafa; border-left: 3px solid #ccc; }
  .prio { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 3px; margin-right: 6px; vertical-align: middle; color: white; }
  .prio-critical { background: #c62828; }
  .prio-high { background: #ef6c00; }
  .prio-medium { background: #1565c0; }
  .prio-fyi { background: #555; }
  .reason { color: #555; font-size: 12px; margin: 4px 0; }
  .flags { margin: 4px 0; }
  .flag { display: inline-block; font-size: 11px; background: #fff3cd; border: 1px solid #ffeeba; padding: 1px 5px; border-radius: 3px; margin-right: 4px; }
  .flag-prompt-injection { background: #f8d7da; border-color: #f5c6cb; }
  .flag-contradiction { background: #ffe0b2; border-color: #ffcc80; }
  details { margin-top: 4px; }
  details summary { cursor: pointer; font-size: 12px; color: #444; }
  ul.facts { margin: 4px 0 0; padding-left: 16px; }
  li.fact { font-size: 12px; color: #333; margin: 4px 0; }
  .kind { color: #888; font-size: 11px; }
  code { background: #eef; padding: 0 3px; border-radius: 2px; font-size: 11px; }
</style>`;
