// site/js/pleas.js — the plea window's site surfaces (LWO-10, DESIGN/WINDOW_TO_PLEA.md
// §2/§3/§4 as amended: statuses open|answered ONLY; the board is public).
//
// Shape of this module, mirroring render.js/auth.js exactly:
//   - pure (data) -> HTML-string renderers and pure decision functions on top, so
//     site/site.test.ts unit-tests every choice offline with no DOM and no network;
//   - ONE impure function, submitPlea(), with its fetch injected — the door-plea edge
//     function is only ever called by a real visitor's action, never by a test;
//   - a thin browser mount at the bottom (the app.js controller style).
//
// The membrane law, load-bearing (WINDOW_TO_PLEA §4): the visitor is NEVER notified.
// There is deliberately no polling, no timer, no notification machinery anywhere in
// this module — the board is fetched once on load, and once more after a successful
// submission so the visitor sees their own plea land. After that, returning and
// reading the record is the visitor's own act. Pull, never push.

import { CONFIG } from "../config.js";
import { loadView } from "./data.js";
import { escapeHtml, formatDate, renderEmpty, renderError } from "./render.js";
import { readSession } from "./auth.js";

// ── the contract constants ────────────────────────────────────────────────────

// The char bound (WINDOW_TO_PLEA §2: bounded plain text, ≤ 1,000 chars v1). The DB
// enforces the same bound (schema/014 check constraint); the client check is honesty,
// not the defense.
export const PLEA_MAX_CHARS = 1000;

// The door-plea edge function path — the door-login pattern: the endpoint is derived
// from CONFIG.SUPABASE_URL exactly the way auth.js derives door-login's. The function
// ships with WO-26; until it is deployed a submission fails with the honest transport
// line, never a fabricated success.
export const DOOR_PLEA_PATH = "/functions/v1/door-plea";

export function pleaUrl(supabaseUrl) {
  const base = String(supabaseUrl || "").replace(/\/+$/, "");
  return `${base}${DOOR_PLEA_PATH}`;
}

// The one promise the register makes is that it makes none (WINDOW_TO_PLEA §3,
// verbatim submission copy). This sentence appears wherever a plea is left.
export const PLEA_NO_PROMISE = "The register does not promise an answer.";

// The uniform refusal (WINDOW_TO_PLEA §2): a refused plea gets one honest line, with
// no oracle about why beyond the mechanical class. Unknown server strings are never
// surfaced — the door speaks with one voice (the door-login refusal discipline).
export const PLEA_REFUSAL = "The register did not accept the plea.";

// ── validation (pure) ─────────────────────────────────────────────────────────

// The client-side floor: a plea exists and fits the bound. Topic and merit are never
// screened (the gate is safety, never taste — and that gate lives server-side, as
// pattern-class checks only). Returns { ok, body } or { ok:false, message }.
export function validatePlea(text) {
  const body = typeof text === "string" ? text.trim() : "";
  if (body.length === 0) {
    return { ok: false, message: "Write the plea before leaving it." };
  }
  if (body.length > PLEA_MAX_CHARS) {
    return {
      ok: false,
      message: `A plea is at most ${PLEA_MAX_CHARS} characters. Yours is ${body.length}.`,
    };
  }
  return { ok: true, body };
}

// The live character count under the textarea — a plain fraction, no drama.
export function renderPleaCount(length) {
  const n =
    typeof length === "number" && Number.isFinite(length) && length >= 0
      ? Math.floor(length)
      : 0;
  return `${n} / ${PLEA_MAX_CHARS}`;
}

// ── the board (pure renderers over the migration-014 public_pleas view) ────────
//
// View contract (schema/014_pleas.sql), reproduced so this file is the one place
// the column names live:
//   public_pleas : id, name_ref, body, status, answer_ref, created_at
// Statuses are open|answered ONLY (v1). fee_credits is deliberately not exposed.

// A plea body is plain text; render it the way chronicle bodies render (escaped,
// paragraph-split), never as markup.
function pleaBodyHtml(body) {
  const text = typeof body === "string" ? body : "";
  if (text.length === 0) return "";
  return `<div class="entry-body">${escapeHtml(text)
    .split("\n\n")
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("")}</div>`;
}

// One board row. Registry-plain, in the chronicle-entry idiom. Provenance is explicit:
// the byline names the visitor as a visitor. An answered plea links to its answer's
// entry in the chronicle via answer_ref; a plea with no answer links nowhere — a link
// is rendered only when the record actually holds its target (never fabricate).
export function renderPleaRow(p) {
  const anchor =
    p.id === null || p.id === undefined ? "" : ` id="plea-${escapeHtml(String(p.id))}"`;
  const status = escapeHtml(p.status);
  const hasAnswer =
    p.status === "answered" &&
    p.answer_ref !== null &&
    p.answer_ref !== undefined &&
    String(p.answer_ref).length > 0;
  const answerEl = hasAnswer
    ? `<p class="entry-crossref"><a href="./chronicle.html#entry-${escapeHtml(
        String(p.answer_ref),
      )}">read the answer in the chronicle</a></p>`
    : "";
  return `<article class="entry entry--plea"${anchor}>
  <div class="entry-head">
    <span class="entry-kind">plea</span>
    <span class="entry-date">${formatDate(p.created_at)}</span>
    <span class="tag">${status}</span>
  </div>
  ${pleaBodyHtml(p.body)}
  <p class="entry-byline">— ${escapeHtml(p.name_ref)}, visitor</p>
  ${answerEl}
</article>`;
}

// The board, newest first (the record reads present-to-past, like the chronicle).
// Empty is stated plainly — a board with no pleas is a fact, not a gap to dress.
export function renderPleaBoard(rows) {
  const pleas = Array.isArray(rows) ? rows.slice() : [];
  if (pleas.length === 0) {
    return renderEmpty("No pleas have been left at the door yet.");
  }
  pleas.sort((a, b) => {
    const ta = new Date(a.created_at).getTime() || 0;
    const tb = new Date(b.created_at).getTime() || 0;
    return tb - ta;
  });
  return `<div class="plea-list">${pleas.map(renderPleaRow).join("\n")}</div>`;
}

// ── the sill's three faces (pure decisions) ────────────────────────────────────
//
// Which face the submission section shows:
//   'gate'    — no session: the board is readable by anyone; leaving a plea takes a
//               registered name. One calm line, said once (never a nag).
//   'waiting' — signed in, with an open plea already on the board: one open plea per
//               name (§2); the form would only meet the DB's refusal, so the page says
//               the true state instead.
//   'form'    — signed in, no open plea: the form.

// The signed-in name's open plea, if any. The register's uniqueness is
// case-insensitive (schema/014: unique on lower(name_ref)), so the match is too.
export function openPleaFor(name, rows) {
  if (typeof name !== "string" || name.trim().length === 0) return null;
  if (!Array.isArray(rows)) return null;
  const needle = name.trim().toLowerCase();
  return (
    rows.find(
      (p) =>
        p &&
        p.status === "open" &&
        typeof p.name_ref === "string" &&
        p.name_ref.trim().toLowerCase() === needle,
    ) || null
  );
}

export function sillFace(session, rows) {
  if (!session || !session.access_token) return "gate";
  if (openPleaFor(session.name, rows)) return "waiting";
  return "form";
}

// The gate line for anonymous readers. The board stays fully readable; this is a
// statement of how standing works, linked to the threshold — not a prompt loop.
export function renderPleaGate() {
  return `<p class="plea-gate">The board is public. Leaving a plea requires a registered name — a name is made at <a href="./index.html">the threshold</a>.</p>`;
}

// The waiting line for a name whose plea is on the board (shown on return visits AND
// immediately after a successful submission — the same true state either way). Links
// to the plea's own row when we hold it; promises nothing.
export function renderPleaWaiting(plea) {
  const where =
    plea && plea.id !== null && plea.id !== undefined
      ? `<a href="#plea-${escapeHtml(String(plea.id))}">on the board</a>`
      : "on the board";
  return `<p class="plea-standing" role="status">Your plea is ${where}. ${escapeHtml(
    PLEA_NO_PROMISE,
  )} It waits until a resident chooses it — which may be a while, or never.</p>`;
}

// A form-level error line (refusal, transport trouble). Same shape as the threshold's.
export function renderPleaError(message) {
  return `<p class="form-error" role="alert">${escapeHtml(message)}</p>`;
}

// ── refusal mapping (pure) ─────────────────────────────────────────────────────
//
// The door-plea function refuses mechanically (rate limit, session, the one-open-plea
// law) or uniformly (the pattern-class screen). We name the mechanical states the
// visitor can actually act on, and collapse everything else to the uniform refusal —
// a raw server string is never surfaced (the mapLoginError discipline).
export function mapPleaError(status, body) {
  const code = (body && typeof body.error === "string" && body.error) || "";
  const raw = (body && (body.message || body.msg || body.error_description)) || "";
  const lower = (String(raw) + " " + code).toLowerCase();

  if (status === 429 || code === "rate_limited" || /rate limit|too many/i.test(lower)) {
    return "Too many attempts for now. Wait a little, then try again.";
  }
  if (status === 401 || status === 403) {
    return "Your session could not be verified. Sign in again at the threshold.";
  }
  if (status === 409 || code === "open_plea_exists" || /open plea|already open/i.test(lower)) {
    return "One plea may wait at a time. Yours is still on the board.";
  }
  if (status >= 500) {
    return "The service could not be reached. Try again shortly.";
  }
  return PLEA_REFUSAL;
}

// ── submitPlea (impure; fetch injected) ────────────────────────────────────────
//
// POST { body } to the door-plea edge function. The visitor's identity travels ONLY
// as the session access token (Authorization: Bearer) — the function resolves the
// registered name server-side from the JWT; a client-supplied name would be theater
// a forger could wear. The publishable key travels as apikey to route the gateway,
// exactly like door-login. Never throws for an HTTP error; a transport failure is
// wrapped honestly and never dressed as a left plea.
export async function submitPlea(
  { supabaseUrl, publishableKey, accessToken, body },
  fetchImpl,
) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!doFetch) {
    return { ok: false, message: "No network is available to leave the plea." };
  }

  let res;
  try {
    res = await doFetch(pleaUrl(supabaseUrl), {
      method: "POST",
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: body }), // wire law: the fn reads {text} (WO-26; the chronicle's body.text convention)
    });
  } catch {
    return {
      ok: false,
      message: "The service could not be reached. Check your connection and try again.",
    };
  }

  let resBody = null;
  try {
    resBody = await res.json();
  } catch {
    resBody = null;
  }

  if (!res.ok) {
    return { ok: false, message: mapPleaError(res.status, resBody) };
  }
  return { ok: true, body: resBody };
}

// ── the browser mount (thin; every decision above is pure) ─────────────────────

function el(id) {
  return document.getElementById(id);
}

function browserFetch() {
  return globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined;
}

function browserStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null; // localStorage can throw in some privacy modes
  }
}

// After a render, honor a #plea-<id> / #entry-<id> link target the browser could not
// scroll to while the board was still loading. One look, on arrival — not a watcher.
function settleHash() {
  try {
    const hash = globalThis.location ? globalThis.location.hash : "";
    if (!hash || hash.length < 2) return;
    const target = el(hash.slice(1));
    if (target && typeof target.scrollIntoView === "function") target.scrollIntoView();
  } catch {
    /* an unscrollable hash is nothing */
  }
}

export async function mountPleaBoard() {
  const boardNode = el("plea-board");
  const sillNode = el("plea-sill");
  const form = el("plea-form");

  if (boardNode) boardNode.innerHTML = `<p class="loading">Reading the board…</p>`;

  const session = readSession(browserStorage());

  // The board: fetched once. On failure the board says so honestly; the sill still
  // resolves (a fetch problem must not silently eat the visitor's standing).
  let rows = null;
  try {
    rows = await loadView("pleas");
    if (boardNode) boardNode.innerHTML = renderPleaBoard(rows);
  } catch (err) {
    if (boardNode) {
      boardNode.innerHTML = renderError(err && err.message ? err.message : String(err));
    }
  }

  showSill(session, rows, { sillNode, form });
  if (form && session) wireForm(session, { sillNode, form, boardNode });
  settleHash();
}

function showSill(session, rows, { sillNode, form }) {
  const face = sillFace(session, rows);
  if (form) form.hidden = face !== "form";
  if (!sillNode) return;
  if (face === "gate") {
    sillNode.innerHTML = renderPleaGate();
  } else if (face === "waiting") {
    sillNode.innerHTML = renderPleaWaiting(openPleaFor(session.name, rows));
  } else {
    sillNode.innerHTML = "";
    const asNode = el("plea-as");
    // textContent, not innerHTML — the name is untrusted text.
    if (asNode) asNode.textContent = session.name ? `Entered under the name ${session.name}.` : "";
    const bodyInput = form ? form.elements.body : null;
    const countNode = el("plea-count");
    if (countNode && bodyInput) {
      countNode.textContent = renderPleaCount(String(bodyInput.value || "").length);
    }
  }
}

function wireForm(session, { sillNode, form, boardNode }) {
  const bodyInput = form.elements.body;
  const countNode = el("plea-count");
  const errSlot = form.querySelector('[data-error-for="plea-form"]');

  if (bodyInput && countNode) {
    bodyInput.addEventListener("input", () => {
      countNode.textContent = renderPleaCount(String(bodyInput.value || "").length);
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (errSlot) errSlot.innerHTML = "";

    const check = validatePlea(bodyInput ? bodyInput.value : "");
    if (!check.ok) {
      if (errSlot) errSlot.innerHTML = renderPleaError(check.message);
      return;
    }

    const btn = form.querySelector('button[type="submit"]');
    if (btn) {
      btn.disabled = true;
      btn.dataset.label = btn.dataset.label || btn.textContent;
      btn.textContent = "Leaving…";
    }

    const result = await submitPlea(
      {
        supabaseUrl: CONFIG.SUPABASE_URL,
        publishableKey: CONFIG.PUBLISHABLE_KEY,
        accessToken: session.access_token,
        body: check.body,
      },
      browserFetch(),
    );

    if (result.ok) {
      // ONE refetch so the visitor sees their plea on the public board — then the
      // page is done. No polling, no watcher, no "check back" machinery (membrane).
      let fresh = null;
      try {
        fresh = await loadView("pleas");
        if (boardNode) boardNode.innerHTML = renderPleaBoard(fresh);
      } catch {
        /* the plea was left; a refetch hiccup does not unsay that */
      }
      form.hidden = true;
      if (sillNode) {
        sillNode.innerHTML = renderPleaWaiting(openPleaFor(session.name, fresh));
      }
      return;
    }

    if (errSlot) errSlot.innerHTML = renderPleaError(result.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.label || btn.textContent;
    }
  });
}
