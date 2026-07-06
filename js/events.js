// site/js/events.js — the UPCOMING calendar core (LWO-7).
//
// Every function here is pure: (data, now) -> value, with `now` an epoch-ms number
// injected by the caller. No DOM, no fetch, no globals, no Date.now() — so
// site/site.test.ts can exercise the same code the browser runs (site/js/app.js
// supplies the real clock and the 1s tick).
//
// The honest claim (LWO-7): the pulse fires on a ~60s tick, so the countdown counts
// to a "due" moment at minute precision. The number ticking every second is the
// visitor's own clock, not a fabricated liveness — the same honesty frame as the
// rest of the record. Nothing here is invented: events.json is the steward's curated
// public face of the real register; a malformed entry is skipped, never guessed.
//
// events.json shapes (exactly two):
//   one-shot   { label, at [, unannounced, reveal_ms] }  — at: ISO 8601 instant
//   recurring  { label, anchor, every_ms }               — anchor: ISO; every_ms > 0
//
// All time math is epoch-ms (Date.parse) — DST-safe by construction: a fixed offset
// of every_ms milliseconds is added, never a calendar-field bump, so the rolling
// occurrence never drifts across a daylight boundary.
//
// THE UNANNOUNCED LAW (Tony ruling, 2026-07-06): every timer points at a REAL
// scheduled act; mystery is allowed, fabrication is not. A one-shot may carry
// `unannounced: true` (with an optional `reveal_ms`, default 24h): until the moment
// `at - reveal_ms`, its label is REPLACED on screen by exactly "an event is scheduled."
// and the true label waits behind it. The countdown itself is ALWAYS real — an
// unannounced entry still requires a real `at` and a real label. Recurring events are
// known cadences and are never unannounced (that combination is malformed → skipped).

import { escapeHtml } from "./render.js";

// ── schema validation ─────────────────────────────────────────────────────────
// A row enters the calendar only if it is one of the two exact shapes with a
// parseable instant. Anything else is malformed → dropped by the caller (the page
// never breaks on a bad row). validateEvent is total: it throws on nothing.

// Parse an ISO instant to epoch ms, or null if unparseable. Rejects non-strings and
// the empty string outright (Date.parse is lax; we are not).
export function parseInstant(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// The public default reveal window: 24h before the event, an unannounced one-shot's
// true label appears. Overridable per-entry with `reveal_ms`.
export const DEFAULT_REVEAL_MS = 86_400_000;

// The masked label shown while an unannounced event is still concealed. Exactly this
// string (lowercase, trailing period), registry-plain — never a fabricated teaser.
export const UNANNOUNCED_LABEL = "an event is scheduled.";

// Returns a normalized event ({kind:'one-shot'|'recurring', label, ...ms fields}) or
// null if the row is malformed. Never throws. A normalized one-shot may carry
// `unannounced: true` + `reveal_ms` (a positive integer); a recurring event never can.
export function validateEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const label = raw.label;
  if (typeof label !== "string" || label.trim() === "") return null;

  const hasUnannounced = "unannounced" in raw || "reveal_ms" in raw;

  // one-shot: { label, at [, unannounced, reveal_ms] }
  if ("at" in raw && !("anchor" in raw) && !("every_ms" in raw)) {
    const at = parseInstant(raw.at);
    if (at === null) return null;
    const ev = { kind: "one-shot", label, at };
    if (hasUnannounced) {
      // `unannounced` must be exactly true when present; anything else is malformed.
      if (raw.unannounced !== true) return null;
      ev.unannounced = true;
      // reveal_ms is optional; when present it must be a positive integer.
      if ("reveal_ms" in raw) {
        const r = raw.reveal_ms;
        if (
          typeof r !== "number" ||
          !Number.isFinite(r) ||
          !Number.isInteger(r) ||
          r <= 0
        ) {
          return null;
        }
        ev.reveal_ms = r;
      } else {
        ev.reveal_ms = DEFAULT_REVEAL_MS;
      }
    }
    return ev;
  }

  // recurring: { label, anchor, every_ms }. A known cadence is NEVER unannounced —
  // an unannounced flag on a recurring entry is malformed (skip the row).
  if ("anchor" in raw && "every_ms" in raw && !("at" in raw)) {
    if (hasUnannounced) return null;
    const anchor = parseInstant(raw.anchor);
    if (anchor === null) return null;
    const every_ms = raw.every_ms;
    if (
      typeof every_ms !== "number" ||
      !Number.isFinite(every_ms) ||
      !Number.isInteger(every_ms) ||
      every_ms <= 0
    ) {
      return null;
    }
    return { kind: "recurring", label, anchor, every_ms };
  }

  // any other combination of keys is not one of the two sanctioned shapes
  return null;
}

// ── next-occurrence math (epoch-ms; DST-safe) ─────────────────────────────────
// For a recurring event, the next occurrence is the FIRST time in the series that is
// strictly in the future relative to `now`:  anchor + k*every_ms  for the smallest
// integer k such that anchor + k*every_ms > now.  k may be negative (now precedes the
// anchor → the anchor itself, or an earlier-in-series time, is the next occurrence),
// zero, or large. Exact boundary (now === an occurrence) rolls to the NEXT one — a
// due event does not linger at 00:00:00; it advances.
//
// Returns the epoch-ms of the next occurrence.
export function nextRecurringOccurrence(anchor, every_ms, now) {
  if (now < anchor) return anchor; // the series has not started; the anchor is next
  // number of whole periods elapsed since the anchor, floored, then step one past the
  // occurrence at-or-before now. Using floor((now-anchor)/every)+1 guarantees strictly
  // future even exactly on a boundary.
  const elapsed = now - anchor;
  const k = Math.floor(elapsed / every_ms) + 1;
  return anchor + k * every_ms;
}

// The label to SHOW for a validated event at `now`. Normally the true label; for an
// unannounced one-shot still inside its concealment window (now < at - reveal_ms) it is
// the fixed UNANNOUNCED_LABEL. The countdown is unaffected — only the label is masked.
export function displayLabel(ev, now) {
  if (ev.kind === "one-shot" && ev.unannounced === true) {
    const reveal_ms =
      typeof ev.reveal_ms === "number" ? ev.reveal_ms : DEFAULT_REVEAL_MS;
    if (now < ev.at - reveal_ms) return UNANNOUNCED_LABEL;
  }
  return ev.label;
}

// The due-time of any validated event, or null for a one-shot already past.
//   one-shot   → its `at`, unless `at <= now` (expired → null, caller drops it)
//   recurring  → the rolling next occurrence (never null; rolls over seamlessly)
export function eventDueAt(ev, now) {
  if (ev.kind === "one-shot") {
    return ev.at > now ? ev.at : null; // exactly-at or past → expired
  }
  return nextRecurringOccurrence(ev.anchor, ev.every_ms, now);
}

// ── the upcoming list ─────────────────────────────────────────────────────────
// Given the raw events.json array and `now`, return the render-ready rows:
//   [{ label, dueAt, remaining }]  sorted soonest-first.
// Malformed rows are skipped; expired one-shots drop off. `remaining` is dueAt-now in
// ms (always > 0 here — an expired one-shot has already been removed, and a recurring
// event's next occurrence is strictly future).
export function upcomingEvents(rawList, now) {
  const list = Array.isArray(rawList) ? rawList : [];
  const rows = [];
  for (const raw of list) {
    const ev = validateEvent(raw);
    if (!ev) continue; // malformed → skip, never break
    const dueAt = eventDueAt(ev, now);
    if (dueAt === null) continue; // expired one-shot → drop off
    // The label shown may be masked while an unannounced event is still concealed; the
    // countdown (dueAt/remaining) is always the real, unmasked time. When a row is
    // currently masked, carry its reveal instant so the client tick knows to redraw the
    // list the moment the true label is due to appear.
    const masked =
      ev.kind === "one-shot" &&
      ev.unannounced === true &&
      now < ev.at - (typeof ev.reveal_ms === "number" ? ev.reveal_ms : DEFAULT_REVEAL_MS);
    const row = { label: displayLabel(ev, now), dueAt, remaining: dueAt - now };
    if (masked) {
      row.revealAt = ev.at - (typeof ev.reveal_ms === "number" ? ev.reveal_ms : DEFAULT_REVEAL_MS);
    }
    rows.push(row);
  }
  rows.sort((a, b) => a.dueAt - b.dueAt);
  return rows;
}

// ── countdown formatting ──────────────────────────────────────────────────────
// The chosen shape (documented + tested):
//   under 24h : "HH:MM:SS"        e.g. "18:44:09"   (zero-padded, hours may be 00..23)
//   24h+      : "Nd HH:MM:SS"     e.g. "1d 02:15:00" (days, then the same HH:MM:SS)
// Seconds resolution; we round DOWN to the whole second remaining (a countdown shows
// time LEFT, so 4200ms left reads 00:00:04, and it reaches 00:00:00 only at/after due).
// A non-positive remaining clamps to "00:00:00" (the moment it is due).
export function formatCountdown(remainingMs) {
  let ms = typeof remainingMs === "number" && Number.isFinite(remainingMs) ? remainingMs : 0;
  if (ms < 0) ms = 0;
  let total = Math.floor(ms / 1000); // whole seconds remaining
  const days = Math.floor(total / 86400);
  total -= days * 86400;
  const hours = Math.floor(total / 3600);
  total -= hours * 3600;
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  const pad = (n) => String(n).padStart(2, "0");
  const hms = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return days > 0 ? `${days}d ${hms}` : hms;
}

// ── render (pure (rows, now) -> HTML string) ──────────────────────────────────
// One row per upcoming event: the label and a live countdown. The countdown carries a
// data-due-at attribute (epoch ms) so the browser's 1s tick (app.js) can re-render the
// time in place with no re-fetch. Registry-plain: a labelled list, the countdown in a
// tabular-figures cell. Copy says "due". An empty/all-skipped list renders nothing
// (no "nothing upcoming" placeholder — the section simply does not appear; honesty
// frame: never a fabricated row).
//
// `rows` is the output of upcomingEvents(); `now` is only used to render the initial
// countdown text (the attribute is the source of truth for subsequent ticks).
export function renderUpcoming(rows, now) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return "";
  const items = list
    .map((r) => {
      const remaining = typeof r.remaining === "number" ? r.remaining : r.dueAt - now;
      // A masked (unannounced, still-concealed) row carries data-reveal-at so the client
      // tick redraws the list at the reveal instant, swapping the mask for the true label.
      const revealAttr =
        typeof r.revealAt === "number" ? ` data-reveal-at="${r.revealAt}"` : "";
      return `<li class="upcoming-row">
  <span class="upcoming-label">${escapeHtml(r.label)}</span>
  <time class="upcoming-countdown" data-due-at="${r.dueAt}"${revealAttr} aria-label="time until due">${escapeHtml(
        formatCountdown(remaining),
      )}</time>
</li>`;
    })
    .join("\n");
  return `<section class="upcoming" aria-labelledby="upcoming-heading">
  <h2 id="upcoming-heading" class="upcoming-heading">Upcoming</h2>
  <ul class="upcoming-list">
${items}
  </ul>
  <p class="upcoming-note">Times count down to when each is due; the pulse fires on the minute.</p>
</section>`;
}
