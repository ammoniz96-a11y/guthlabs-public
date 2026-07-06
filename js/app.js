// site/js/app.js — the browser controller. Wires each page's mount points to the read
// layer (data.js) and the pure renderers (render.js). No page logic lives in the HTML.
//
// Each page calls one of the mount* functions with the id of an empty container. The
// controller shows a plain loading line, fetches the view, and swaps in the rendered
// string — or an honest error/absent state. Nothing is ever fabricated to fill space.

import { loadView, isFixtureMode } from "./data.js";
import { CONFIG } from "../config.js";
import {
  renderDoorStat,
  renderStatsStrip,
  renderCensus,
  renderChronicle,
  renderPanel,
  renderError,
} from "./render.js";
import {
  validateSignup,
  signup,
  renderFieldError,
  renderSignupError,
  renderSignupSuccess,
} from "./auth.js";

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

// ── the Threshold: account form ──────────────────────────────────────────────
//
// Wires the signup <form> to the pure validators and the injectable signup() call.
// On submit: validate client-side (confirm-match, length floor, email shape), show
// per-field errors, and only on a clean pass POST to Supabase Auth. Success replaces
// the whole form with the honest "confirm your email" state; a server error shows an
// honest inline line and leaves the form so the visitor can retry.
//
// The signup fetch is the browser's global fetch; the endpoint is only ever called by
// a real visitor pressing the button. The publishable key and URL come from config.js.
const FIELDS = ["username", "email", "password", "confirm"];

function clearFieldErrors(form) {
  for (const f of FIELDS) {
    const slot = form.querySelector(`[data-error-for="${f}"]`);
    if (slot) slot.innerHTML = "";
    const input = form.elements[f];
    if (input) input.removeAttribute("aria-invalid");
  }
  const formErr = form.querySelector('[data-error-for="form"]');
  if (formErr) formErr.innerHTML = "";
}

function showFieldErrors(form, errors) {
  for (const [field, msg] of Object.entries(errors)) {
    const slot = form.querySelector(`[data-error-for="${field}"]`);
    if (slot) slot.innerHTML = renderFieldError(msg);
    const input = form.elements[field];
    if (input) input.setAttribute("aria-invalid", "true");
  }
}

export function mountThreshold(formId) {
  const form = el(formId);
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFieldErrors(form);

    const input = {
      username: form.elements.username?.value ?? "",
      email: form.elements.email?.value ?? "",
      password: form.elements.password?.value ?? "",
      confirm: form.elements.confirm?.value ?? "",
    };

    const { ok, errors } = validateSignup(input);
    if (!ok) {
      showFieldErrors(form, errors);
      const first = form.elements[Object.keys(errors)[0]];
      if (first && typeof first.focus === "function") first.focus();
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.dataset.label = submitBtn.textContent;
      submitBtn.textContent = "Registering…";
    }

    const result = await signup(
      {
        supabaseUrl: CONFIG.SUPABASE_URL,
        publishableKey: CONFIG.PUBLISHABLE_KEY,
        username: input.username.trim(),
        email: input.email.trim(),
        password: input.password,
      },
      globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined,
    );

    if (result.ok) {
      form.outerHTML = renderSignupSuccess();
      return;
    }

    const formErr = form.querySelector('[data-error-for="form"]');
    if (formErr) formErr.innerHTML = renderSignupError(result.message);
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = submitBtn.dataset.label || "Create account";
    }
  });
}
