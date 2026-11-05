/**
 * aux.js — agent status state machine, AUX reasons, and shared time helpers.
 *
 * States: AVAILABLE → ON_CALL → WRAP_UP → AVAILABLE
 *         AVAILABLE ↔ AUX (while idle)
 */

export const STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  ON_CALL: 'ON_CALL',
  WRAP_UP: 'WRAP_UP',
  AUX: 'AUX',
});

export const WRAP_UP_MS = 5000;

export const AUX_REASONS = Object.freeze({
  lunch: { label: 'Lunch' },
  'short-break': { label: 'Short Break' },
  'bio-break': { label: 'Bio Break' },
  coaching: { label: 'Coaching' },
  training: { label: 'Training' },
});

const pad = (value) => String(value).padStart(2, '0');

/** HH:MM:SS — used for the live state timer. */
export function formatStateTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/** MM:SS (or HH:MM:SS for long calls) — used for call duration. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

export class AgentState {
  #listeners = new Set();

  constructor() {
    this.status = STATUS.AVAILABLE;
    this.since = Date.now();
    this.auxReason = null;
    this.wrapUpUntil = null;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    listener(this);
    return () => this.#listeners.delete(listener);
  }

  #emit() {
    for (const listener of this.#listeners) listener(this);
  }

  reset() {
    this.status = STATUS.AVAILABLE;
    this.since = Date.now();
    this.auxReason = null;
    this.wrapUpUntil = null;
    this.#emit();
  }

  canDial() {
    return this.status === STATUS.AVAILABLE;
  }

  isAux() {
    return this.status === STATUS.AUX;
  }

  auxLabel() {
    if (this.status !== STATUS.AUX || !this.auxReason) return '';
    return AUX_REASONS[this.auxReason]?.label ?? '';
  }

  setAvailable() {
    if (this.status === STATUS.ON_CALL) return false;
    this.status = STATUS.AVAILABLE;
    this.since = Date.now();
    this.auxReason = null;
    this.wrapUpUntil = null;
    this.#emit();
    return true;
  }

  setAux(reason) {
    if (!AUX_REASONS[reason]) return false;
    if (this.status === STATUS.ON_CALL || this.status === STATUS.WRAP_UP) return false;
    if (this.status !== STATUS.AUX) {
      this.since = Date.now();
    }
    this.status = STATUS.AUX;
    this.auxReason = reason;
    this.wrapUpUntil = null;
    this.#emit();
    return true;
  }

  beginCall() {
    if (this.status !== STATUS.AVAILABLE) return false;
    this.status = STATUS.ON_CALL;
    this.since = Date.now();
    this.auxReason = null;
    this.wrapUpUntil = null;
    this.#emit();
    return true;
  }

  endCall() {
    if (this.status !== STATUS.ON_CALL) return false;
    this.status = STATUS.WRAP_UP;
    this.since = Date.now();
    this.wrapUpUntil = Date.now() + WRAP_UP_MS;
    this.#emit();
    return true;
  }

  /** Call frequently; transitions WRAP_UP → AVAILABLE when the timer elapses. */
  tick(now = Date.now()) {
    if (this.status === STATUS.WRAP_UP && this.wrapUpUntil !== null && now >= this.wrapUpUntil) {
      this.setAvailable();
    }
  }

  elapsed(now = Date.now()) {
    return Math.max(0, now - this.since);
  }

  wrapUpRemaining(now = Date.now()) {
    if (this.status !== STATUS.WRAP_UP || this.wrapUpUntil === null) return 0;
    return Math.max(0, this.wrapUpUntil - now);
  }
}

/** Wires the AUX <select> to the state machine. Returns a manual sync function. */
export function bindAuxSelect(select, machine, { notify } = {}) {
  const sync = () => {
    const locked = machine.status === STATUS.ON_CALL || machine.status === STATUS.WRAP_UP;
    select.disabled = locked;
    select.value = machine.status === STATUS.AUX && machine.auxReason ? machine.auxReason : 'available';
    select.closest('.aux-picker')?.classList.toggle('is-locked', locked);
  };

  select.addEventListener('change', () => {
    if (select.value === 'available') {
      if (!machine.setAvailable() && notify) notify('Finish the call first.', 'warn');
    } else if (!machine.setAux(select.value) && notify) {
      notify('AUX is unavailable while on a call.', 'warn');
    }
    sync();
  });

  machine.subscribe(sync);
  return sync;
}
