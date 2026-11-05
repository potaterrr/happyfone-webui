# Deploying HappyPhone WebUI

HappyPhone WebUI is a static site: there is no build step and no server-side runtime. You upload files to a web root and serve them over HTTPS.

For the happyphone.lol/caller deployment checklist and server commands, see `instructions.txt`.

## 1. Unzip into the web root

The ZIP has `index.html` at its root, alongside `css/`, `js/`, `deploy/`, `README.md`, and `DEPLOY.md`.

```bash
sudo mkdir -p /var/www/happyphone
sudo unzip happyphone-webui.zip -d /var/www/happyphone
sudo chown -R www-data:www-data /var/www/happyphone
```

Expected layout:

```
/var/www/happyphone/
├── index.html
├── css/styles.css
├── js/app.js
├── js/config.js
├── js/dialer.js
├── js/telephony.js
├── js/aux.js
└── deploy/nginx.conf
```

## 2. Point nginx at it

Copy or adapt `deploy/nginx.conf`:

```bash
sudo cp /var/www/happyphone/deploy/nginx.conf /etc/nginx/sites-available/happyphone
sudo ln -s /etc/nginx/sites-available/happyphone /etc/nginx/sites-enabled/happyphone
sudo nginx -t
sudo systemctl reload nginx
```

The provided block listens on port 80, serves `/var/www/happyphone`, uses `try_files` for hash routes, and adds basic security headers. It contains no TLS certificate paths, so it is safe to enable before certificates exist.

If the console is mounted under `/caller/console/`, add the pretty-URL redirects:

```nginx
location = /caller/console/password-change { return 302 /caller/console/#/password-change; }
```

If it is deployed at `/caller/` instead, use:

```nginx
location = /caller/password-change { return 302 /caller/#/password-change; }
```

## 3. Enable HTTPS

Microphone access requires a secure origin. Browsers only allow `getUserMedia` over HTTPS (or `http://localhost`).

Pick one:

- **Cloudflare** — proxy the DNS record with "Full (strict)" SSL and let Cloudflare terminate TLS.
- **Caddy** — put Caddy in front of nginx and let it obtain certificates automatically.
- **certbot** — run `sudo certbot --nginx -d your.domain` and let it add the TLS listener.

After HTTPS works, confirm the page loads at `https://your.domain/` and the browser prompts for microphone access when you click **Enable microphone** on the sign-in card (or when you sign in).

## 4. Optional: set config defaults

`js/config.js` can pre-fill the SIP username and agent extension:

```js
export const TELNYX_CONFIG = {
  username: '',
  extension: '',
  password: '',
  passwordChangeEndpoint: '/caller/console/api/password',
};
```

- Use Telnyx **SIP credentials**, not an API key.
- Leave the values blank to require every agent to enter their own credentials.
- Anything in this file is served to every visitor. Do not store real secrets there; prefer a server/JWT token flow for production.

## 5. One phone number, many agents

Use one Telnyx **SIP Credential Connection** and one phone number, with a separate **Telephony Credential** for each agent or device. Multiple credentials share the connection and the same outbound caller ID.

- The outbound number belongs to the connection/number, not the credential.
- A telephony credential is a SIP identity, not a phone number.
- Inbound routing is connection-level, not per-agent.
- Telnyx recommends one credential per device; do not share one credential across tabs or devices.

## 6. Password change endpoint

The console includes `#/password-change`, but it needs a backend endpoint to change anything. The page posts JSON:

```json
{
  "username": "sip-username",
  "extension": "2041",
  "currentPassword": "current-password",
  "newPassword": "new-password"
}
```

to `TELNYX_CONFIG.passwordChangeEndpoint`. The default is `/caller/console/api/password`. If the key is blank, the app falls back to an app-relative `api/password` path. For a `/caller/` deployment, set it to `/caller/api/password` or leave it blank.

Responses:

- `200`/`201` with `{ "ok": true }` — success; the app signs the agent out.
- `200`/`201` with `{ "ok": true, "username": "...", "password": "..." }` — success; new SIP credentials are shown once and copied before re-login.
- `400`/`401`/`403` — the server's `error` or `message` is shown.
- `404`/`405`/`501` or network failure — the app says password change is not enabled; it never claims success.

**Telnyx limitation:** the Telephony Credential PATCH endpoint only updates `name`, `tag`, `connection_id`, and `expires_at`. It cannot change `sip_password` or `sip_username`. The page does not PATCH a Telnyx password.

Backend options:

- **A. App-level extension passwords + short-lived JWTs (recommended).** The backend owns agent passwords and mints a short-lived Telnyx JWT. Password changes do not touch Telnyx.
- **B. Delete and recreate the Telnyx telephony credential.** This produces a new SIP username and password and is disruptive.

## 7. Verify

```bash
curl -I https://your.domain/
curl -I https://your.domain/js/config.js
```

Both should return `200`. Then open the site, sign in with a Telnyx SIP username, extension, and SIP password, and place an outbound call. Open **Password** from the dashboard to confirm the page renders; actual changes require the endpoint above.

## Notes

- Hash routing (`#/login-webui`, `#/dashboard`, `#/password-change`) needs no SPA rewrite beyond the `try_files` fallback in the sample config.
- The Telnyx WebRTC SDK loads from jsDelivr on first connect, so the browser needs outbound HTTPS access to `cdn.jsdelivr.net`.
- Sessions are memory-only. A page refresh returns to sign-in.
