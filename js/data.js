// site/js/data.js — the read layer over the migration-005 public window.
//
// One switch, two sources (LAUNCH_PLAN §3):
//   MODE 'fixture' → fetch site/fixtures/<view>.json (offline, DEMO-labeled).
//   MODE 'live'    → fetch PostgREST <SUPABASE_URL>/rest/v1/<view> with the
//                    designed-public publishable key.
//
// The four views are read-only and enumerated by migration 005; anon can see nothing
// else. No writes ever originate here. On any failure the caller renders an honest
// error/absent state — the site never fabricates rows to hide a fetch problem.

import { CONFIG } from "../config.js";

// The four public views (schema/005_public_window.sql). Order/query notes:
//   census    — every non-toy, non-unmade resident (view already filters class/status)
//   chronicle — canon kinds only (view filters); we order newest-first at the DB
//   panel     — the six seats
//   stats     — a single-row aggregate
const VIEWS = {
  census: "public_census",
  chronicle: "public_chronicle",
  panel: "public_panel",
  stats: "public_stats",
};

// PostgREST query strings per view (live mode only). Fixture mode ignores these.
const LIVE_QUERY = {
  census: "?order=created_at.asc",
  chronicle: "?order=ts.desc",
  panel: "?order=created_at.asc",
  stats: "?limit=1",
};

function fixtureUrl(view) {
  return `./fixtures/${VIEWS[view]}.json`;
}

function liveUrl(base, view) {
  const trimmed = String(base).replace(/\/+$/, "");
  return `${trimmed}/rest/v1/${VIEWS[view]}${LIVE_QUERY[view] || ""}`;
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return res.json();
}

// Fetch one view. Returns an array for census/chronicle/panel; for stats returns the
// single row object (PostgREST returns an array, so we unwrap the first row).
export async function loadView(view) {
  if (!VIEWS[view]) throw new Error(`unknown view: ${view}`);

  let rows;
  if (CONFIG.MODE === "live") {
    const key = CONFIG.PUBLISHABLE_KEY;
    const headers = { apikey: key, Authorization: `Bearer ${key}` };
    rows = await fetchJson(liveUrl(CONFIG.SUPABASE_URL, view), headers);
  } else {
    // fixture (default): local JSON shaped exactly like the view.
    rows = await fetchJson(fixtureUrl(view), {});
  }

  if (view === "stats") {
    return Array.isArray(rows) ? rows[0] ?? null : rows;
  }
  return Array.isArray(rows) ? rows : [];
}

export function isFixtureMode() {
  return CONFIG.MODE !== "live";
}
