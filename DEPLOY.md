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
};
```

- Use Telnyx **SIP credentials**, not an API key.
- Leave the values blank to require every agent to enter their own credentials.
- Anything in this file is served to every visitor. Do not store real secrets there; prefer a server/JWT token flow for production.

## 5. Verify

```bash
curl -I https://your.domain/
curl -I https://your.domain/js/config.js
```

Both should return `200`. Then open the site, sign in with a Telnyx SIP username, extension, and SIP password, and place an outbound call.

## Notes

- Hash routing (`#/login-webui`, `#/dashboard`) needs no SPA rewrite beyond the `try_files` fallback in the sample config.
- The Telnyx WebRTC SDK loads from jsDelivr on first connect, so the browser needs outbound HTTPS access to `cdn.jsdelivr.net`.
- Sessions are memory-only. A page refresh returns to sign-in.
