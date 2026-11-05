/**
 * Telnyx SIP credentials used by the sign-in form when a field is left blank.
 *
 * These are Telnyx **SIP credentials** (SIP username + SIP password), not a
 * Telnyx API key: the browser WebRTC SDK cannot use an API key. Leave them
 * blank to require agents to enter their own credentials at sign-in.
 *
 * Anything placed here ships to every browser, so treat it as public. Prefer a
 * server-side JWT/token flow for real production deployments.
 *
 * This file must stay committed and served, because index.html loads it.
 */
export const TELNYX_CONFIG = {
  username: '',
  extension: '',
  password: '',
};
