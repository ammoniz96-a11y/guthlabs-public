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

// ══════════════════════════════════════════════════════════════════════════════
// LWO-5 — returning-visitor login, session storage, and the remember-me theatre
// ══════════════════════════════════════════════════════════════════════════════
//
// Two truths held together:
//   - Under the hood: conventional Supabase auth. A password grant on real login,
//     a refresh-token grant on return, the standard token pair in localStorage.
//   - On the surface: the Divergence (TONE Law 1). A return visitor sees the SAME
//     threshold, their email already filled in, the password field showing a fixed
//     mask, and one button: "login". Old-school, pre-keychain, slightly eerie.
//
// The security is ordinary; the eeriness is the point. The real password is NEVER
// stored — not in plaintext, not hashed, not derivable. The mask is a constant with
// no relation to any password; the "login" click resumes the session via the stored
// refresh token, so no password is sent because none is needed.

// The fixed password mask. A constant string of 10 bullet characters, chosen once,
// unrelated to any real password. It is only ever a VISUAL fill on a return visit;
// it is never sent to any endpoint, never compared to a password, never derived from
// one. Its length is fixed at 10 so it leaks nothing about the true password length.
export const PASSWORD_MASK = "•".repeat(10); // "••••••••••"

// The one localStorage key. Holds exactly the standard Supabase token pair plus the
// email (needed to pre-fill the theatre). Nothing else — no username, no password,
// no derived material.
export const SESSION_KEY = "guthlabs.session";

// ── session storage (pure over an injected storage) ───────────────────────────
//
// Storage is injected (localStorage in the browser, a plain object shim in tests) so
// every path is unit-testable offline. A stored session is exactly:
//   { access_token, refresh_token, email }
// and readSession refuses to return anything that does not carry both tokens — a
// malformed or partial blob degrades to "no session", i.e. an honest real login.

export function saveSession(storage, { access_token, refresh_token, email }) {
  if (!storage || !access_token || !refresh_token) return;
  const record = { access_token, refresh_token, email: email || "" };
  storage.setItem(SESSION_KEY, JSON.stringify(record));
}

export function readSession(storage) {
  if (!storage) return null;
  let raw;
  try {
    raw = storage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed.access_token !== "string" ||
    typeof parsed.refresh_token !== "string" ||
    parsed.access_token.length === 0 ||
    parsed.refresh_token.length === 0
  ) {
    return null;
  }
  return {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token,
    email: typeof parsed.email === "string" ? parsed.email : "",
  };
}

export function clearSession(storage) {
  if (!storage) return;
  try {
    storage.removeItem(SESSION_KEY);
  } catch {
    /* nothing to clear */
  }
}

// Normalize the token pair a Supabase grant returns into the exact record we store.
// Supabase returns access_token + refresh_token at the top level; the email lives on
// the nested `user`. We keep only those three fields.
function sessionFromGrant(body, fallbackEmail) {
  if (!body) return null;
  const access_token = typeof body.access_token === "string" ? body.access_token : "";
  const refresh_token =
    typeof body.refresh_token === "string" ? body.refresh_token : "";
  if (!access_token || !refresh_token) return null;
  const email =
    (body.user && typeof body.user.email === "string" && body.user.email) ||
    fallbackEmail ||
    "";
  return { access_token, refresh_token, email };
}

// ── mapping a login error to an honest human line (pure) ──────────────────────
//
// The two states a returning visitor actually hits are wrong credentials and an
// unconfirmed email. Supabase surfaces these as `error_description` / `msg`; we
// translate them into plain sentences, never a raw code, never a false reassurance.
export function mapLoginError(status, body) {
  const raw =
    (body && (body.error_description || body.msg || body.message || body.error)) || "";
  const text = String(raw);
  const lower = text.toLowerCase();

  if (status === 429 || /rate limit|too many/i.test(lower)) {
    return "Too many attempts for now. Wait a little, then try again.";
  }
  if (/email not confirmed|not confirmed|confirm your email/i.test(lower)) {
    return "That email has not been confirmed yet. Check your inbox for the confirmation link.";
  }
  if (
    /invalid login credentials|invalid grant|invalid_grant|wrong|incorrect/i.test(
      lower,
    )
  ) {
    return "That email and password do not match an account.";
  }
  if (text.trim().length > 0) return text.trim();
  if (status >= 500) return "The service could not be reached. Try again shortly.";
  return "Could not sign in. Check the email and password, then try again.";
}

// ── login: the password grant (impure; fetch injected) ────────────────────────
//
// POST /auth/v1/token?grant_type=password with { email, password } and the anon
// (publishable) key. On success, returns { ok:true, session } — the standard token
// pair + email, ready to store. On failure, an honest mapped message. Never throws
// for an HTTP error; a transport failure is wrapped as { ok:false, message }.
export async function login(
  { supabaseUrl, publishableKey, email, password },
  fetchImpl,
) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!doFetch) {
    return { ok: false, message: "No network is available to sign in." };
  }

  const base = String(supabaseUrl || "").replace(/\/+$/, "");
  const url = `${base}/auth/v1/token?grant_type=password`;

  let res;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${publishableKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });
  } catch {
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
    return { ok: false, message: mapLoginError(res.status, body) };
  }

  const session = sessionFromGrant(body, email);
  if (!session) {
    return { ok: false, message: "The sign-in response was incomplete. Try again." };
  }
  return { ok: true, session };
}

// ── resume: the refresh-token grant (impure; fetch injected) ──────────────────
//
// The heart of the theatre. On a return visit the visitor presses "login" and this
// runs — NO password is sent, because the stored refresh token is the credential.
// POST /auth/v1/token?grant_type=refresh_token with { refresh_token }. A fresh token
// pair comes back (the old refresh token is rotated). On any non-200 the session is
// expired/revoked → { ok:false, expired:true } so the caller degrades honestly to a
// real login form. Never throws for an HTTP error.
export async function resumeSession(
  { supabaseUrl, publishableKey, refresh_token, email },
  fetchImpl,
) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!doFetch) {
    return { ok: false, expired: false, message: "No network is available." };
  }

  const base = String(supabaseUrl || "").replace(/\/+$/, "");
  const url = `${base}/auth/v1/token?grant_type=refresh_token`;

  let res;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${publishableKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token }),
    });
  } catch {
    // A transport failure is NOT an expired session — do not clear a valid session
    // over a flaky network. The caller keeps the theatre and lets the visitor retry.
    return {
      ok: false,
      expired: false,
      message: "The service could not be reached. Try again in a moment.",
    };
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    // 400/401 on a refresh grant means the token is expired, revoked, or invalid.
    return { ok: false, expired: true };
  }

  const session = sessionFromGrant(body, email);
  if (!session) {
    return { ok: false, expired: true };
  }
  return { ok: true, session };
}

// ── render (pure) ─────────────────────────────────────────────────────────────

// The signed-in acknowledgment that replaces the form once a session resumes (or a
// fresh login succeeds). Honest: it registers a name at a door that has not yet
// opened — it never claims access to features that do not exist.
export function renderSignedIn(email) {
  const who = escapeHtml(email || "");
  const line = who
    ? `Your name is registered at the door, ${who}.`
    : "Your name is registered at the door.";
  return `<div class="threshold-done" role="status">
  <p class="threshold-done-lead">Signed in.</p>
  <p>${line}</p>
  <p class="threshold-done-note">The doors have not opened. When they do, you will already be known here.</p>
</div>`;
}
