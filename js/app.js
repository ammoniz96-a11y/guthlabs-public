// site/js/app.js — the browser controller. Wires each page's mount points to the read
// layer (data.js) and the pure renderers (render.js). No page logic lives in the HTML.
//
// Each page calls one of the mount* functions with the id of an empty container. The
// controller shows a plain loading line, fetches the view, and swaps in the rendered
// string — or an honest error/absent state. Nothing is ever fabricated to fill space.

import { loadView, isFixtureMode } from "./data.js";
import {
  renderDoorStat,
  renderStatsStrip,
  renderCensus,
  renderChronicle,
  renderPanel,
  renderError,
} from "./render.js";

function el(id) {
  return document.getElementById(id);
}

function setLoading(node) {
  if (node) node.innerHTML = `<p class="loading">Reading the record…</p>`;
}

// If we are in fixture mode, drop an honest banner at the top of the page so a preview
// screenshot can never be mistaken for the live founding record.
export function markFixtureMode() {
  if (!isFixtureMode()) return;
  const banner = document.createElement("div");
  banner.className = "fixture-banner";
  banner.textContent =
    "Preview — demonstration data, not the live founding record";
  document.body.insertBefore(banner, document.body.firstChild);
}

async function mountView(nodeId, view, render) {
  const node = el(nodeId);
  if (!node) return;
  setLoading(node);
  try {
    const data = await loadView(view);
    node.innerHTML = render(data);
  } catch (err) {
    node.innerHTML = renderError(err && err.message ? err.message : String(err));
  }
}

// ── page mounts ─────────────────────────────────────────────────────────────

export async function mountDoor(statId, stripId) {
  const statNode = el(statId);
  const stripNode = el(stripId);
  setLoading(statNode);
  try {
    const stats = await loadView("stats");
    if (statNode) statNode.innerHTML = renderDoorStat(stats);
    if (stripNode) stripNode.innerHTML = renderStatsStrip(stats);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (statNode) statNode.innerHTML = renderError(msg);
    if (stripNode) stripNode.innerHTML = "";
  }
}

export function mountCensus(nodeId) {
  return mountView(nodeId, "census", renderCensus);
}

export function mountChronicle(nodeId) {
  return mountView(nodeId, "chronicle", renderChronicle);
}

export function mountPanel(nodeId) {
  return mountView(nodeId, "panel", renderPanel);
}
