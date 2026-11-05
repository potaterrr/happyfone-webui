/**
 * dialer.js — keypad input, Telnyx call lifecycle, and persistent call history.
 *
 * Call flow: AVAILABLE → dial → ringing → connected → hangup → WRAP_UP (5s).
 */

import {
  AUX_REASONS,
  STATUS,
  formatDuration,
  formatStateTime,
} from './aux.js';

const HISTORY_KEY = 'happyphone.history.v1';
const MAX_HISTORY = 50;
const MAX_NUMBER_LENGTH = 20;
const KEY_FLASH_MS = 140;
const DTMF_CLEAR_MS = 900;

/** Physical keyboard letters → T9 digits, so "1-800-FLOWERS" can be typed. */
const T9 = {
  a: '2', b: '2', c: '2',
  d: '3', e: '3', f: '3',
  g: '4', h: '4', i: '4',
  j: '5', k: '5', l: '5',
  m: '6', n: '6', o: '6',
  p: '7', q: '7', r: '7', s: '7',
  t: '8', u: '8', v: '8',
  w: '9', x: '9', y: '9', z: '9',
};

const DIAL_CHARS = /^[\d*#+]$/;

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

function readHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && typeof entry.number === 'string' && Number.isFinite(entry.startedAt))
      .slice(0, MAX_HISTORY);
  } catch {
    return [];
  }
}

function persistHistory(entries) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
  } catch {
    /* Storage can be blocked in private or embedded contexts. */
  }
}

function removeHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    /* ignore */
  }
}

function makeId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export class Dialer {
  constructor({ machine, elements, notify }) {
    this.machine = machine;
    this.el = elements;
    this.notify = notify;
    this.call = null;
    this.telephony = null;
    this.endTimer = null;
    this.history = readHistory();
    this.confirmClearTimer = null;
    this.confirmClear = false;
    this.dtmfTimer = null;
    this.keyFlashTimers = new WeakMap();

    this.#bind();
    this.renderHistory();
    this.syncAvailability();
    machine.subscribe(() => this.syncAvailability());
  }

  /** Wire the Telnyx telephony adapter. */
  setTelephony(telephony) {
    this.telephony = telephony || null;
    if (this.telephony) {
      this.telephony.onEvent = (event) => this.#onTelephonyEvent(event);
    }
  }

  #bind() {
    this.el.input.addEventListener('input', () => this.#sanitizeInput());
    window.addEventListener('keydown', (event) => this.#onKeyDown(event));

    this.el.keypad.addEventListener('click', (event) => {
      const key = event.target.closest('button[data-key]');
      if (!key || key.disabled) return;
      this.#blurOnPointer(event, key);

      if (this.call) {
        if (this.call.phase !== 'connected') return;
        this.#sendDtmf(key.dataset.key);
        return;
      }

      this.#append(key.dataset.key);
      this.#flashKey(key.dataset.key);
    });

    this.el.backspace.addEventListener('click', (event) => {
      this.#blurOnPointer(event, this.el.backspace);
      this.#deleteDigit();
      this.#flashControl(this.el.backspace);
    });

    this.el.clear.addEventListener('click', (event) => {
      this.#blurOnPointer(event, this.el.clear);
      this.#clearNumber();
      this.#flashControl(this.el.clear);
    });

    this.el.callBtn.addEventListener('click', (event) => {
      this.#blurOnPointer(event, this.el.callBtn);
      this.startCall();
    });
    this.el.mute.addEventListener('click', (event) => {
      this.#blurOnPointer(event, this.el.mute);
      this.toggleMute();
    });
    this.el.hold.addEventListener('click', (event) => {
      this.#blurOnPointer(event, this.el.hold);
      this.toggleHold();
    });
    this.el.hangup.addEventListener('click', (event) => {
      this.#blurOnPointer(event, this.el.hangup);
      this.hangup();
    });
    this.el.clearHistory.addEventListener('click', () => this.#onClearHistory());
  }

  /** Pointer clicks release focus so Enter keeps meaning "dial", not "press that button". */
  #blurOnPointer(event, element) {
    if (event.detail > 0) element.blur();
  }

  /**
   * Global keyboard dialing:
   *   idle      — 0-9 * # +, letters as T9, Enter dials, Backspace deletes, Esc clears
   *   connected — digits send DTMF, M mute, H hold, Enter hangs up
   */
  #onKeyDown(event) {
    if (event.defaultPrevented || event.isComposing) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!this.el.view || this.el.view.hidden) return;

    const target = event.target;
    const isButton = target?.tagName === 'BUTTON' || target?.tagName === 'A';
    if (target && target !== this.el.input) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
    }

    const { key } = event;
    const lower = key.length === 1 ? key.toLowerCase() : '';

    if (this.call) {
      if (key === 'Enter') {
        if (isButton) return;
        event.preventDefault();
        this.hangup();
        return;
      }

      if (this.call.phase !== 'connected') return;

      if (lower === 'm') {
        event.preventDefault();
        this.toggleMute();
        this.#flashControl(this.el.mute);
        return;
      }
      if (lower === 'h') {
        event.preventDefault();
        this.toggleHold();
        this.#flashControl(this.el.hold);
        return;
      }

      const dtmf = DIAL_CHARS.test(key) ? key : T9[lower];
      if (dtmf) {
        event.preventDefault();
        this.#sendDtmf(dtmf);
      }
      return;
    }

    if (!this.machine.canDial()) {
      if (key === 'Enter') event.preventDefault();
      return;
    }

    if (key === 'Enter') {
      if (isButton) return;
      event.preventDefault();
      this.startCall();
      return;
    }

    if (key === 'Escape') {
      event.preventDefault();
      this.#clearNumber();
      this.#flashControl(this.el.clear);
      return;
    }

    if (key === 'Backspace' || key === 'Delete') {
      event.preventDefault();
      this.#deleteDigit();
      this.#flashControl(this.el.backspace);
      return;
    }

    const char = DIAL_CHARS.test(key) ? key : T9[lower];
    if (!char) return;

    event.preventDefault();
    this.#append(char);
    this.#flashKey(char);
  }

  #deleteDigit() {
    if (this.el.input.disabled) return;
    this.el.input.value = this.el.input.value.slice(0, -1);
    this.#syncCallButton();
  }

  #clearNumber({ focus = false } = {}) {
    if (this.el.input.disabled) return;
    this.el.input.value = '';
    this.#syncCallButton();
    if (focus) this.el.input.focus({ preventScroll: true });
  }

  #flashKey(key) {
    this.#flashControl(this.el.keypad.querySelector(`[data-key="${key}"]`));
  }

  #flashControl(element) {
    if (!element) return;
    element.classList.add('is-pressed');
    const existing = this.keyFlashTimers.get(element);
    if (existing) window.clearTimeout(existing);
    this.keyFlashTimers.set(element, window.setTimeout(() => {
      element.classList.remove('is-pressed');
      this.keyFlashTimers.delete(element);
    }, KEY_FLASH_MS));
  }

  #sendDtmf(key) {
    this.#flashKey(key);
    this.telephony?.sendDtmf(key);

    const chip = this.el.callDtmf;
    if (!chip) return;

    chip.textContent = `DTMF ${key}`;
    chip.hidden = false;
    chip.classList.remove('is-pulsing');
    void chip.offsetWidth;
    chip.classList.add('is-pulsing');

    if (this.dtmfTimer) window.clearTimeout(this.dtmfTimer);
    this.dtmfTimer = window.setTimeout(() => {
      chip.hidden = true;
      chip.classList.remove('is-pulsing');
      this.dtmfTimer = null;
    }, DTMF_CLEAR_MS);
  }

  #hideDtmf() {
    if (this.dtmfTimer) window.clearTimeout(this.dtmfTimer);
    this.dtmfTimer = null;
    if (!this.el.callDtmf) return;
    this.el.callDtmf.hidden = true;
    this.el.callDtmf.classList.remove('is-pulsing');
  }

  #sanitizeInput() {
    const input = this.el.input;
    const cleaned = input.value.replace(/[^\d*#+]/g, '').slice(0, MAX_NUMBER_LENGTH);
    if (cleaned !== input.value) input.value = cleaned;
    this.#syncCallButton();
  }

  #append(key) {
    if (!this.machine.canDial() || this.call) return;
    if (this.el.input.value.length >= MAX_NUMBER_LENGTH) return;
    this.el.input.value += key;
    this.#syncCallButton();
  }

  #syncCallButton() {
    const hasNumber = this.el.input.value.trim().length > 0;
    this.el.callBtn.disabled = !hasNumber || !this.machine.canDial() || Boolean(this.call);
  }

  /** Re-render lock state and the contextual helper text for the current agent state. */
  syncAvailability() {
    const canDial = this.machine.canDial() && !this.call;
    const dtmfReady = this.call?.phase === 'connected';
    const status = this.machine.status;

    this.el.input.disabled = !canDial;
    this.el.keypad.querySelectorAll('button').forEach((button) => {
      button.disabled = !canDial && !dtmfReady;
    });
    this.el.backspace.disabled = !canDial;
    this.el.clear.disabled = !canDial;
    this.el.body.classList.toggle('is-locked', !canDial && status !== STATUS.ON_CALL);
    this.#syncCallButton();

    let mode = 'ready';
    let label = 'Ready';

    if (this.call) {
      mode = 'call';
      label = 'On call';
    } else if (status === STATUS.AUX) {
      mode = 'paused';
      label = 'Paused';
    } else if (status === STATUS.WRAP_UP) {
      mode = 'wrap';
      label = 'Wrap-up';
    }

    this.el.state.dataset.mode = mode;
    this.el.state.textContent = label;
    this.#renderHint();
  }

  #renderHint() {
    const status = this.machine.status;
    let hint = 'Type a number or use the keypad — Enter dials.';
    if (this.call) {
      hint = this.call.phase === 'connected'
        ? 'M mutes · H holds · Enter hangs up. Keys send DTMF.'
        : 'Ringing… press Enter to cancel the call.';
    } else if (status === STATUS.AUX) {
      const reason = this.machine.auxLabel();
      hint = `Dialing paused${reason ? ` — ${reason}` : ''}. Return to Available to dial.`;
    } else if (status === STATUS.WRAP_UP) {
      hint = `Wrap-up in progress — available in ${formatDuration(this.machine.wrapUpRemaining())}.`;
    }
    this.el.hint.textContent = hint;
  }

  startCall() {
    if (this.call) return;
    if (!this.telephony) {
      this.notify('Telnyx is not connected. Sign in again.', 'warn');
      return;
    }
    if (!this.machine.canDial()) {
      this.notify('Dialing is paused. Return to Available first.', 'warn');
      return;
    }

    const number = this.el.input.value.trim();
    if (!number) {
      this.notify('Enter a phone number first.', 'warn');
      this.el.input.focus({ preventScroll: true });
      return;
    }

    if (!this.machine.beginCall()) return;

    this.call = {
      number,
      startedAt: Date.now(),
      connectedAt: null,
      phase: 'ringing',
      muted: false,
      held: false,
      heldUsed: false,
    };

    this.#renderCall();
    this.syncAvailability();
    this.notify(`Calling ${number}…`);

    try {
      this.telephony.call(number);
    } catch (error) {
      this.#finishCall('failed', error?.message || 'Could not place the call.');
    }
  }

  #onTelephonyEvent(event) {
    if (!event) return;

    switch (event.type) {
      case 'ringing':
        if (this.call) this.#renderCall();
        break;
      case 'connected':
        if (!this.call || this.call.phase === 'connected') return;
        this.call.phase = 'connected';
        this.call.connectedAt = Date.now();
        this.#renderCall();
        this.syncAvailability();
        this.notify('Call connected.');
        break;
      case 'held':
        if (!this.call) return;
        this.call.held = Boolean(event.held);
        this.#renderCall();
        break;
      case 'ended':
        this.#finishCall(event.cause || 'NORMAL_CLEARING');
        break;
      case 'error':
        this.notify(event.message || 'Telnyx error.', 'error');
        break;
      default:
        break;
    }
  }

  #finishCall(cause = 'NORMAL_CLEARING', message = '') {
    if (!this.call) return;

    if (this.endTimer) window.clearTimeout(this.endTimer);
    this.endTimer = null;

    const call = this.call;
    const now = Date.now();
    const connected = call.phase === 'connected';
    const durationSec = connected ? Math.max(0, Math.floor((now - call.connectedAt) / 1000)) : 0;
    let status = 'No Answer';
    if (connected) status = call.heldUsed ? 'Handled' : 'Completed';
    else if (cause === 'failed') status = 'Failed';

    this.#recordCall({
      number: call.number,
      startedAt: call.startedAt,
      durationSec,
      status,
    });

    this.#clearCallState();
    this.machine.endCall();
    this.syncAvailability();
    const suffix = message ? ` — ${message}` : '';
    this.notify(`Call ended — ${status.toLowerCase()}${suffix}.`);
  }

  toggleMute() {
    if (!this.call || this.call.phase !== 'connected') return;
    this.call.muted = !this.call.muted;
    this.telephony?.setMuted(this.call.muted);
    this.#renderCall();
    this.notify(this.call.muted ? 'Microphone muted.' : 'Microphone live.');
  }

  toggleHold() {
    if (!this.call || this.call.phase !== 'connected') return;
    this.call.held = !this.call.held;
    if (this.call.held) this.call.heldUsed = true;
    this.telephony?.setHeld(this.call.held);
    this.#renderCall();
    this.notify(this.call.held ? 'Call on hold.' : 'Call resumed.');
  }

  hangup() {
    if (!this.call) return;

    try {
      this.telephony?.hangup();
    } catch {
      /* Ignore signalling races. */
    }
    if (this.endTimer) window.clearTimeout(this.endTimer);
    this.endTimer = window.setTimeout(() => {
      this.endTimer = null;
      this.#finishCall('NORMAL_CLEARING');
    }, 2500);
  }

  /** Used by logout. Cancels the active call without writing history. */
  abortActiveCall() {
    if (this.endTimer) window.clearTimeout(this.endTimer);
    this.endTimer = null;
    try {
      this.telephony?.hangup();
    } catch {
      /* Ignore signalling races. */
    }
    this.call = null;
    if (this.el.callPanel) this.el.callPanel.hidden = true;
    this.#hideDtmf();
    this.#resetCallControls();
    this.syncAvailability();
  }

  #clearCallState() {
    if (this.endTimer) window.clearTimeout(this.endTimer);
    this.endTimer = null;
    this.call = null;
    this.el.callPanel.hidden = true;
    this.el.callPanel.classList.remove('is-ringing', 'is-held', 'is-connected');
    this.#hideDtmf();
    this.#resetCallControls();
  }

  #resetCallControls() {
    this.el.mute.disabled = true;
    this.el.hold.disabled = true;
    this.el.mute.setAttribute('aria-pressed', 'false');
    this.el.hold.setAttribute('aria-pressed', 'false');
    this.el.muteLabel.textContent = 'Mute';
    this.el.holdLabel.textContent = 'Hold';
  }

  #renderCall() {
    const call = this.call;
    if (!call || !this.el.callPanel) return;

    const ringing = call.phase === 'ringing';
    const held = call.held;

    this.el.callPanel.hidden = false;
    this.el.callPanel.classList.toggle('is-ringing', ringing);
    this.el.callPanel.classList.toggle('is-connected', !ringing);
    this.el.callPanel.classList.toggle('is-held', held);
    this.el.callNumber.textContent = call.number;
    this.el.callState.textContent = ringing ? 'Ringing…' : held ? 'On hold' : 'Connected';
    this.el.callTimer.textContent = ringing ? '00:00' : formatDuration(Date.now() - call.connectedAt);

    this.el.mute.disabled = ringing;
    this.el.hold.disabled = ringing;
    this.#hideDtmf();
    this.el.mute.setAttribute('aria-pressed', String(call.muted));
    this.el.hold.setAttribute('aria-pressed', String(held));
    this.el.mute.classList.toggle('is-active', call.muted);
    this.el.hold.classList.toggle('is-active', held);
    this.el.muteLabel.textContent = call.muted ? 'Muted' : 'Mute';
    this.el.holdLabel.textContent = held ? 'Resume' : 'Hold';
  }

  /** Called from the app's shared timer loop. */
  tick() {
    if (this.call && this.call.phase === 'connected') {
      this.el.callTimer.textContent = formatDuration(Date.now() - this.call.connectedAt);
    }
    if (this.machine.status === STATUS.WRAP_UP) {
      this.#renderHint();
    }
  }

  #recordCall(entry) {
    this.history.unshift({
      id: makeId(),
      number: entry.number,
      startedAt: entry.startedAt,
      durationSec: entry.durationSec,
      status: entry.status,
    });
    this.history = this.history.slice(0, MAX_HISTORY);
    persistHistory(this.history);
    this.renderHistory();
  }

  renderHistory() {
    const body = this.el.historyBody;
    body.replaceChildren();

    for (const entry of this.history) {
      const row = document.createElement('tr');

      const numberCell = document.createElement('td');
      numberCell.dataset.label = 'Number';
      const numberButton = node('button', 'history-number', entry.number);
      numberButton.type = 'button';
      numberButton.title = `Load ${entry.number} into the dialer`;
      numberButton.setAttribute('aria-label', `Load ${entry.number} into the dialer`);
      numberButton.addEventListener('click', () => this.#loadNumber(entry.number));
      numberCell.appendChild(numberButton);

      const startCell = document.createElement('td');
      startCell.dataset.label = 'Start';
      const started = new Date(entry.startedAt);
      startCell.append(
        node('span', 'history-time', timeFormat.format(started)),
        node('span', 'history-date', dateFormat.format(started)),
      );

      const durationCell = document.createElement('td');
      durationCell.dataset.label = 'Duration';
      durationCell.className = 'history-duration';
      durationCell.textContent = formatDuration(Math.max(0, entry.durationSec) * 1000);

      const statusCell = document.createElement('td');
      statusCell.dataset.label = 'Status';
      const pillClass = entry.status.toLowerCase().replace(/[^a-z]+/g, '-');
      statusCell.appendChild(node('span', `status-pill is-${pillClass}`, entry.status));

      row.append(numberCell, startCell, durationCell, statusCell);
      body.appendChild(row);
    }

    const count = this.history.length;
    this.el.historyCount.textContent = String(count);
    this.el.historyEmpty.hidden = count > 0;
    this.el.clearHistory.disabled = count === 0;
    if (count === 0) this.#resetClearButton();
  }

  #loadNumber(number) {
    this.el.input.value = number;
    this.#syncCallButton();
    if (this.machine.canDial()) {
      this.el.input.focus({ preventScroll: true });
      this.notify(`${number} loaded into the dialer.`);
    } else if (this.machine.status === STATUS.AUX) {
      this.notify(`${number} loaded — dialing is paused (${this.machine.auxLabel()}).`, 'warn');
    } else {
      this.notify(`${number} loaded. Dialing unlocks when you are available.`, 'warn');
    }
  }

  #onClearHistory() {
    if (this.history.length === 0) return;

    if (!this.confirmClear) {
      this.confirmClear = true;
      this.el.clearHistory.textContent = 'Confirm?';
      this.el.clearHistory.classList.add('is-confirm');
      this.confirmClearTimer = window.setTimeout(() => this.#resetClearButton(), 3000);
      return;
    }

    this.clearHistory();
    this.notify('Call history cleared.');
  }

  #resetClearButton() {
    if (this.confirmClearTimer) window.clearTimeout(this.confirmClearTimer);
    this.confirmClearTimer = null;
    this.confirmClear = false;
    this.el.clearHistory.textContent = 'Clear';
    this.el.clearHistory.classList.remove('is-confirm');
  }

  clearHistory({ notify = false } = {}) {
    this.history = [];
    removeHistory();
    this.#resetClearButton();
    this.renderHistory();
    if (notify) this.notify('Call history cleared.');
  }
}
