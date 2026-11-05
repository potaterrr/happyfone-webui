# HappyFone WebUI

A production-style, dependency-free agent console for an outbound call center. Built with vanilla HTML, CSS, and ES modules for GitHub Pages.

**Live:** https://potaterrr.github.io/happyfone-webui/

The console has two telephony modes:

- **Simulation** — the original demo. Any non-empty credentials sign you in, and calls are simulated end to end.
- **Telnyx test** — the browser registers directly with a Telnyx SIP Credential Connection and places real outbound calls. This is a test-only path; production should use the JWT + Kamailio/RTPEngine gateway described below.

## Features

- **Two telephony modes** — pick Simulation or Telnyx test on the sign-in screen.
- **Mock auth and session guard (Simulation)** — username, extension, and password. A dummy JWT and user profile are stored in `localStorage`. Direct visits to the dashboard without a valid session redirect to sign-in.
- **Telnyx test calls** — enter a Telnyx SIP username and password, register over WebRTC, and place real outbound calls. Mute, hold/resume, DTMF, and hangup drive the Telnyx SDK.
- **Agent state machine** — `AVAILABLE`, `ON_CALL`, `WRAP_UP`, and `AUX`, with a live timer for the current state.
- **AUX pauses** — Lunch, Short Break, Bio Break, Coaching, and Training. Selecting any AUX reason pauses the dialer; returning to Available unlocks it.
- **Call lifecycle** — ringing, connected timer, mute, hold/resume, and hangup. In Simulation mode the ring lasts 3 seconds; in Telnyx mode it follows the real call.
- **Keyboard dialing** — type digits from anywhere on the console, letters map through T9 (so `1-800-FLOWERS` dials `18003569377`), `Enter` dials or hangs up, `Backspace` deletes, `Esc` clears, and `M` / `H` mute and hold during a call. Digits sent while connected display as DTMF tones.
- **Wrap-up** — hanging up starts a 5-second wrap-up countdown before the agent returns to Available.
- **Persistent call history** — number, start time, duration, and status (`Completed`, `Handled`, `No Answer`, `Failed`). Entries survive reloads, support click-to-dial, and can be cleared.
- **Responsive dark UI** — JetBrains Mono typography, CSS variables, accessible focus states, and reduced-motion support.

## Routes

GitHub Pages is a static host, so this app uses hash routing. Every route works on refresh and direct access without a 404 fallback.

| View | URL |
| --- | --- |
| Login | `https://potaterrr.github.io/happyfone-webui/#/login-webui` |
| Dashboard | `https://potaterrr.github.io/happyfone-webui/#/dashboard` |

The bare project URL and `#/login-webui` always open the sign-in screen; signing in moves you to the dashboard. `#/dashboard` falls back to sign-in when there is no valid session.

## Simulation mode

Authentication is intentionally mocked. Any non-empty username, extension, and password will sign you in. No credentials leave the browser and no real calls are placed.

## Telnyx test mode

Telnyx test mode connects the browser directly to a Telnyx **SIP Credential Connection** using the [Telnyx WebRTC JS SDK](https://developers.telnyx.com/docs/development/webrtc/js-sdk). It is intended for outbound testing only.

### Telnyx portal checklist

1. Buy a number under **Numbers → Buy Numbers**.
2. Create a **SIP Credential Connection** under **Call Connections → Create → SIP Credential Connection**.
3. Create a **Telephony Credential** under **Call Connections → [Your Connection] → Credentials → Create**. Note the SIP username and password.
4. Assign your number to that connection under **Numbers → Your Numbers**.
5. Create an **Outbound Voice Profile** and assign it to the connection.
6. Make sure the account has a positive balance and the destination country is allowed.

### Testing

1. Open the live URL in Chrome or Edge.
2. Select **Telnyx test**.
3. Enter the SIP username, an agent extension (display only), and the SIP password.
4. Wait for **"Connected to Telnyx. Ready for test calls."**
5. Dial an E.164 number and verify ringing, two-way audio, mute, hold/resume, DTMF, and hangup.

### Security notes

- **Test only.** The SIP password is held in memory for the tab and is never written to `localStorage`, `sessionStorage`, or the repository. Refreshing the page requires signing in again.
- Use one browser tab per SIP credential. Sharing a credential causes registration conflicts.
- Do not use this direct-browser path in production. The production design keeps SIP credentials on the server: the login form posts to an auth service, the service returns an ephemeral JWT, and the browser connects to a Kamailio/RTPEngine gateway that routes to the Telnyx SIP trunk.
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

## Local development

Because the app uses ES modules, serve the folder over HTTP rather than opening `index.html` directly:

```bash
cd happyfone-webui
python3 -m http.server 8080
# open http://localhost:8080/
```

## File structure

```
index.html          Markup for both views
css/styles.css      Theme, layout, components, responsive rules
js/app.js           Hash router, auth/session, mode switching, boot
js/dialer.js        Keypad, call lifecycle, history storage
js/telephony.js     Telnyx WebRTC test-mode adapter
js/aux.js           AUX state machine, reasons, time helpers
```

## Implementation notes

- Call durations are computed from timestamps, so timers stay accurate if the tab is throttled.
- Calls that use Hold are logged as `Handled`; connected calls without hold are `Completed`; calls ended while ringing are `No Answer`; SDK failures are `Failed`.
- Logout disconnects the Telnyx client, cancels any active call, clears the `happyfone.*` storage keys, and returns to sign-in.
- Simulation mode only requests the Google Fonts stylesheet. Telnyx test mode additionally loads the pinned `@telnyx/webrtc` SDK from jsDelivr on first connect.

## Deployment

This repository is the standalone source of truth for the HappyFone WebUI. Pushes to `main` deploy the repository root through GitHub Pages using `.github/workflows/pages.yml`.

The public project card lives in the `potaterrr.github.io` repository under `/projects/happyfone-webui/` and links to this deployment.
