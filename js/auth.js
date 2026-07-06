// site/js/auth.js — the Threshold's account layer: pure validation + render, plus a
// single injectable signup call to Supabase Auth.
//
// Everything that decides anything is a pure function (validateSignup, mapSignupError,
// the render* functions), so site/site.test.ts can unit-test them offline with no DOM
// and no network. The one impure function, signup(), takes its fetch as an argument so
// the test mocks it — this module never touches the live auth endpoint on import.
//
// Honesty frame (DESIGN/LAUNCH_PLAN §5, TONE_AND_PANEL Law 1): the success state never
// claims the account unlocks anything today. It says exactly what is true — the record
// is registered, the email must be confirmed, and two-factor is offered later. Nothing
// is fronted; the door has not opened yet, and the copy says so.

import { escapeHtml } from "./render.js";

// ── validation (pure) ─────────────────────────────────────────────────────────
//
// The floor is deliberately minimal and honest — enough to catch a typo'd email, a
// mismatched confirmation, and a trivially short password, no more. Supabase enforces
// the real password policy server-side; a heavier client gate would be theater.

export const MIN_PASSWORD_LENGTH = 10;

// A conservative single-shape email check: one @, a dot in the domain, no whitespace.
// Not RFC-complete on purpose — the confirmation email is the real proof of address.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Returns { ok, errors } where errors maps field -> human message. A field is present in
// errors only when it fails; ok is true iff errors is empty. Pure and total.
export function validateSignup(input) {
  const errors = {};
  const username = typeof input?.username === "string" ? input.username.trim() : "";
  const email = typeof input?.email === "string" ? input.email.trim() : "";
  const password = typeof input?.password === "string" ? input.password : "";
  const confirm = typeof input?.confirm === "string" ? input.confirm : "";

  if (username.length === 0) {
    errors.username = "Choose a name to be known by.";
  } else if (username.length > 40) {
    errors.username = "Keep the name to 40 characters or fewer.";
  }

  if (email.length === 0) {
    errors.email = "An email is required to confirm the account.";
  } else if (!EMAIL_SHAPE.test(email)) {
    errors.email = "That does not look like an email address.";
  }

  if (password.length === 0) {
    errors.password = "Set a password.";
  } else if (password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }

  if (confirm.length === 0) {
    errors.confirm = "Repeat the password.";
  } else if (confirm !== password) {
    errors.confirm = "The two passwords do not match.";
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

// ── mapping a Supabase auth error to an honest human line (pure) ──────────────
//
// Supabase Auth returns { error, error_description } or { msg } / { message } with an
// HTTP status. We translate the few states a visitor can actually hit into plain,
// honest sentences — never a raw code, never a false reassurance. Unknown shapes fall
// back to the server's own message or a generic honest line.
export function mapSignupError(status, body) {
  const raw =
    (body && (body.error_description || body.msg || body.message || body.error)) || "";
  const text = String(raw);
  const lower = text.toLowerCase();

  if (status === 429 || /rate limit|too many/i.test(lower)) {
    return "Too many attempts for now. Wait a little, then try again.";
  }
  if (
    /already registered|already been registered|user already exists|already in use/i.test(
      lower,
    )
  ) {
    return "An account already exists for that email.";
  }
  if (/password/i.test(lower) && /(weak|short|least|length|strength)/i.test(lower)) {
    return "That password was rejected. Choose a longer one.";
  }
  if (/invalid|valid email|unable to validate email/i.test(lower)) {
    return "That email address was not accepted.";
  }
  // A real server message, if honest and present, is better than a generic line.
  if (text.trim().length > 0) return text.trim();
  if (status >= 500) return "The service could not be reached. Try again shortly.";
  return "The account could not be created. Try again.";
}

// ── render (pure) ─────────────────────────────────────────────────────────────

// Per-field inline errors, rendered next to their inputs. Escaped; keyed by field id.
export function renderFieldError(message) {
  if (!message) return "";
  return `<span class="field-error" role="alert">${escapeHtml(message)}</span>`;
}

// A single honest form-level error line (network trouble, rate limit, existing account).
export function renderSignupError(message) {
  return `<p class="form-error" role="alert">${escapeHtml(message)}</p>`;
}

// The success state that replaces the form. Every clause here is true of the system as
// built: the account row is registered, a confirmation email is sent, and two-factor is
// a later offering. It promises nothing that does not yet exist.
export function renderSignupSuccess() {
  return `<div class="threshold-done" role="status">
  <p class="threshold-done-lead">Registered.</p>
  <p>Confirm your email to complete the account. Two-factor authentication will be offered once the doors open.</p>
</div>`;
}

// ── signup (impure; fetch injected) ───────────────────────────────────────────
//
// Posts to Supabase Auth's signup endpoint with the designed-public publishable key.
// username travels as user_metadata (data.username) — Supabase stores it on the user.
// Returns a normalized result the controller renders; never throws for an HTTP error,
// only for a transport failure it wraps as { ok:false, message }.
//
// The fetch is a parameter so the unit test injects a mock; in the browser the caller
// passes globalThis.fetch. This module makes no network call at import time.
export async function signup(
  { supabaseUrl, publishableKey, username, email, password },
  fetchImpl,
) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!doFetch) {
    return { ok: false, message: "No network is available to create the account." };
  }

  const base = String(supabaseUrl || "").replace(/\/+$/, "");
  const url = `${base}/auth/v1/signup`;
  const payload = {
    email,
    password,
    data: { username },
  };

  let res;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${publishableKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return {
      ok: false,
      message: "The service could not be reached. Check your connection and try again.",
    };
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    return { ok: false, message: mapSignupError(res.status, body) };
  }
  return { ok: true, body };
}
