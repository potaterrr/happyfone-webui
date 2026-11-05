/**
 * app.js — hash router, Telnyx session guard, header rendering, and app wiring.
 *
 * GitHub Pages is static, so routing uses hashes:
 *   #/login-webui    → sign-in
 *   #/dashboard      → agent console
 *   #/password-change → change SIP/agent password
 */

import {
  AgentState,
  AUX_REASONS,
  bindAuxSelect,
  formatStateTime,
  STATUS,
} from './aux.js';
import { Dialer } from './dialer.js';
import { TelnyxTelephony } from './telephony.js';
import { TELNYX_CONFIG } from './config.js';

const ROUTES = Object.freeze({
  LOGIN: 'login',
  DASHBOARD: 'dashboard',
  PASSWORD: 'password',
});

const HASH = Object.freeze({
  LOGIN: '#/login-webui',
  DASHBOARD: '#/dashboard',
  PASSWORD: '#/password-change',
});

const $ = (selector) => document.querySelector(selector);

const el = {
  loginView: $('#view-login'),
  dashboardView: $('#view-dashboard'),
  passwordView: $('#view-password'),
  loginForm: $('#login-form'),
  username: $('#login-username'),
  extension: $('#login-extension'),
  password: $('#login-password'),
  passwordToggle: $('#password-toggle'),
  loginError: $('#login-error'),
  loginSubmit: $('#login-submit'),
  loginSubmitLabel: $('#login-submit-label'),
  micCheck: $('#mic-check'),
  micStatus: $('#mic-status'),
  micBtn: $('#mic-btn'),
  passwordForm: $('#password-form'),
  passwordUsername: $('#password-username'),
  passwordExtension: $('#password-extension'),
  passwordCurrent: $('#password-current'),
  passwordNew: $('#password-new'),
  passwordConfirm: $('#password-confirm'),
  passwordCurrentToggle: $('#password-current-toggle'),
  passwordNewToggle: $('#password-new-toggle'),
  passwordConfirmToggle: $('#password-confirm-toggle'),
  passwordError: $('#password-error'),
  passwordSuccess: $('#password-success'),
  passwordResult: $('#password-result'),
  passwordNewUsername: $('#password-new-username'),
  passwordNewPassword: $('#password-new-password'),
  passwordCopy: $('#password-copy'),
  passwordSubmit: $('#password-submit'),
  passwordSubmitLabel: $('#password-submit-label'),
  passwordLogoutBtn: $('#password-logout-btn'),
  telephonyBadge: $('#telephony-badge'),
  appFootMode: $('#app-foot-mode'),
  dialerFineprint: $('#dialer-fineprint'),
  agentName: $('#agent-name'),
  agentExt: $('#agent-ext'),
  agentAvatar: $('#agent-avatar'),
  statusBadge: $('#status-badge'),
  statusLabel: $('#status-label'),
  statusReason: $('#status-reason'),
  statusTimer: $('#status-timer'),
  auxSelect: $('#aux-select'),
  logoutBtn: $('#logout-btn'),
  toastRoot: $('#toast-root'),
};

const dialerEl = {
  view: $('#view-dashboard'),
  callPanel: $('#call-panel'),
  callState: $('#call-state'),
  callNumber: $('#call-number'),
  callTimer: $('#call-timer'),
  callDtmf: $('#call-dtmf'),
  mute: $('#mute-btn'),
  muteLabel: $('#mute-label'),
  hold: $('#hold-btn'),
  holdLabel: $('#hold-label'),
  hangup: $('#hangup-btn'),
  body: $('#dialer-body'),
  input: $('#phone-number'),
  hint: $('#dialer-hint'),
  keypad: $('#keypad'),
  backspace: $('#backspace-btn'),
  clear: $('#clear-btn'),
  callBtn: $('#call-btn'),
  state: $('#dialer-state'),
  historyBody: $('#history-body'),
  historyEmpty: $('#history-empty'),
  historyCount: $('#history-count'),
  clearHistory: $('#clear-history'),
};

const machine = new AgentState();
let dialer = null;
let currentRoute = null;
let telephony = null;
let liveSession = null;
let micGranted = false;
let passwordCompleted = false;
let passwordRedirectTimer = null;

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_ENDPOINT_DISABLED = 'Password change is not enabled on this server yet. Ask Dave to connect the password-change endpoint.';

const MIC_STATUS = Object.freeze({
  idle: 'Not checked yet.',
  requesting: 'Requesting microphone access…',
  ready: 'Microphone ready',
  blocked: 'Microphone permission blocked. Allow it in your browser settings and try again.',
  notfound: 'No microphone found. Connect a microphone and try again.',
  inuse: 'Microphone is in use by another app. Close it and try again.',
  insecure: 'Microphone access requires HTTPS (localhost is the exception).',
  unsupported: 'This browser cannot access the microphone.',
  unknown: 'Could not access the microphone. Try again.',
});

const MIC_FORM_ERROR = Object.freeze({
  blocked: 'Microphone permission is required. Allow microphone access in your browser, then try again.',
  notfound: 'No microphone was found. Connect a microphone and try again.',
  inuse: 'The microphone is in use by another app. Close it and try again.',
  insecure: 'Microphone access requires HTTPS (localhost is the exception).',
  unsupported: 'This browser cannot access the microphone. Use a supported browser and try again.',
  unknown: 'Could not access the microphone. Check your device and try again.',
});

/* ------------------------------------------------------------- utilities */
function initialsFor(name) {
  return name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || 'HP';
}

function applyAgent(user) {
  el.agentName.textContent = user.username;
  el.agentExt.textContent = `Ext. ${user.extension}`;
  el.agentAvatar.textContent = initialsFor(user.username);
}

/** Prefill the non-secret fields from config.js when they are blank. */
function applyConfigDefaults() {
  if (!el.username.value) el.username.value = TELNYX_CONFIG.username || '';
  if (!el.extension.value) el.extension.value = TELNYX_CONFIG.extension || '';
}

function resetLoginForm() {
  el.loginForm.reset();
  applyConfigDefaults();
  el.password.type = 'password';
  el.passwordToggle.textContent = 'Show';
  el.passwordToggle.setAttribute('aria-pressed', 'false');
  el.passwordToggle.setAttribute('aria-label', 'Show password');
}

function updateTelephonyChrome(live) {
  el.telephonyBadge.hidden = !live;
  el.appFootMode.textContent = 'Telnyx WebRTC · outbound calls';
  el.dialerFineprint.textContent = 'Telnyx call · outbound only · 5s wrap-up after hangup';
}

function toast(message, tone = 'info') {
  const item = document.createElement('div');
  item.className = `toast${tone === 'warn' ? ' is-warn' : tone === 'error' ? ' is-error' : ''}`;
  item.textContent = message;
  el.toastRoot.appendChild(item);

  while (el.toastRoot.children.length > 3) {
    el.toastRoot.firstElementChild?.remove();
  }

  window.setTimeout(() => {
    item.classList.add('is-leaving');
    window.setTimeout(() => item.remove(), 220);
  }, 2800);
}

/* ------------------------------------------------------------- auth */
function clearSession() {
  liveSession = null;
}

function getSession() {
  return liveSession;
}

/* ------------------------------------------------------------- routing */
function parseRoute() {
  const raw = (window.location.hash || '').replace(/^#\/?/, '').toLowerCase();
  if (raw === 'login-webui' || raw === 'login') return ROUTES.LOGIN;
  if (raw === 'dashboard') return ROUTES.DASHBOARD;
  if (raw === 'password-change' || raw === 'password') return ROUTES.PASSWORD;
  return null;
}

function resolveRoute() {
  const session = getSession();
  let route = parseRoute();

  /* The sign-in screen always comes first: an empty hash lands on login and
     an explicit #/login-webui never bounces to the dashboard. Dashboard and
     password-change both require a live in-memory Telnyx session. */
  if (!route) route = ROUTES.LOGIN;
  if (!session && (route === ROUTES.DASHBOARD || route === ROUTES.PASSWORD)) {
    route = ROUTES.LOGIN;
  }

  return { route, session };
}

function showView(route) {
  const isLogin = route === ROUTES.LOGIN;
  const isDashboard = route === ROUTES.DASHBOARD;
  const isPassword = route === ROUTES.PASSWORD;

  el.loginView.hidden = !isLogin;
  el.dashboardView.hidden = !isDashboard;
  el.passwordView.hidden = !isPassword;
  currentRoute = route;
  document.title = isDashboard
    ? 'Agent Console · HappyPhone WebUI'
    : isPassword
      ? 'Change password · HappyPhone WebUI'
      : 'Sign in · HappyPhone WebUI';
}

function renderRoute() {
  const { route, session } = resolveRoute();
  const canonical = route === ROUTES.DASHBOARD
    ? HASH.DASHBOARD
    : route === ROUTES.PASSWORD
      ? HASH.PASSWORD
      : HASH.LOGIN;

  if (window.location.hash !== canonical) {
    window.history.replaceState(null, '', canonical);
  }

  const enteringPassword = route === ROUTES.PASSWORD && currentRoute !== ROUTES.PASSWORD;
  showView(route);

  if (route === ROUTES.DASHBOARD && session) {
    applyAgent(session);
    updateTelephonyChrome(Boolean(telephony));
    dialer?.syncAvailability();
  }

  if (route === ROUTES.PASSWORD && session) {
    applyPasswordIdentity(session);
    if (enteringPassword) resetPasswordForm();
  }

  if (route !== ROUTES.PASSWORD) clearPasswordRedirectTimer();

  if (route === ROUTES.LOGIN) {
    el.loginError.hidden = true;
  }
}

function navigate(route, { replace = false } = {}) {
  const target = route === ROUTES.DASHBOARD
    ? HASH.DASHBOARD
    : route === ROUTES.PASSWORD
      ? HASH.PASSWORD
      : HASH.LOGIN;
  if (window.location.hash === target) {
    renderRoute();
    return;
  }
  if (replace) window.history.replaceState(null, '', target);
  else window.history.pushState(null, '', target);
  renderRoute();
}

/* ------------------------------------------------------------- login UI */
function setLoginError(message) {
  el.loginError.textContent = message;
  el.loginError.hidden = false;
}

function clearInvalidMarks() {
  [el.username, el.extension, el.password].forEach((input) => input.removeAttribute('aria-invalid'));
}

/* ------------------------------------------------------------- password change */
function passwordEndpoint() {
  const configured = (TELNYX_CONFIG.passwordChangeEndpoint || '').trim();
  if (configured) return configured;

  /* Blank-safe fallback: resolve relative to the deployed app directory so
     the page works at /caller/console/ and /caller/ without editing config. */
  return new URL('api/password', document.baseURI).pathname;
}

function setPasswordError(message) {
  el.passwordError.textContent = message;
  el.passwordError.hidden = false;
  el.passwordSuccess.hidden = true;
}

function clearPasswordMessages() {
  el.passwordError.hidden = true;
  el.passwordError.textContent = '';
  el.passwordSuccess.hidden = true;
  el.passwordSuccess.textContent = '';
}

function clearPasswordRedirectTimer() {
  if (passwordRedirectTimer) window.clearTimeout(passwordRedirectTimer);
  passwordRedirectTimer = null;
}

function resetPasswordToggle(button, input) {
  input.type = 'password';
  button.textContent = 'Show';
  button.setAttribute('aria-pressed', 'false');
  button.setAttribute('aria-label', button.dataset.showLabel || 'Show password');
}

function bindPasswordToggle(button, input) {
  if (!button.dataset.showLabel) {
    button.dataset.showLabel = button.getAttribute('aria-label') || 'Show password';
  }

  button.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    button.textContent = showing ? 'Show' : 'Hide';
    button.setAttribute('aria-pressed', String(!showing));
    button.setAttribute('aria-label', showing ? button.dataset.showLabel : 'Hide password');
    input.focus({ preventScroll: true });
  });
}

function applyPasswordIdentity(session) {
  el.passwordUsername.textContent = session.username;
  el.passwordExtension.textContent = `Ext. ${session.extension}`;
}

function setPasswordFieldsDisabled(disabled) {
  [el.passwordCurrent, el.passwordNew, el.passwordConfirm].forEach((input) => {
    input.disabled = disabled;
  });
  [el.passwordCurrentToggle, el.passwordNewToggle, el.passwordConfirmToggle].forEach((button) => {
    button.disabled = disabled;
  });
}

function resetPasswordForm() {
  passwordCompleted = false;
  el.passwordForm.reset();
  [el.passwordCurrent, el.passwordNew, el.passwordConfirm].forEach((input) => {
    input.removeAttribute('aria-invalid');
    input.disabled = false;
  });
  resetPasswordToggle(el.passwordCurrentToggle, el.passwordCurrent);
  resetPasswordToggle(el.passwordNewToggle, el.passwordNew);
  resetPasswordToggle(el.passwordConfirmToggle, el.passwordConfirm);
  [el.passwordCurrentToggle, el.passwordNewToggle, el.passwordConfirmToggle].forEach((button) => {
    button.disabled = false;
  });
  clearPasswordMessages();
  clearPasswordRedirectTimer();
  el.passwordResult.hidden = true;
  el.passwordNewUsername.textContent = '';
  el.passwordNewPassword.textContent = '';
  el.passwordSubmit.disabled = false;
  el.passwordSubmitLabel.textContent = 'Update password';
}

function finishPasswordChange() {
  clearPasswordRedirectTimer();
  resetPasswordForm();
  navigate(ROUTES.LOGIN, { replace: true });
  toast('Password changed. Sign in with your new credentials.');
}

async function disconnectTelephony() {
  dialer?.abortActiveCall();

  if (telephony) {
    try {
      await telephony.disconnect();
    } catch {
      /* Already disconnected. */
    }
    telephony = null;
  }
  dialer?.setTelephony(null);
}

async function handlePasswordSuccess(data) {
  passwordCompleted = true;
  setPasswordFieldsDisabled(true);
  clearPasswordMessages();

  const newUsername = typeof data.username === 'string' ? data.username : '';
  const newPassword = typeof data.password === 'string' ? data.password : '';

  el.passwordSuccess.hidden = false;

  if (newUsername && newPassword) {
    el.passwordNewUsername.textContent = newUsername;
    el.passwordNewPassword.textContent = newPassword;
    el.passwordResult.hidden = false;
    el.passwordSuccess.textContent = 'Password changed. Copy the new SIP credentials below — they are shown only once.';
    el.passwordSubmit.disabled = false;
    el.passwordSubmitLabel.textContent = 'Continue to sign in';
  } else {
    el.passwordSuccess.textContent = 'Password changed. Signing you out…';
    el.passwordSubmit.disabled = true;
    el.passwordSubmitLabel.textContent = 'Password changed';
    passwordRedirectTimer = window.setTimeout(finishPasswordChange, 3000);
  }

  await disconnectTelephony();
  machine.reset();
  clearSession();
  updateTelephonyChrome(false);
  toast('Password changed.');
}

async function submitPasswordChange() {
  if (passwordCompleted) {
    finishPasswordChange();
    return;
  }

  clearPasswordMessages();
  [el.passwordCurrent, el.passwordNew, el.passwordConfirm].forEach((input) => {
    input.removeAttribute('aria-invalid');
  });

  const currentPassword = el.passwordCurrent.value;
  const newPassword = el.passwordNew.value;
  const confirmation = el.passwordConfirm.value;

  const missing = [];
  if (!currentPassword) missing.push(el.passwordCurrent);
  if (!newPassword) missing.push(el.passwordNew);
  if (!confirmation) missing.push(el.passwordConfirm);

  if (missing.length > 0) {
    missing.forEach((input) => input.setAttribute('aria-invalid', 'true'));
    setPasswordError('Enter your current password, a new password, and the confirmation.');
    missing[0].focus({ preventScroll: true });
    return;
  }

  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    el.passwordNew.setAttribute('aria-invalid', 'true');
    setPasswordError(`New password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
    el.passwordNew.focus({ preventScroll: true });
    return;
  }

  if (newPassword !== confirmation) {
    el.passwordConfirm.setAttribute('aria-invalid', 'true');
    setPasswordError('New password and confirmation do not match.');
    el.passwordConfirm.focus({ preventScroll: true });
    return;
  }

  el.passwordSubmit.disabled = true;
  el.passwordSubmitLabel.textContent = 'Updating…';

  let response;
  try {
    response = await fetch(passwordEndpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        username: liveSession?.username || '',
        extension: liveSession?.extension || '',
        currentPassword,
        newPassword,
      }),
    });
  } catch {
    setPasswordError(PASSWORD_ENDPOINT_DISABLED);
    el.passwordSubmit.disabled = false;
    el.passwordSubmitLabel.textContent = 'Update password';
    return;
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    /* Some servers reply with an empty body or plain text. */
  }

  const successful = (response.status === 200 || response.status === 201) && data?.ok === true;

  if (successful) {
    await handlePasswordSuccess(data);
    return;
  }

  if ([404, 405, 501].includes(response.status)) {
    setPasswordError(PASSWORD_ENDPOINT_DISABLED);
  } else if ([400, 401, 403].includes(response.status)) {
    setPasswordError(
      data?.error
      || data?.message
      || `The server rejected the password change (HTTP ${response.status}).`,
    );
  } else if (data?.error || data?.message) {
    setPasswordError(String(data.error || data.message));
  } else {
    setPasswordError(`Password change failed (HTTP ${response.status}). Try again.`);
  }

  el.passwordSubmit.disabled = false;
  el.passwordSubmitLabel.textContent = 'Update password';
}

function bindPasswordChange() {
  bindPasswordToggle(el.passwordCurrentToggle, el.passwordCurrent);
  bindPasswordToggle(el.passwordNewToggle, el.passwordNew);
  bindPasswordToggle(el.passwordConfirmToggle, el.passwordConfirm);

  [el.passwordCurrent, el.passwordNew, el.passwordConfirm].forEach((input) => {
    input.addEventListener('input', () => {
      input.removeAttribute('aria-invalid');
      el.passwordError.hidden = true;
    });
  });

  el.passwordForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitPasswordChange();
  });

  el.passwordCopy.addEventListener('click', async () => {
    const text = `SIP username: ${el.passwordNewUsername.textContent}\nSIP password: ${el.passwordNewPassword.textContent}`;
    try {
      await navigator.clipboard.writeText(text);
      toast('New credentials copied.');
    } catch {
      toast('Copy failed. Select the credentials and copy them manually.', 'warn');
    }
  });

  el.passwordLogoutBtn.addEventListener('click', logout);
}

/* ------------------------------------------------------------- microphone */
function micAvailable() {
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

function setMicState(state, message) {
  el.micCheck.dataset.state = state;
  el.micStatus.textContent = message;
  el.micCheck.setAttribute('aria-busy', state === 'requesting' ? 'true' : 'false');
  el.micBtn.hidden = state === 'ready';
  el.micBtn.disabled = state === 'requesting';
}

function micErrorState(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
    case 'AbortError':
      return 'blocked';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'notfound';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'inuse';
    default:
      return 'unknown';
  }
}

/** Request microphone access and stop the tracks immediately after success. */
async function requestMicrophone() {
  if (!micAvailable()) {
    const state = window.isSecureContext ? 'unsupported' : 'insecure';
    setMicState('error', MIC_STATUS[state]);
    return { ok: false, state };
  }

  setMicState('requesting', MIC_STATUS.requesting);

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    micGranted = true;
    setMicState('ready', MIC_STATUS.ready);
    return { ok: true, state: 'ready' };
  } catch (error) {
    micGranted = false;
    const state = micErrorState(error);
    setMicState('error', MIC_STATUS[state]);
    return { ok: false, state };
  }
}

/** Pick up an existing browser grant so we do not prompt again needlessly. */
async function syncMicPermission() {
  if (!micAvailable() || !navigator.permissions?.query) return;

  try {
    const permission = await navigator.permissions.query({ name: 'microphone' });
    const apply = () => {
      if (permission.state === 'granted') {
        micGranted = true;
        setMicState('ready', MIC_STATUS.ready);
      } else if (permission.state === 'denied') {
        micGranted = false;
        setMicState('error', MIC_STATUS.blocked);
      }
    };

    apply();
    permission.addEventListener?.('change', apply);
  } catch {
    /* Microphone permission queries are not supported everywhere. */
  }
}

function bindLogin() {
  [el.username, el.extension, el.password].forEach((input) => {
    input.addEventListener('input', () => {
      input.removeAttribute('aria-invalid');
      el.loginError.hidden = true;
    });
  });

  el.passwordToggle.addEventListener('click', () => {
    const showing = el.password.type === 'text';
    el.password.type = showing ? 'password' : 'text';
    el.passwordToggle.textContent = showing ? 'Show' : 'Hide';
    el.passwordToggle.setAttribute('aria-pressed', String(!showing));
    el.passwordToggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    el.password.focus({ preventScroll: true });
  });

  el.micBtn.addEventListener('click', () => {
    el.loginError.hidden = true;
    void requestMicrophone();
  });

  el.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearInvalidMarks();

    const username = el.username.value.trim() || TELNYX_CONFIG.username;
    const extension = el.extension.value.trim() || TELNYX_CONFIG.extension;
    const password = el.password.value || TELNYX_CONFIG.password;

    const missing = [];
    if (!username) missing.push(el.username);
    if (!extension) missing.push(el.extension);
    if (!password.trim()) missing.push(el.password);

    if (missing.length > 0) {
      missing.forEach((input) => input.setAttribute('aria-invalid', 'true'));
      setLoginError('Enter your SIP username, agent extension, and password to continue.');
      missing[0].focus({ preventScroll: true });
      return;
    }

    el.loginError.hidden = true;

    /* Microphone permission is a precondition: never register with Telnyx
       without it, otherwise the first call fails after signalling succeeds. */
    if (!micGranted) {
      el.loginSubmit.disabled = true;
      el.loginSubmitLabel.textContent = 'Checking microphone…';
      const mic = await requestMicrophone();

      if (!mic.ok) {
        setLoginError(MIC_FORM_ERROR[mic.state] || MIC_FORM_ERROR.unknown);
        el.loginSubmit.disabled = false;
        el.loginSubmitLabel.textContent = 'Sign in';
        return;
      }
    }

    el.loginSubmit.disabled = true;
    el.loginSubmitLabel.textContent = 'Connecting…';

    let nextTelephony = null;

    try {
      nextTelephony = new TelnyxTelephony();
      await nextTelephony.connect({ login: username, password });

      telephony = nextTelephony;
      dialer.setTelephony(telephony);
      liveSession = { username, extension, mode: 'telnyx' };
      machine.reset();
      applyAgent(liveSession);
      resetLoginForm();
      updateTelephonyChrome(true);
      navigate(ROUTES.DASHBOARD, { replace: true });
      toast('Connected to Telnyx. Ready for calls.');
    } catch (error) {
      if (nextTelephony) await nextTelephony.disconnect();
      telephony = null;
      dialer.setTelephony(null);
      liveSession = null;
      setLoginError(error?.message || 'Could not connect to Telnyx.');
      toast('Telnyx connection failed.', 'error');
    } finally {
      el.loginSubmit.disabled = false;
      el.loginSubmitLabel.textContent = 'Sign in';
    }
  });
}

async function logout() {
  await disconnectTelephony();

  dialer?.clearHistory();
  machine.reset();
  clearSession();
  resetLoginForm();
  el.loginError.hidden = true;
  updateTelephonyChrome(false);
  navigate(ROUTES.LOGIN, { replace: true });
  toast('Signed out.');
}

/* ------------------------------------------------------------- header */
function renderStatus() {
  const status = machine.status;
  const label = status === STATUS.ON_CALL ? 'ON CALL' : status === STATUS.WRAP_UP ? 'WRAP UP' : status;

  el.statusBadge.dataset.status = status;
  el.statusLabel.textContent = label;

  if (status === STATUS.AUX && machine.auxReason) {
    el.statusReason.hidden = false;
    el.statusReason.textContent = (AUX_REASONS[machine.auxReason]?.label || '').toUpperCase();
  } else {
    el.statusReason.hidden = true;
    el.statusReason.textContent = '';
  }

  updateStateTimer();
}

function updateStateTimer(now = Date.now()) {
  if (machine.status === STATUS.WRAP_UP) {
    const remaining = Math.ceil(machine.wrapUpRemaining(now) / 1000) * 1000;
    el.statusTimer.textContent = formatStateTime(remaining);
  } else {
    el.statusTimer.textContent = formatStateTime(machine.elapsed(now));
  }
}

/* ------------------------------------------------------------- boot */
function tick() {
  machine.tick();

  if (currentRoute !== ROUTES.DASHBOARD) return;

  updateStateTimer();
  dialer.tick();
}

/** Fallback alias if the inline head bootstrap did not run first. */
function normalizePasswordPath() {
  if (window.location.hash) return;
  const match = window.location.pathname.match(/^(.*)\/password-change\/?$/);
  if (!match) return;
  window.history.replaceState(null, '', `${match[1]}/#/password-change`);
}

function init() {
  normalizePasswordPath();

  dialer = new Dialer({ machine, elements: dialerEl, notify: toast });
  bindAuxSelect(el.auxSelect, machine, { notify: toast });
  machine.subscribe(renderStatus);

  applyConfigDefaults();
  updateTelephonyChrome(false);
  bindLogin();
  bindPasswordChange();
  resetPasswordForm();
  void syncMicPermission();
  el.logoutBtn.addEventListener('click', logout);
  window.addEventListener('hashchange', renderRoute);
  window.addEventListener('popstate', renderRoute);
  window.addEventListener('beforeunload', () => {
    if (telephony) telephony.disconnect();
  });

  renderStatus();
  renderRoute();
  window.setInterval(tick, 500);
}

init();
