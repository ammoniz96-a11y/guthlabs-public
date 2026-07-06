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
  login,
  resumeSession,
  readSession,
  saveSession,
  clearSession,
  renderFieldError,
  renderSignupError,
  renderSignupSuccess,
  renderSignedIn,
  PASSWORD_MASK,
  // LWO-6 — forgot-password flow
  requestRecovery,
  parseRecoveryHash,
  validateNewPassword,
  updatePassword,
  renderRecoverySent,
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

// ── the Threshold: signup, login, and the remember-me theatre ────────────────
//
// Wires the account panel (index.html) to the pure auth core (auth.js). On load,
// mountThreshold decides which face to show:
//
//   1. A stored, resumable session → the LOGIN form, pre-filled: the real email,
//      and the password field showing the fixed PASSWORD_MASK. This is the theatre
//      (TONE Law 1) — the return visit looks like the first, but the visitor need
//      only press "login". That click runs a refresh-token grant; NO password is
//      sent (none is stored, none is needed). If the refresh grant reports the
//      session expired, the mask is cleared and an honest real login is required.
//
//   2. No session → the SIGNUP form (create an account), with a quiet switch to a
//      plain login form for a returning visitor whose session this browser never
//      stored (a new device, cleared storage).
//
// Every network call routes through the injectable auth.js functions with the
// browser's global fetch; the endpoints are only ever hit by a real visitor's
// action. The publishable (anon) key and URL come from config.js.

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

function clearFormErrors(form) {
  for (const slot of form.querySelectorAll(".field-error-slot")) {
    slot.innerHTML = "";
  }
  for (const input of form.querySelectorAll("input")) {
    input.removeAttribute("aria-invalid");
  }
  const formErr = form.querySelector('[data-error-for$="-form"]');
  if (formErr) formErr.innerHTML = "";
}

function setFormError(form, message) {
  const formErr = form.querySelector('[data-error-for$="-form"]');
  if (formErr) formErr.innerHTML = renderSignupError(message);
}

// Map a validateSignup errors object (keyed by logical field name) onto the signup
// form's inline slots (which are keyed by field id).
function showSignupFieldErrors(form, errors) {
  for (const [field, msg] of Object.entries(errors)) {
    const slot = form.querySelector(`[data-error-for="${field}"]`);
    if (slot) slot.innerHTML = renderFieldError(msg);
    const input = form.elements[field];
    if (input) input.setAttribute("aria-invalid", "true");
  }
}

function busyButton(form, label) {
  const btn = form.querySelector('button[type="submit"]');
  if (!btn) return null;
  btn.disabled = true;
  btn.dataset.label = btn.dataset.label || btn.textContent;
  btn.textContent = label;
  return btn;
}

function resetButton(btn) {
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = btn.dataset.label || btn.textContent;
}

// Replace the whole account panel with a terminal state (success / signed-in).
function replacePanel(panel, html) {
  panel.outerHTML = html;
}

export function mountThreshold() {
  const panel = document.querySelector(".threshold-account");
  if (!panel) return;

  const signupForm = el("signup-form");
  const loginForm = el("login-form");
  const recoverForm = el("recover-form");
  const newPasswordForm = el("new-password-form");
  const storage = browserStorage();

  // ── mode switching ─────────────────────────────────────────────────────────
  // Faces: signup / login / recover (enter email for a reset) / new-password
  // (set a new password after landing on a recovery link). Exactly one is shown.
  function showMode(mode) {
    panel.dataset.mode = mode;
    if (signupForm) signupForm.hidden = mode !== "signup";
    if (loginForm) loginForm.hidden = mode !== "login";
    if (recoverForm) recoverForm.hidden = mode !== "recover";
    if (newPasswordForm) newPasswordForm.hidden = mode !== "new-password";
  }

  const KNOWN_MODES = new Set(["signup", "login", "recover", "new-password"]);
  for (const btn of panel.querySelectorAll(".threshold-switch")) {
    btn.addEventListener("click", () => {
      const to = btn.dataset.switchTo;
      // Leaving the theatre by hand: a manual switch away from login should not keep a
      // masked password around. Clear both login fields so nothing pre-filled lingers.
      if (loginForm) {
        loginForm.reset();
        clearFormErrors(loginForm);
      }
      if (signupForm) clearFormErrors(signupForm);
      if (recoverForm) clearFormErrors(recoverForm);
      showMode(KNOWN_MODES.has(to) ? to : "signup");
    });
  }

  // ── the theatre: pre-fill on a stored session ────────────────────────────────
  // A stored session flips the panel to the login form, pre-filled with the real
  // email and the FIXED mask. The password field is put into a "masked" state: the
  // mask is display-only, and pressing "login" resumes via the refresh token. If the
  // visitor edits the password field, the mask is dropped and a real password login
  // takes over (the honest fallback if they'd rather type it).
  // ── recovery landing takes precedence over everything ────────────────────────
  // If the page loaded on a reset link (type=recovery tokens in the URL hash), the
  // ONE thing to do is let the visitor set a new password — regardless of any stored
  // session. Detect it first; if present, show the set-new-password form and stop the
  // normal theatre/signup decision. The token stays in the hash (never a query, never
  // storage) until the PUT succeeds.
  const recovery = (() => {
    try {
      return parseRecoveryHash(globalThis.location ? globalThis.location.hash : "");
    } catch {
      return null;
    }
  })();

  const stored = readSession(storage);
  let masked = false; // true while the login password field holds the display mask

  if (recovery && newPasswordForm) {
    wireNewPasswordForm(recovery);
    showMode("new-password");
  } else if (stored && loginForm) {
    const emailInput = loginForm.elements.email;
    const pwInput = loginForm.elements.password;
    if (emailInput) emailInput.value = stored.email || "";
    if (pwInput) {
      pwInput.value = PASSWORD_MASK;
      masked = true;
      // The first real keystroke clears the mask and hands control to password login.
      const dropMask = () => {
        if (!masked) return;
        masked = false;
        pwInput.value = "";
      };
      pwInput.addEventListener("focus", dropMask, { once: true });
      pwInput.addEventListener("beforeinput", dropMask, { once: true });
    }
    showMode("login");
  } else {
    showMode("signup");
  }

  // ── signup submit ────────────────────────────────────────────────────────────
  if (signupForm) {
    signupForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearFormErrors(signupForm);

      const input = {
        username: signupForm.elements.username?.value ?? "",
        email: signupForm.elements.email?.value ?? "",
        password: signupForm.elements.password?.value ?? "",
        confirm: signupForm.elements.confirm?.value ?? "",
      };

      const { ok, errors } = validateSignup(input);
      if (!ok) {
        showSignupFieldErrors(signupForm, errors);
        const first = signupForm.elements[Object.keys(errors)[0]];
        if (first && typeof first.focus === "function") first.focus();
        return;
      }

      const btn = busyButton(signupForm, "Registering…");
      const result = await signup(
        {
          supabaseUrl: CONFIG.SUPABASE_URL,
          publishableKey: CONFIG.PUBLISHABLE_KEY,
          username: input.username.trim(),
          email: input.email.trim(),
          password: input.password,
        },
        browserFetch(),
      );

      if (result.ok) {
        replacePanel(panel, renderSignupSuccess());
        return;
      }
      setFormError(signupForm, result.message);
      resetButton(btn);
    });
  }

  // ── login submit (real password grant OR the theatre's refresh resume) ─────────
  if (loginForm) {
    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearFormErrors(loginForm);

      // The theatre path: the mask is still in place → resume via refresh token,
      // sending NO password. The stored session is the credential.
      if (masked && stored) {
        const btn = busyButton(loginForm, "Signing in…");
        const result = await resumeSession(
          {
            supabaseUrl: CONFIG.SUPABASE_URL,
            publishableKey: CONFIG.PUBLISHABLE_KEY,
            refresh_token: stored.refresh_token,
            email: stored.email,
          },
          browserFetch(),
        );

        if (result.ok) {
          saveSession(storage, result.session); // store the rotated token pair
          replacePanel(panel, renderSignedIn(result.session.email));
          return;
        }
        if (result.expired) {
          // The session is gone. Clear it, drop the mask, require a real login.
          clearSession(storage);
          masked = false;
          const pwInput = loginForm.elements.password;
          if (pwInput) {
            pwInput.value = "";
            if (typeof pwInput.focus === "function") pwInput.focus();
          }
          setFormError(
            loginForm,
            "Your saved session has expired. Please sign in with your password.",
          );
          resetButton(btn);
          return;
        }
        // A transient (network) failure — keep the session, let the visitor retry.
        setFormError(loginForm, result.message || "Could not sign in. Try again.");
        resetButton(btn);
        return;
      }

      // The real login path: an actual email + password grant.
      const email = (loginForm.elements.email?.value ?? "").trim();
      const password = loginForm.elements.password?.value ?? "";
      if (email.length === 0 || password.length === 0) {
        setFormError(loginForm, "Enter your email and password.");
        return;
      }

      const btn = busyButton(loginForm, "Signing in…");
      const result = await login(
        {
          supabaseUrl: CONFIG.SUPABASE_URL,
          publishableKey: CONFIG.PUBLISHABLE_KEY,
          email,
          password,
        },
        browserFetch(),
      );

      if (result.ok) {
        saveSession(storage, result.session);
        replacePanel(panel, renderSignedIn(result.session.email));
        return;
      }
      setFormError(loginForm, result.message);
      resetButton(btn);
    });
  }

  // ── recover submit: request a reset link (no existence oracle) ────────────────
  if (recoverForm) {
    recoverForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearFormErrors(recoverForm);

      const email = (recoverForm.elements.email?.value ?? "").trim();
      if (email.length === 0) {
        const slot = recoverForm.querySelector('[data-error-for="recover-email"]');
        if (slot) slot.innerHTML = renderFieldError("An email is required.");
        const input = recoverForm.elements.email;
        if (input && typeof input.focus === "function") input.focus();
        return;
      }

      const btn = busyButton(recoverForm, "Sending…");
      const result = await requestRecovery(
        {
          supabaseUrl: CONFIG.SUPABASE_URL,
          publishableKey: CONFIG.PUBLISHABLE_KEY,
          email,
        },
        browserFetch(),
      );

      // The no-oracle contract: a success shows the SAME line whether or not the
      // address is registered. Only a real failure (rate limit, transport, server)
      // keeps the form up with an honest error — never dressed as sent.
      if (result.ok) {
        replacePanel(panel, renderRecoverySent());
        return;
      }
      setFormError(recoverForm, result.message);
      resetButton(btn);
    });
  }

  // ── set-new-password: applied via PUT /auth/v1/user with the recovery token ────
  function wireNewPasswordForm(recoveryCtx) {
    if (!newPasswordForm) return;
    newPasswordForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearFormErrors(newPasswordForm);

      const input = {
        password: newPasswordForm.elements.password?.value ?? "",
        confirm: newPasswordForm.elements.confirm?.value ?? "",
      };
      const { ok, errors } = validateNewPassword(input);
      if (!ok) {
        for (const [field, msg] of Object.entries(errors)) {
          // logical field name → the form's slot id (password / confirm)
          const slotId = field === "confirm" ? "new-password-confirm" : "new-password";
          const slot = newPasswordForm.querySelector(`[data-error-for="${slotId}"]`);
          if (slot) slot.innerHTML = renderFieldError(msg);
          const el = newPasswordForm.elements[field];
          if (el) el.setAttribute("aria-invalid", "true");
        }
        return;
      }

      const btn = busyButton(newPasswordForm, "Setting…");
      const result = await updatePassword(
        {
          supabaseUrl: CONFIG.SUPABASE_URL,
          publishableKey: CONFIG.PUBLISHABLE_KEY,
          accessToken: recoveryCtx.access_token,
          refreshToken: recoveryCtx.refresh_token,
          password: input.password,
        },
        browserFetch(),
      );

      if (result.ok) {
        // The recovery token pair is now the signed-in session. Store it, clear the
        // sensitive hash from the URL, and land on the signed-in state.
        saveSession(storage, result.session);
        try {
          if (globalThis.history && globalThis.location) {
            globalThis.history.replaceState(
              null,
              "",
              globalThis.location.pathname + globalThis.location.search,
            );
          }
        } catch {
          /* clearing the hash is best-effort; the session is already stored */
        }
        replacePanel(panel, renderSignedIn(result.session.email));
        return;
      }

      if (result.expired) {
        // The link is expired or already used. Offer to send another: drop to the
        // recover form with an honest explanation carried over.
        resetButton(btn);
        showMode("recover");
        if (recoverForm) {
          clearFormErrors(recoverForm);
          setFormError(
            recoverForm,
            result.message ||
              "This reset link has expired or already been used. Request a new one below.",
          );
        }
        return;
      }

      // A rate limit or transport failure — keep the form up, let them retry.
      setFormError(newPasswordForm, result.message || "Could not set the password.");
      resetButton(btn);
    });
  }
}
