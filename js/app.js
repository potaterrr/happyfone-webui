/**
 * app.js — hash router, Telnyx session guard, header rendering, and app wiring.
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
import { TELNYX_CONFIG } from './config.js';

const ROUTES = Object.freeze({
  LOGIN: 'login',
  DASHBOARD: 'dashboard',
});

const HASH = Object.freeze({
  LOGIN: '#/login-webui',
  DASHBOARD: '#/dashboard',
});

const $ = (selector) => document.querySelector(selector);

const el = {
  loginView: $('#view-login'),
  dashboardView: $('#view-dashboard'),
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
  return null;
}

function resolveRoute() {
  const session = getSession();
  let route = parseRoute();

  /* The sign-in screen always comes first: an empty hash lands on login and
     an explicit #/login-webui never bounces to the dashboard. Only
     #/dashboard requires a live in-memory Telnyx session. */
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
    ? 'Agent Console · HappyPhone WebUI'
    : 'Sign in · HappyPhone WebUI';
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
    updateTelephonyChrome(Boolean(telephony));
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

function init() {
  dialer = new Dialer({ machine, elements: dialerEl, notify: toast });
  bindAuxSelect(el.auxSelect, machine, { notify: toast });
  machine.subscribe(renderStatus);

  applyConfigDefaults();
  updateTelephonyChrome(false);
  bindLogin();
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
