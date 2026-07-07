// site/js/render.js — pure render functions over the migration-005 view shapes.
//
// Every function here is a pure (data) -> HTML-string transform. No DOM, no fetch,
// no globals — so site/site.test.ts can import and unit-test them under node --test
// against fixture JSON, and the browser (site/js/app.js) can inject the strings.
//
// View contract (schema/005_public_window.sql), reproduced so this file is the one
// place the column names live:
//   public_census    : id, name, charter_line, class, brain_tier, status,
//                       parent_ids, shard_id, created_at
//   public_chronicle : id, ts, kind, body, author_resident_id, author_name, author_class
//   public_panel     : id, name, seat, standing_question, status, created_at
//   public_stats     : residents_active, panel_seats, findings_published, shards,
//                       conservation_holds
//
// The honesty frame (LAUNCH_PLAN §2, §5): every number rendered is passed in from a
// live fetch or a clearly-DEMO fixture — never invented here. When a collection is
// empty, these functions render a plain, declarative absent state, never a placeholder
// row and never a fabricated count. The record IS the show.

// ── escaping ──────────────────────────────────────────────────────────────────
// All view content is treated as untrusted text. It reaches the page only through
// escapeHtml (for element text) — attributes here are author-controlled constants.

export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── small honesty helpers ───────────────────────────────────────────────────────

// A count is rendered only when it is a real non-negative integer we were handed.
// Anything absent renders as an em-dash placeholder that reads as "not yet known",
// never as zero-dressed-as-data.
export function renderCount(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return String(value);
  }
  return "—"; // em dash — the record does not yet answer this
}

// Conservation is a truth value from economy_conservation; three honest states.
export function renderConservation(holds) {
  if (holds === true) return "the ledger balances";
  if (holds === false) return "the ledger does not balance";
  return "not yet measured";
}

// A short ISO date (the founding record is dated, never live-clocked).
export function formatDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return escapeHtml(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Lineage line: residents with parents are branch/merge nodes; note it plainly.
function lineageNote(parent_ids) {
  if (!Array.isArray(parent_ids) || parent_ids.length === 0) return "";
  if (parent_ids.length === 1) return "branched from one forebear";
  return `merged from ${parent_ids.length} forebears`;
}

// ── the empty / absent state ────────────────────────────────────────────────────
// One shape for every "the record begins soon" moment, so no page ever fakes fullness.

export function renderEmpty(message) {
  return `<p class="empty">${escapeHtml(message)}</p>`;
}

// ── /  the Door (stats) ─────────────────────────────────────────────────────────

// The Door shows the one true number: residents currently living. Absent stats render
// an honest "not yet founded" line rather than a zero.
export function renderDoorStat(stats) {
  if (!stats || typeof stats.residents_active !== "number") {
    return `<p class="stat-absent">The record begins soon — the founding has not yet been read.</p>`;
  }
  const n = stats.residents_active;
  if (n === 0) {
    return `<p class="stat-absent">No residents live here yet. The founding is imminent.</p>`;
  }
  const noun = n === 1 ? "resident" : "residents";
  return `<p class="stat"><span class="stat-number">${renderCount(n)}</span> <span class="stat-label">${noun} live here.</span></p>`;
}

// A fuller stats strip used on the Door beneath the headline number.
export function renderStatsStrip(stats) {
  if (!stats) return renderEmpty("The record begins soon.");
  const rows = [
    ["residents", renderCount(stats.residents_active)],
    ["panel seats", renderCount(stats.panel_seats)],
    ["findings", renderCount(stats.findings_published)],
    ["shards", renderCount(stats.shards)],
  ];
  const items = rows
    .map(
      ([label, value]) =>
        `<div class="stat-cell"><span class="stat-cell-number">${value}</span><span class="stat-cell-label">${escapeHtml(
          label,
        )}</span></div>`,
    )
    .join("");
  const ledger = `<div class="stat-cell stat-cell--wide"><span class="stat-cell-number">${escapeHtml(
    renderConservation(stats.conservation_holds),
  )}</span><span class="stat-cell-label">conservation</span></div>`;
  return `<div class="stats-strip">${items}${ledger}</div>`;
}

// ── /census  the Census ──────────────────────────────────────────────────────────

// One census row. Panel residents are NOT rendered here — they are offices, listed on
// /panel; the caller filters class==='panel' out before calling renderCensus.
export function renderCensusRow(r) {
  const lineage = lineageNote(r.parent_ids);
  const meta = [r.class, r.brain_tier, r.status]
    .filter(Boolean)
    .map((x) => `<span class="tag">${escapeHtml(x)}</span>`)
    .join("");
  const lineageEl = lineage
    ? `<span class="lineage">${escapeHtml(lineage)}</span>`
    : "";
  return `<article class="census-row">
  <h3 class="census-name">${escapeHtml(r.name)}</h3>
  <p class="census-charter">${escapeHtml(r.charter_line)}</p>
  <div class="census-meta">${meta}${lineageEl}</div>
</article>`;
}

export function renderCensus(rows) {
  const residents = Array.isArray(rows)
    ? rows.filter((r) => r && r.class !== "panel")
    : [];
  if (residents.length === 0) {
    return renderEmpty(
      "No residents in the census yet. The first cohort is forged at the founding.",
    );
  }
  return `<div class="census-list">${residents.map(renderCensusRow).join("\n")}</div>`;
}

// ── /chronicle  the Chronicle ────────────────────────────────────────────────────

// The chronicle body is a jsonb object in the view. We surface a title/text if present,
// falling back to a plain stringification — never inventing content. Findings can be long;
// the Chronicle is where depth lives (the Divergence: reachable, not fronted).
function chronicleBodyText(body) {
  if (body === null || body === undefined) return "";
  if (typeof body === "string") return body;
  if (typeof body === "object") {
    // Preferred readable fields, in order. `reflection` is the LIVE Pulse shape that
    // carries the society's actual thoughts ({fired_by, reflection} — cohort 'work' and
    // Panel 'finding'/observation entries); the rest cover the founding entries
    // ({title,text} etc). Without `reflection` first, every autonomous reflection renders
    // as an empty shell (the mute-record bug, ULTRA_SWEEP 2026-07-06 SEV).
    const text =
      body.reflection ??
      body.text ??
      body.summary ??
      body.record ??
      body.note ??
      body.title;
    if (typeof text === "string") return text;
    // Birth entries carry no prose — only {at, name, class, event}. State the fact
    // plainly from the literal event field (translation, not invention); the name and
    // date already show in the byline and entry-date.
    if (body.event === "birth") return "Entered the register.";
  }
  return "";
}

function chronicleTitle(body) {
  if (body && typeof body === "object" && typeof body.title === "string") {
    return body.title;
  }
  return "";
}

export function renderChronicleEntry(e) {
  const title = chronicleTitle(e.body);
  const text = chronicleBodyText(e.body);
  const byline = e.author_name
    ? `${e.author_name}${e.author_class ? `, ${e.author_class}` : ""}`
    : "unattributed";
  const titleEl = title
    ? `<h3 class="entry-title">${escapeHtml(title)}</h3>`
    : "";
  const textEl = text
    ? `<div class="entry-body">${escapeHtml(text)
        .split("\n\n")
        .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
        .join("")}</div>`
    : "";
  return `<article class="entry entry--${escapeHtml(e.kind)}">
  <div class="entry-head">
    <span class="entry-kind">${escapeHtml(e.kind)}</span>
    <span class="entry-date">${formatDate(e.ts)}</span>
  </div>
  ${titleEl}
  ${textEl}
  <p class="entry-byline">— ${escapeHtml(byline)}</p>
</article>`;
}

// Newest first. The caller may pass rows already ordered by the view; we sort defensively
// by ts descending so the record always reads present-to-past.
export function renderChronicle(rows) {
  const entries = Array.isArray(rows) ? rows.slice() : [];
  if (entries.length === 0) {
    return renderEmpty(
      "The chronicle is empty. Its first entry is the founding record.",
    );
  }
  entries.sort((a, b) => {
    const ta = new Date(a.ts).getTime() || 0;
    const tb = new Date(b.ts).getTime() || 0;
    return tb - ta;
  });
  return `<div class="chronicle-list">${entries.map(renderChronicleEntry).join("\n")}</div>`;
}

// ── /panel  the Panel ────────────────────────────────────────────────────────────

export function renderPanelSeat(seat) {
  const held = seat.name && String(seat.name).trim().length > 0;
  const holder = held
    ? `<p class="seat-holder">Held by ${escapeHtml(seat.name)}.</p>`
    : `<p class="seat-holder seat-holder--vacant">Vacant.</p>`;
  const statusEl =
    seat.status && seat.status !== "active"
      ? ` <span class="tag">${escapeHtml(seat.status)}</span>`
      : "";
  return `<article class="seat">
  <h3 class="seat-name">${escapeHtml(seat.seat)}${statusEl}</h3>
  <p class="seat-question">${escapeHtml(seat.standing_question)}</p>
  ${holder}
</article>`;
}

export function renderPanel(rows) {
  const seats = Array.isArray(rows) ? rows : [];
  if (seats.length === 0) {
    return renderEmpty(
      "The Panel has not yet been seated. Its six offices are constituted at the founding.",
    );
  }
  return `<div class="seat-list">${seats.map(renderPanelSeat).join("\n")}</div>`;
}

// ── a shared error banner (network trouble in live mode — honest, not silent) ─────

export function renderError(message) {
  return `<p class="load-error">The record could not be read: ${escapeHtml(
    message,
  )}</p>`;
}
