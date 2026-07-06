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
  // LWO-9: the name is the identity. The migration-011 trigger rejects a signup whose
  // name is already registered (citext UNIQUE / unique_violation) or reserved (the
  // census + house words). Supabase surfaces the trigger's RAISE as a database error;
  // we map the two name states to honest door-voice lines BEFORE the email-duplicate
  // check, since a name collision is what the visitor will actually hit.
  if (/that name is reserved|name is reserved|reserved/i.test(lower)) {
    return "That name is reserved and cannot be registered at the door.";
  }
  if (
    /a name is required|name is required/i.test(lower)
  ) {
    return "Choose a name to be known by.";
  }
  if (
    /register_names|duplicate key|already exists.*name|name.*already|unique_violation|violates unique/i.test(
      lower,
    )
  ) {
    return "That name is already registered at the door.";
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
// NAME (needed to pre-fill the theatre and to acknowledge the name at the door).
// Nothing else — NO email (LWO-9 demotes email to the hidden recovery rail; it never
// enters localStorage), no password, no derived material.
export const SESSION_KEY = "guthlabs.session";

// ── session storage (pure over an injected storage) ───────────────────────────
//
// Storage is injected (localStorage in the browser, a plain object shim in tests) so
// every path is unit-testable offline. A stored session is exactly:
//   { access_token, refresh_token, name }
// and readSession refuses to return anything that does not carry both tokens — a
// malformed or partial blob degrades to "no session", i.e. an honest real login.
//
// LWO-9: email is NOT stored. A session persisted by an older build may still carry an
// `email` key; readSession ignores it and never returns it, so no email leaks out of a
// legacy blob. The name is the only identity the theatre and the signed-in copy show.

export function saveSession(storage, { access_token, refresh_token, name }) {
  if (!storage || !access_token || !refresh_token) return;
  const record = { access_token, refresh_token, name: name || "" };
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
    name: typeof parsed.name === "string" ? parsed.name : "",
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

// Normalize the token pair a grant returns into the exact record we store. Supabase
// returns access_token + refresh_token at the top level. LWO-9: the NAME is the
// identity we keep — and the grant body does NOT carry it (the door-login function
// resolves name→email server-side and never echoes either back to the browser). So
// the name comes from the caller: what the visitor typed on login, or the name held
// in the stored session on resume. The email on the grant's `user` object is
// deliberately IGNORED — it never enters storage.
function sessionFromGrant(body, name) {
  if (!body) return null;
  const access_token = typeof body.access_token === "string" ? body.access_token : "";
  const refresh_token =
    typeof body.refresh_token === "string" ? body.refresh_token : "";
  if (!access_token || !refresh_token) return null;
  return { access_token, refresh_token, name: name || "" };
}

// The uniform refusal for BOTH an unknown name and a wrong password — the site-side
// twin of the door-login edge function's UNIFORM_REFUSAL. No name-enumeration oracle:
// the returning visitor is never told whether the name exists, only that name + word
// do not match the register.
export const NAME_LOGIN_REFUSAL = "That name and word do not match the register.";

// ── mapping a NAME-login error to an honest human line (pure) ─────────────────
//
// LWO-9: cold login runs on the NAME through the door-login edge function. The two
// states a returning visitor actually hits are a mismatch (unknown name OR wrong
// password — uniform, no oracle) and an unconfirmed email (honest pass-through). The
// edge function returns a small typed shape { error, message }; we translate its
// codes into door-voice lines. A raw 400 mismatch always yields the uniform refusal.
export function mapLoginError(status, body) {
  const code = (body && typeof body.error === "string" && body.error) || "";
  const raw =
    (body && (body.message || body.error_description || body.msg)) || "";
  const text = String(raw);
  const lower = (text + " " + code).toLowerCase();

  if (status === 429 || code === "rate_limited" || /rate limit|too many/i.test(lower)) {
    return "Too many attempts for now. Wait a little, then try again.";
  }
  if (
    code === "email_not_confirmed" ||
    /email not confirmed|not confirmed|confirm your email/i.test(lower)
  ) {
    return "That name's email has not been confirmed yet. Check the inbox for the confirmation link.";
  }
  // Any other 400/401/403 mismatch is the uniform refusal — the door reveals nothing
  // about whether the name exists.
  if (status === 400 || status === 401 || status === 403 || code === "invalid_grant") {
    return NAME_LOGIN_REFUSAL;
  }
  if (status >= 500) return "The service could not be reached. Try again shortly.";
  // A rare unmapped state: prefer the uniform refusal over leaking a server string,
  // so the door still speaks with one voice.
  return NAME_LOGIN_REFUSAL;
}

// ── login: the NAME → session exchange via the door-login edge function ───────
//
// LWO-9: the identity at the door is the NAME. POST { name, password } to the
// door-login edge function, which resolves name→email server-side (service role),
// runs the GoTrue password grant, and returns the standard token pair. The email
// never touches the browser. On success we attach the visitor's own NAME (what they
// typed) to the session — the grant body carries no name. On failure, the uniform
// refusal or an honest pass-through (unconfirmed / rate limit). Never throws for an
// HTTP error; a transport failure is wrapped as { ok:false, message }.
//
// The endpoint URL is derived from SUPABASE_URL: <base>/functions/v1/door-login. The
// publishable (anon) key travels as apikey — the edge gateway requires a project key
// to route, but the function itself does the privileged work under the service role.
export async function login(
  { supabaseUrl, publishableKey, name, password },
  fetchImpl,
) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!doFetch) {
    return { ok: false, message: "No network is available to sign in." };
  }

  const base = String(supabaseUrl || "").replace(/\/+$/, "");
  const url = `${base}/functions/v1/door-login`;

  let res;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${publishableKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, password }),
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

  // Attach the visitor's own NAME — the grant body carries only tokens (+ a `user`
  // object we ignore). No email is read from the response.
  const session = sessionFromGrant(body, name);
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
  { supabaseUrl, publishableKey, refresh_token, name },
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

  // The refresh grant carries no name; carry the stored name forward unchanged.
  const session = sessionFromGrant(body, name);
  if (!session) {
    return { ok: false, expired: true };
  }
  return { ok: true, session };
}

// ── render (pure) ─────────────────────────────────────────────────────────────

// The signed-in acknowledgment that replaces the form once a session resumes (or a
// fresh login succeeds). LWO-9: the door acknowledges the NAME — "your name is
// registered at the door" becomes literal. Honest: it registers a name at a door that
// has not yet opened; it never claims access to features that do not exist.
export function renderSignedIn(name) {
  const who = escapeHtml(name || "");
  const line = who
    ? `Your name is registered at the door, ${who}.`
    : "Your name is registered at the door.";
  return `<div class="threshold-done" role="status">
  <p class="threshold-done-lead">Signed in.</p>
  <p>${line}</p>
  <p class="threshold-done-note">The doors have not opened. When they do, you will already be known here.</p>
</div>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// LWO-6 — the forgot-password flow: request a reset, land on the recovery link,
// set a new password, then hand off to the signed-in state.
// ══════════════════════════════════════════════════════════════════════════════
//
// Two halves, each honest:
//   - REQUEST: a visitor who lost their password enters their email; we POST the
//     recover endpoint and ALWAYS show the same no-oracle line — "if that address
//     is registered, a reset link is on its way." We never confirm or deny that an
//     account exists (an existence oracle is a gift to an attacker), and a transport
//     failure is never dressed as success.
//   - LAND + SET: the reset email links back to this Site URL with a recovery token
//     pair in the URL hash (type=recovery). We detect it at load, show a set-new-
//     password form (the same MIN_PASSWORD_LENGTH floor as signup), and apply it via
//     PUT /auth/v1/user authenticated by the RECOVERY access token. Success stores
//     the session and lands on the signed-in state; an expired/used link says so and
//     offers to send another.

// ── request a recovery link (impure; fetch injected) ──────────────────────────
//
// POST /auth/v1/recover with { email } and the anon (publishable) key. Supabase
// returns 200 with an empty body whether or not the address is registered — the
// no-oracle contract is Supabase's own, and we honor it in the copy regardless.
//
// The result distinguishes three states so the controller renders honestly:
//   { ok:true }                     → show the no-oracle "on its way" line
//   { ok:false, rateLimited:true, message } → a 429; ask them to wait (honest)
//   { ok:false, message }           → transport/server trouble; NEVER shown as sent
export async function requestRecovery(
  { supabaseUrl, publishableKey, email },
  fetchImpl,
) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!doFetch) {
    return { ok: false, message: "No network is available to send a reset link." };
  }

  const base = String(supabaseUrl || "").replace(/\/+$/, "");
  const url = `${base}/auth/v1/recover`;

  let res;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${publishableKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email }),
    });
  } catch {
    // A transport failure is NOT a sent link. Say so plainly — never claim success.
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

  if (res.ok) {
    // 200 regardless of whether the address exists — the no-oracle contract holds.
    return { ok: true };
  }
  if (res.status === 429) {
    return {
      ok: false,
      rateLimited: true,
      message: mapRecoveryError(res.status, body),
    };
  }
  return { ok: false, message: mapRecoveryError(res.status, body) };
}

// Map a recover-endpoint failure to an honest line. The only state a visitor can
// meaningfully hit is a rate limit; everything else is server/transport trouble that
// must never read as "sent".
export function mapRecoveryError(status, body) {
  const raw =
    (body && (body.error_description || body.msg || body.message || body.error)) || "";
  const text = String(raw);
  const lower = text.toLowerCase();

  if (status === 429 || /rate limit|too many/i.test(lower)) {
    return "Too many requests for now. Wait a little, then try again.";
  }
  if (text.trim().length > 0) return text.trim();
  if (status >= 500) return "The service could not be reached. Try again shortly.";
  return "The reset link could not be sent. Try again.";
}

// ── recovery-landing detection (pure) ─────────────────────────────────────────
//
// Supabase's reset email links back to the Site URL with the recovery token pair in
// the URL FRAGMENT (hash), e.g.
//   #access_token=…&refresh_token=…&expires_in=3600&type=recovery
// We parse the fragment (never the query string — the token must never reach the
// server or a log) and return the recovery context ONLY when it is a well-formed
// recovery link carrying an access token. Absent or malformed → null (an ordinary
// visit), so the threshold behaves exactly as before.
export function parseRecoveryHash(hash) {
  if (typeof hash !== "string" || hash.length === 0) return null;
  // Accept a leading '#' or a bare fragment; reject anything that isn't a fragment.
  const frag = hash.charAt(0) === "#" ? hash.slice(1) : hash;
  if (frag.length === 0) return null;

  let params;
  try {
    params = new URLSearchParams(frag);
  } catch {
    return null;
  }

  if (params.get("type") !== "recovery") return null;
  const access_token = params.get("access_token") || "";
  if (access_token.length === 0) return null;

  return {
    access_token,
    refresh_token: params.get("refresh_token") || "",
    type: "recovery",
  };
}

// ── new-password validation (pure) ────────────────────────────────────────────
//
// The same honest floor as signup: a set password, at least MIN_PASSWORD_LENGTH,
// confirmed to match. Supabase enforces the real policy server-side.
export function validateNewPassword(input) {
  const errors = {};
  const password = typeof input?.password === "string" ? input.password : "";
  const confirm = typeof input?.confirm === "string" ? input.confirm : "";

  if (password.length === 0) {
    errors.password = "Set a new password.";
  } else if (password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }

  if (confirm.length === 0) {
    errors.confirm = "Repeat the new password.";
  } else if (confirm !== password) {
    errors.confirm = "The two passwords do not match.";
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

// ── apply the new password (impure; fetch injected) ───────────────────────────
//
// PUT /auth/v1/user with { password } authenticated by the RECOVERY access token
// (the token from the reset link, NOT the anon key — the anon key still travels as
// apikey). On success Supabase returns the user; the caller already holds the token
// pair from the hash, so we return that pair as a ready-to-store session. An expired
// or already-used link comes back non-200 → { ok:false, expired:true } so the caller
// offers to send another. A transport failure is never claimed as success.
export async function updatePassword(
  { supabaseUrl, publishableKey, accessToken, refreshToken, password, name },
  fetchImpl,
) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!doFetch) {
    return { ok: false, expired: false, message: "No network is available." };
  }

  const base = String(supabaseUrl || "").replace(/\/+$/, "");
  const url = `${base}/auth/v1/user`;

  let res;
  try {
    res = await doFetch(url, {
      method: "PUT",
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password }),
    });
  } catch {
    // Transport failure is NOT an expired link — let them retry without losing the link.
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
    if (res.status === 429) {
      return {
        ok: false,
        expired: false,
        message: mapUpdatePasswordError(res.status, body),
      };
    }
    // 401/403/422 on a recovery PUT means the link is expired, used, or invalid.
    return { ok: false, expired: true, message: mapUpdatePasswordError(res.status, body) };
  }

  // The recovery token pair (from the hash) is the session for the now-signed-in user.
  // LWO-9: the session carries the NAME, never the email. PUT /auth/v1/user returns
  // the user object; the registered name lives on user_metadata.username. Read it
  // there so the signed-in state still acknowledges the name at the door; the email
  // never enters the session. `name` may be passed by the caller as a fallback.
  const metaName =
    (body &&
      body.user_metadata &&
      typeof body.user_metadata.username === "string" &&
      body.user_metadata.username) ||
    name ||
    "";
  const session = {
    access_token: accessToken,
    refresh_token: refreshToken || "",
    name: metaName,
  };
  return { ok: true, session };
}

// Map an update-password failure to an honest line. The recovery-specific state is
// the expired/used link; a rate limit and generic trouble are handled honestly too.
export function mapUpdatePasswordError(status, body) {
  const raw =
    (body && (body.error_description || body.msg || body.message || body.error)) || "";
  const text = String(raw);
  const lower = text.toLowerCase();

  if (status === 429 || /rate limit|too many/i.test(lower)) {
    return "Too many attempts for now. Wait a little, then try again.";
  }
  if (
    /expired|invalid|not found|token|jwt|session/i.test(lower) ||
    status === 401 ||
    status === 403 ||
    status === 422
  ) {
    return "This reset link has expired or already been used. Request a new one below.";
  }
  if (/password/i.test(lower) && /(weak|short|least|length|strength)/i.test(lower)) {
    return "That password was rejected. Choose a longer one.";
  }
  if (text.trim().length > 0) return text.trim();
  if (status >= 500) return "The service could not be reached. Try again shortly.";
  return "The password could not be set. Request a new reset link below.";
}

// ── render (pure) ─────────────────────────────────────────────────────────────

// The no-oracle acknowledgment after a recover request. It NEVER reveals whether an
// account exists — the same line for a real address and an unknown one.
export const RECOVERY_SENT_COPY =
  "If that address is registered, a reset link is on its way.";

export function renderRecoverySent() {
  return `<div class="threshold-done" role="status">
  <p class="threshold-done-lead">Check your email.</p>
  <p>${escapeHtml(RECOVERY_SENT_COPY)}</p>
  <p class="threshold-done-note">The link opens a page here to set a new password. It expires; if it has, request another.</p>
</div>`;
}
