# HappyPhone WebUI

A production, dependency-free agent console for Telnyx WebRTC outbound calling. Built with vanilla HTML, CSS, and ES modules for static hosting.

**Live:** https://potaterrr.github.io/happyfone-webui/

The console connects directly to a Telnyx **SIP Credential Connection** from the browser and places real outbound calls. Signing in registers a live Telnyx WebRTC client.

## Features

- **Telnyx-only sign-in** — SIP username, agent extension, and SIP password. All three are required, and the extension is used for the agent header.
- **Microphone preflight** — an **Enable microphone** button requests access before sign-in. Sign-in is blocked until the microphone is available, so the first Telnyx call does not fail on a missing permission.
- **Live Telnyx calls** — register over WebRTC and place real outbound calls. Mute, hold/resume, DTMF, and hangup drive the Telnyx SDK.
- **Agent state machine** — `AVAILABLE`, `ON_CALL`, `WRAP_UP`, and `AUX`, with a live timer for the current state.
- **AUX pauses** — Lunch, Short Break, Bio Break, Coaching, and Training. Selecting any AUX reason pauses the dialer; returning to Available unlocks it.
- **Call lifecycle** — ringing, connected timer, mute, hold/resume, and hangup, driven by real Telnyx call events.
- **Keyboard dialing** — type digits from anywhere on the console, letters map through T9 (so `1-800-FLOWERS` dials `18003569377`), `Enter` dials or hangs up, `Backspace` deletes, `Esc` clears, and `M` / `H` mute and hold during a call. Digits sent while connected display as DTMF tones.
- **Wrap-up** — hanging up starts a 5-second wrap-up countdown before the agent returns to Available.
- **Persistent call history** — number, start time, duration, and status (`Completed`, `Handled`, `No Answer`, `Failed`). Entries survive reloads, support click-to-dial, and can be cleared.
- **In-memory session** — the SIP password and login live only in the current tab. A page refresh returns to sign-in.
- **Password change page** — `#/password-change` posts the agent's current and new password to a configurable server endpoint and never stores either password in browser storage.
- **Automatic light and dark themes** — follows the OS/browser `prefers-color-scheme` setting. No toggle is needed, and dark remains the default for dark systems.
- **Responsive dark UI** — JetBrains Mono typography, CSS variables, accessible focus states, and reduced-motion support.

## Sign-in

The sign-in card asks for three values, in this order:

| Field | Purpose |
| --- | --- |
| **SIP username** | Telnyx telephony credential username (for example `gencred…`). |
| **Agent extension** | Display extension shown in the console header (for example `2041`). It is not sent to Telnyx. |
| **SIP password** | Telnyx telephony credential password. |

All three must be present. The username and extension can be pre-filled from `js/config.js`; the password field is always left blank.

The card also has a **Microphone** row. Use **Enable microphone** to grant access up front; the tracks are stopped immediately after the permission check. Sign-in requires microphone access, so a blocked or missing microphone stops the flow before Telnyx registration.

**Microphone access requires HTTPS** (or `http://localhost` for local development). Browsers do not expose `getUserMedia` on plain HTTP origins.

## One phone number, many agents

Model B uses one Telnyx **SIP Credential Connection** and one phone number, with a separate **Telephony Credential** for each agent or device. Multiple telephony credentials can share the same connection and the same outbound caller ID.

- Every agent sees the same outbound number, because the caller ID belongs to the connection and phone number — not to the credential.
- A telephony credential is a SIP identity, not a phone number.
- Inbound routing is connection-level, not per-agent. This console handles outbound calls only.
- Telnyx recommends one telephony credential per device. Do not share a single credential across multiple tabs or devices; registration conflicts break calls.

## Password change

The dashboard has a **Password** link that opens `#/password-change`. The page shows the signed-in SIP username and extension, then posts:

```json
{
  "username": "sip-username",
  "extension": "2041",
  "currentPassword": "current-password",
  "newPassword": "new-password"
}
```

to `TELNYX_CONFIG.passwordChangeEndpoint`. The default is `/caller/console/api/password`. The endpoint is configurable; if it is blank, the app falls back to an app-relative `api/password` path.

The page is included and ready, but **actual password changes require Dave's backend endpoint**. If the server returns 404, 405, 501, or is unreachable, the page says password change is not enabled and never claims success.

On a successful `{ "ok": true }` response, the app disconnects Telnyx, clears the in-memory session, and returns to sign-in. If the response is `{ "ok": true, "username": "...", "password": "..." }`, the new SIP credentials are shown once with a copy button before re-login. Neither password is written to `localStorage` or `sessionStorage`.

### Telnyx password limitation

The Telnyx Telephony Credential PATCH endpoint only updates `name`, `tag`, `connection_id`, and `expires_at`. It **cannot change `sip_password` or `sip_username`**. The password-change page does not pretend it can PATCH a Telnyx password.

Backend options:

- **A. App-level extension passwords + short-lived JWTs (recommended).** The backend owns agent passwords, verifies the current password, stores the new one, and mints a short-lived Telnyx JWT for sign-in. Password changes work without touching Telnyx.
- **B. Delete and recreate the Telnyx telephony credential.** This issues a new SIP username and password, so it is disruptive and must be coordinated with the agent. It is the only way to change a Telnyx SIP password directly.

## Configuration

`js/config.js` holds optional defaults:

```js
export const TELNYX_CONFIG = {
  username: '',
  extension: '',
  password: '',
  passwordChangeEndpoint: '/caller/console/api/password',
};
```

- These are **Telnyx SIP credentials**, not a Telnyx API key. The browser WebRTC SDK cannot use an API key.
- Leave the values blank to require every agent to type their own credentials. The committed file must contain empty strings — never put real credentials in it.
- `passwordChangeEndpoint` defaults to `/caller/console/api/password`. Set it to your backend URL, or leave it blank to use the app-relative `api/password` path.
- Because this file is served to the browser, any value in it is public. Prefer a server-side JWT/token flow for real production.
- Do not add `js/config.js` to `.gitignore`; `index.html` and `js/app.js` load it in production.

## Routes

GitHub Pages is a static host, so this app uses hash routing. Every route works on refresh and direct access without a 404 fallback.

| View | URL |
| --- | --- |
| Login | `https://potaterrr.github.io/happyfone-webui/#/login-webui` |
| Dashboard | `https://potaterrr.github.io/happyfone-webui/#/dashboard` |
| Change password | `https://potaterrr.github.io/happyfone-webui/#/password-change` |

The bare project URL and `#/login-webui` always open the sign-in screen; signing in moves you to the dashboard. `#/dashboard` and `#/password-change` fall back to sign-in when there is no live session.

Pretty URLs are also supported for the password page when the server maps the path to `index.html`:

```nginx
location = /caller/console/password-change { return 302 /caller/console/#/password-change; }
location = /caller/password-change { return 302 /caller/#/password-change; }
```

## Telnyx portal checklist

1. Buy a number under **Numbers → Buy Numbers**.
2. Create a **SIP Credential Connection** under **Call Connections → Create → SIP Credential Connection**.
3. Create a **Telephony Credential** under **Call Connections → [Your Connection] → Credentials → Create**. Note the SIP username and password.
4. Assign your number to that connection under **Numbers → Your Numbers**.
5. Create an **Outbound Voice Profile** and assign it to the connection.
6. Make sure the account has a positive balance and the destination country is allowed.

## Local development

Because the app uses ES modules, serve the folder over HTTP rather than opening `index.html` directly:

```bash
cd happyfone-webui
python3 -m http.server 8080
# open http://localhost:8080/
```

Then sign in with a Telnyx SIP username, an agent extension, and the SIP password.

## Static deployment

The site is plain static files. Upload the contents of the ZIP (or this repository root, excluding `.git`) into any web root. No build step is needed.

For nginx, a minimal server block is provided in `deploy/nginx.conf`. See `DEPLOY.md` for the short version.

**HTTPS is required for microphone access.** Browsers only grant `getUserMedia` on secure origins, so use HTTPS in production (or `http://localhost` for local testing). Put Cloudflare, Caddy, or a TLS-terminating proxy in front of nginx if you do not manage certificates directly.

## Security notes

- **Browser SIP credentials are public.** Any credential typed into a static web app is visible to the user and can be replayed. Treat this direct-browser mode as suitable for trusted agents only.
- **Prefer a server/JWT token flow for real production.** Keep SIP credentials on the server: the sign-in form posts to an auth service, the service returns an ephemeral JWT, and the browser connects to a media gateway that routes to Telnyx. That removes SIP passwords from the browser entirely.
- Credentials are held in memory for the tab only and are never written to `localStorage`, `sessionStorage`, or the repository.
- The password-change form sends the current and new passwords only to the configured endpoint. It does not log, persist, or toast them.
- Use one browser tab per SIP credential. Sharing a credential causes registration conflicts.
- Inbound calls are not handled. They need Telnyx webhooks and a backend to route the call to the browser.

## Keyboard controls

The dialer listens for keys whenever the console is open. It ignores input fields, selects, and modifier shortcuts, so it never interferes with the login form or browser commands.

| Key | Idle | On a connected call |
| --- | --- | --- |
| `0`–`9`, `*`, `#`, `+` | Append to the number | Send a DTMF tone |
| `A`–`Z` | Append the matching T9 digit | `M` mutes, `H` holds |
| `Enter` | Dial | Hang up |
| `Backspace` / `Delete` | Delete the last digit | — |
| `Esc` | Clear the number | — |

On-screen keys flash when their keyboard equivalent is pressed, and touch devices hide the keyboard legend.

## File structure

```
index.html          Markup for both views
css/styles.css      Theme, layout, components, responsive rules
js/app.js           Hash router, Telnyx session guard, password change, boot
js/config.js        Optional Telnyx SIP defaults (blank by default)
js/dialer.js        Keypad, call lifecycle, history storage
js/telephony.js     Telnyx WebRTC adapter
js/aux.js           AUX state machine, reasons, time helpers
DEPLOY.md           Minimal static deployment guide
deploy/nginx.conf   Starter nginx server block
```

## Implementation notes

- Call durations are computed from timestamps, so timers stay accurate if the tab is throttled.
- Calls that use Hold are logged as `Handled`; connected calls without hold are `Completed`; calls ended while ringing are `No Answer`; SDK failures are `Failed`.
- Logout disconnects the Telnyx client, cancels any active call, clears call history, and returns to sign-in.
- A successful password change disconnects Telnyx, clears the in-memory session, and returns to sign-in. New SIP credentials returned by the endpoint are shown once and never stored.
- The pinned `@telnyx/webrtc` SDK is loaded from jsDelivr on first connect.
- The session is intentionally memory-only: refreshing the page signs the agent out and requires the SIP password again.

## Deployment

This repository is the standalone source of truth for the HappyPhone WebUI. Pushes to `main` deploy the repository root through GitHub Pages.

For Dave's deployment to https://happyphone.lol/caller/, see [instructions.txt](instructions.txt).

The public project card lives in the `potaterrr.github.io` repository under `/projects/happyfone-webui/` and links to this deployment.
