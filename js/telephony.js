/**
 * telephony.js — Telnyx WebRTC adapter.
 *
 * The browser registers directly with a Telnyx SIP Credential Connection.
 * For real production, prefer a server-side JWT/token flow so SIP credentials
 * never reach the browser.
 *
 * The SDK is loaded lazily on first connect.
 */

const TELNYX_SDK_URL = 'https://cdn.jsdelivr.net/npm/@telnyx/webrtc@2.28.2/lib/bundle.mjs';
const CONNECT_TIMEOUT_MS = 15000;

export class TelnyxTelephony {
  constructor({ onEvent } = {}) {
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.client = null;
    this.call = null;
    this.ready = false;
  }

  get isLive() {
    return true;
  }

  async connect({ login, password } = {}) {
    if (!login || !password) {
      throw new Error('Enter your Telnyx SIP username and password.');
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot access the microphone.');
    }

    /* Ask for the microphone up front so permission errors surface before we
       register, instead of halfway through the first call. */
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      throw new Error('Microphone access was blocked. Allow it in the browser and try again.');
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }

    let TelnyxRTC;
    try {
      const sdk = await import(TELNYX_SDK_URL);
      TelnyxRTC = sdk.TelnyxRTC;
    } catch {
      throw new Error('Could not load the Telnyx WebRTC SDK. Check your connection and try again.');
    }

    if (typeof TelnyxRTC !== 'function') {
      throw new Error('The Telnyx WebRTC SDK did not initialise.');
    }

    this.client = new TelnyxRTC({ login, password });
    this.client.remoteElement = 'remoteMedia';

    await new Promise((resolve, reject) => {
      let settled = false;

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        callback(value);
      };

      const timer = window.setTimeout(() => {
        finish(reject, new Error('Timed out connecting to Telnyx. Check the SIP credentials and try again.'));
      }, CONNECT_TIMEOUT_MS);

      this.client.on('telnyx.ready', () => finish(resolve));
      this.client.on('telnyx.error', (error) => {
        const message = error?.message
          || (error?.code ? `Telnyx error ${error.code}` : '')
          || (typeof error === 'string' ? error : '')
          || 'Telnyx rejected the connection.';
        if (!this.ready) {
          finish(reject, new Error(String(message)));
          return;
        }
        this.onEvent({ type: 'error', message: String(message) });
      });

      this.client.on('telnyx.notification', (notification) => this.#handleNotification(notification));
      this.client.connect();
    });

    this.ready = true;
    return { mode: 'telnyx' };
  }

  #handleNotification(notification) {
    if (notification?.type !== 'callUpdate' || !notification.call) return;

    const call = notification.call;

    /* Outbound-only: ignore a second, unrelated call. */
    if (this.call && call.id && this.call.id && call.id !== this.call.id) return;
    this.call = call;

    switch (call.state) {
      case 'ringing':
      case 'early':
        this.onEvent({ type: 'ringing' });
        break;
      case 'active':
        this.onEvent({ type: 'connected' });
        break;
      case 'held':
        this.onEvent({ type: 'held', held: true });
        break;
      case 'hangup':
      case 'destroy':
      case 'purge':
        this.onEvent({ type: 'ended', cause: call.cause || 'NORMAL_CLEARING' });
        this.call = null;
        break;
      default:
        break;
    }
  }

  call(number) {
    if (!this.client || !this.ready) {
      throw new Error('Telnyx is not connected.');
    }
    this.call = this.client.newCall({ destinationNumber: number, audio: true });
    this.onEvent({ type: 'dialing', number });
  }

  hangup() {
    if (!this.call) return;
    try {
      this.call.hangup();
    } catch {
      /* The call may already be gone. */
    }
  }

  setMuted(muted) {
    if (!this.call) return;
    try {
      if (muted) this.call.muteAudio();
      else this.call.unmuteAudio();
    } catch {
      /* Ignore media-control races. */
    }
  }

  setHeld(held) {
    if (!this.call) return;
    try {
      if (held) this.call.hold();
      else this.call.unhold();
    } catch {
      /* Ignore signalling races. */
    }
  }

  sendDtmf(digit) {
    if (!this.call) return;
    try {
      this.call.dtmf(digit);
    } catch {
      /* Ignore DTMF races. */
    }
  }

  async disconnect() {
    this.ready = false;
    this.call = null;
    if (this.client) {
      try {
        this.client.disconnect();
      } catch {
        /* Already disconnected. */
      }
      this.client = null;
    }
  }
}
