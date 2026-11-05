/**
 * app.js — hash router, mock auth/session guard, header rendering, and app wiring.
 *
 * GitHub Pages is static, so routing uses hashes:
 *   #/login-webui  → sign-in
 *   #/dashboard    → agent console
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

const TOKEN_KEY = 'happyfone.token';
const USER_KEY = 'happyfone.user';
const MODE_KEY = 'happyfone.mode';
const TOKEN_TTL_SECONDS = 12 * 60 * 60;

const ROUTES = Object.freeze({
  LOGIN: 'login',
  DASHBOARD: 'dashboard',
});

const HASH = Object.freeze({
  LOGIN: '#/login-webui',
  DASHBOARD: '#/dashboard',
});

const $ = (selector) => document.querySelector(selector);

const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

const el = {
  loginView: $('#view-login'),
  dashboardView: $('#view-dashboard'),
  loginForm: $('#login-form'),
  username: $('#login-username'),
  extension: $('#login-extension'),
  password: $('#login-password'),
  passwordToggle: $('#password-toggle'),
  loginError: $('#login-error'),
  loginTitle: $('#login-title'),
  loginCopy: $('#login-copy'),
  loginSubmit: $('#login-submit'),
  loginSubmitLabel: $('#login-submit-label'),
  modeNoteText: $('#mode-note-text'),
  loginNoteText: $('#login-note-text'),
  featureCall: $('#feature-call'),
  modeButtons: document.querySelectorAll('.mode-option[data-mode]'),
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
let loginMode = storage.get(MODE_KEY) === 'telnyx' ? 'telnyx' : 'simulation';

/* ------------------------------------------------------------- utilities */
function base64UrlEncodeJson(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeJson(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function createDummyJwt(user) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: user.username,
    name: user.username,
    extension: user.extension,
    role: 'agent',
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };
  return [
    base64UrlEncodeJson(header),
    base64UrlEncodeJson(payload),
    base64UrlEncodeJson({ demo: true, signature: 'happyfone-local' }),
  ].join('.');
}

function initialsFor(name) {
  return name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || 'HF';
}

function applyAgent(user) {
  el.agentName.textContent = user.username;
  el.agentExt.textContent = `Ext. ${user.extension}`;
  el.agentAvatar.textContent = initialsFor(user.username);
}

function resetLoginForm() {
  el.loginForm.reset();
  el.password.type = 'password';
  el.passwordToggle.textContent = 'Show';
  el.passwordToggle.setAttribute('aria-pressed', 'false');
  el.passwordToggle.setAttribute('aria-label', 'Show password');
}

function updateTelephonyChrome(live) {
  el.telephonyBadge.hidden = !live;
  el.appFootMode.textContent = live
    ? 'Telnyx test mode · outbound calls only'
    : 'Simulated telephony environment · local demo data';
  el.dialerFineprint.textContent = live
    ? 'Telnyx test call · outbound only · 5s wrap-up after hangup'
    : 'Simulated call · rings 3s · 5s wrap-up after hangup';
}

function setLoginMode(mode) {
  loginMode = mode === 'telnyx' ? 'telnyx' : 'simulation';
  storage.set(MODE_KEY, loginMode);

  const live = loginMode === 'telnyx';

  /* Do not let a stale demo session bypass the Telnyx sign-in. */
  if (live) {
    storage.remove(TOKEN_KEY);
    storage.remove(USER_KEY);
  }

  el.modeButtons.forEach((button) => {
    const active = button.dataset.mode === loginMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });

  el.username.maxLength = live ? 128 : 48;
  el.username.placeholder = live ? 'gencred…' : 'alex.rivera';
  el.username.closest('.field').querySelector('label').textContent = live ? 'SIP username' : 'Username';
  el.extension.closest('.field').querySelector('label').textContent = live ? 'Agent extension' : 'Extension';
  el.password.closest('.field').querySelector('label').textContent = live ? 'SIP password' : 'Password';

  el.loginTitle.textContent = live ? 'Telnyx test mode' : 'Welcome back';
  el.loginCopy.textContent = live
    ? 'Enter your Telnyx SIP credential to register and place real outbound test calls.'
    : 'Enter your agent credentials to open the console.';
  el.loginSubmitLabel.textContent = live ? 'Connect & sign in' : 'Sign in';
  el.modeNoteText.textContent = live
    ? 'Test mode — credentials stay in this tab and are never saved.'
    : 'Demo environment — any non-empty credentials will sign you in.';
  el.loginNoteText.textContent = live
    ? 'Telnyx test mode · real outbound calls'
    : 'Simulated telephony sandbox · no real calls are placed';
  el.featureCall.textContent = live
    ? 'Live Telnyx outbound test calls'
    : 'Simulated WebRTC call lifecycle';
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
  storage.remove(TOKEN_KEY);
  storage.remove(USER_KEY);
}

function saveSession(user) {
  storage.set(TOKEN_KEY, createDummyJwt(user));
  storage.set(USER_KEY, JSON.stringify(user));
}

function getSession() {
  if (liveSession) return liveSession;

  /* Telnyx sessions live only in memory: the SIP client cannot survive a
     reload, so a refresh must go back through the sign-in screen. */
  if (loginMode === 'telnyx') return null;

  const token = storage.get(TOKEN_KEY);
  if (!token) return null;

  try {
    const payload = base64UrlDecodeJson(token.split('.')[1] || '');
    if (!payload?.exp || payload.exp * 1000 <= Date.now()) throw new Error('expired');

    const rawUser = storage.get(USER_KEY);
    const stored = rawUser ? JSON.parse(rawUser) : null;
    const username = stored?.username || payload.sub || payload.name;
    const extension = stored?.extension || payload.extension;
    if (!username || !extension) throw new Error('incomplete');

    return { username: String(username), extension: String(extension) };
  } catch {
    clearSession();
    return null;
  }
}

/* ------------------------------------------------------------- routing */
function parseRoute() {
  const raw = (window.location.hash || '').replace(/^#\/?/, '').toLowerCase();
  if (raw === 'login-webui' || raw === 'login') return ROUTES.LOGIN;
  if (raw === 'dashboard') return ROUTES.DASHBOARD;
  return null;
}

function resolveRoute() {
  const session = getSession();
  let route = parseRoute();

  /* The sign-in screen always comes first: an empty hash lands on login and
     an explicit #/login-webui never bounces to the dashboard, even when a
     stored session still exists. Only #/dashboard requires a session. */
  if (!route) route = ROUTES.LOGIN;
  if (!session && route === ROUTES.DASHBOARD) route = ROUTES.LOGIN;

  return { route, session };
}

function showView(route) {
  const isDashboard = route === ROUTES.DASHBOARD;
  el.loginView.hidden = isDashboard;
  el.dashboardView.hidden = !isDashboard;
  currentRoute = route;
  document.title = isDashboard
    ? 'Agent Console · HappyFone WebUI'
    : 'Sign in · HappyFone WebUI';
}

function renderRoute() {
  const { route, session } = resolveRoute();
  const canonical = route === ROUTES.DASHBOARD ? HASH.DASHBOARD : HASH.LOGIN;

  if (window.location.hash !== canonical) {
    window.history.replaceState(null, '', canonical);
  }

  showView(route);

  if (route === ROUTES.DASHBOARD && session) {
    applyAgent(session);
    updateTelephonyChrome(Boolean(liveSession));
    dialer?.syncAvailability();
  }

  if (route === ROUTES.LOGIN) {
    el.loginError.hidden = true;
  }
}

function navigate(route, { replace = false } = {}) {
  const target = route === ROUTES.DASHBOARD ? HASH.DASHBOARD : HASH.LOGIN;
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

function bindLogin() {
  [el.username, el.extension, el.password].forEach((input) => {
    input.addEventListener('input', () => {
      input.removeAttribute('aria-invalid');
      el.loginError.hidden = true;
    });
  });

  el.modeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      setLoginMode(button.dataset.mode);
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

  el.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearInvalidMarks();

    const username = el.username.value.trim();
    const extension = el.extension.value.trim();
    const password = el.password.value;

    const missing = [];
    if (!username) missing.push(el.username);
    if (!extension) missing.push(el.extension);
    if (!password.trim()) missing.push(el.password);

    if (missing.length > 0) {
      missing.forEach((input) => input.setAttribute('aria-invalid', 'true'));
      setLoginError('Enter your username, extension, and password to continue.');
      missing[0].focus({ preventScroll: true });
      return;
    }

    if (loginMode === 'telnyx') {
      el.loginSubmit.disabled = true;
      el.loginSubmitLabel.textContent = 'Connecting…';
      el.loginError.hidden = true;

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
        toast('Connected to Telnyx. Ready for test calls.');
      } catch (error) {
        if (nextTelephony) await nextTelephony.disconnect();
        telephony = null;
        dialer.setTelephony(null);
        liveSession = null;
        setLoginError(error?.message || 'Could not connect to Telnyx.');
        toast('Telnyx connection failed.', 'error');
      } finally {
        el.loginSubmit.disabled = false;
        el.loginSubmitLabel.textContent = loginMode === 'telnyx' ? 'Connect & sign in' : 'Sign in';
      }
      return;
    }

    const user = { username, extension };
    saveSession(user);
    machine.reset();
    applyAgent(user);
    resetLoginForm();
    updateTelephonyChrome(false);
    navigate(ROUTES.DASHBOARD, { replace: true });
    toast(`Signed in as ${user.username}.`);
  });
}

async function logout() {
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

  dialer?.clearHistory();
  machine.reset();
  clearSession();
  el.loginForm.reset();
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

function init() {
  dialer = new Dialer({ machine, elements: dialerEl, notify: toast });
  bindAuxSelect(el.auxSelect, machine, { notify: toast });
  machine.subscribe(renderStatus);

  setLoginMode(loginMode);
  updateTelephonyChrome(false);
  bindLogin();
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
