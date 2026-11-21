# ESP32-C3 Relay Controller

The GitHub Pages site in `docs/` is the remote control interface. It sends
password-authenticated commands to a Cloudflare Worker. The ESP32-C3 connects
outbound to that Worker over verified HTTPS and polls for the desired relay
states; it does not host a public server and needs no inbound router rule.

The Worker stores the last requested state in Cloudflare D1. The webpage's
state is the requested state, not independent electrical feedback from the
relay hardware.

## 1. Set up Cloudflare

Install Node.js, then in a terminal:

```sh
npx wrangler login
cd cloudflare
npx wrangler d1 create esp32-relay-state
```

Copy the `database_id` from Wrangler's output into `cloudflare/wrangler.toml`.
Change `WEB_ORIGIN` there to the GitHub Pages origin you will use, for example
`https://my-github-name.github.io` (no repository path or trailing slash).
From the `cloudflare` directory, create and initialize the database, then set
the Worker's secrets:

```sh
npx wrangler d1 execute esp32-relay-state --remote --file=schema.sql
openssl rand -hex 32
npx wrangler secret put CONTROL_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put DEVICE_TOKEN
```

Use the random output as the `SESSION_SECRET` and `DEVICE_TOKEN` values.
Choose a long, unique `CONTROL_PASSWORD`; enter each value only at the local
terminal prompt. Do not put these secrets in GitHub or share them. Use a
different random token for `DEVICE_TOKEN` from `SESSION_SECRET`.

The Worker includes a Cloudflare rate-limit binding for login attempts (10
requests per IP per minute). If namespace ID `1001` is already in use in your
account, change it to another unique numeric ID. Keep the Worker secrets
private. To deploy:

```sh
npx wrangler deploy
```

Wrangler prints a URL similar to
`https://esp32-relay-api.<your-account>.workers.dev`. Keep this URL handy.

## 2. Publish the webpage on GitHub Pages

Create a GitHub repository for this project and push the project files, but
first follow the firmware secrets section below so your private `src/secrets.h`
is not committed.

In `docs/index.html`, replace `API_BASE` with the deployed Worker origin, for
example `https://esp32-relay-api.<your-account>.workers.dev` (no trailing
slash). In `cloudflare/wrangler.toml`, `WEB_ORIGIN` must exactly match your
GitHub Pages origin.

In the repository's **Settings → Pages**, choose **Deploy from a branch**, the
branch you pushed (usually `main`), and the `/docs` folder. Save and wait for
GitHub Pages to publish. The page source is public; only the Worker API
requires the password. The password is not embedded in the page.

## 3. Configure and upload the ESP32

1. In `src/`, copy `secrets.example.h` to `secrets.h`. This file is ignored by
   Git.
2. Fill in `WIFI_SSID` and `WIFI_PASSWORD` for your 2.4 GHz home Wi-Fi.
3. Set `DEVICE_TOKEN` to the exact same value used for the Worker secret.
4. Set `DEVICE_STATE_URL` to the Worker URL plus `/api/device/state`.
5. In VS Code, install the PlatformIO IDE extension and open this project.
   Confirm the board in `platformio.ini` is `esp32-c3-devkitm-1` or change it
   to match your board.
6. Connect the ESP32-C3 by USB. Choose **PlatformIO: Build**, then
   **PlatformIO: Upload**. Open **PlatformIO: Monitor** at 115200 baud.

The ESP32 starts both relays OFF and polls the Worker about every three
seconds. It needs outbound DNS and HTTPS (TCP port 443) access to the Worker.
Its TLS connection verifies certificates using the ESP32 Arduino built-in CA
bundle; do not disable certificate verification.

## 4. Relay wiring and remote operation

GPIO 4 controls Relay 1; GPIO 5 controls Relay 2. Use relay modules with
appropriate power and isolation; do not drive relay coils directly from GPIO.
For active-LOW modules, change `RELAY_ACTIVE_LOW` to `true` in `src/main.cpp`.

Open the published GitHub Pages URL, enter the Worker `CONTROL_PASSWORD`, and
select ON or OFF. The command is saved in D1 and applied when the ESP32 next
polls. No port forwarding is required. **Do not forward HTTP or any port to
the ESP32.**

## Security notes

- The GitHub Pages files and their source are public. The password is held by
  the Worker, not by the page.
- `src/secrets.h` contains Wi-Fi and device credentials. Keep it out of Git;
  rotate the device token if it is ever exposed.
- The browser session token is held in that browser tab's `sessionStorage` and
  expires after six hours. Signing out clears that browser's copy.
- Anyone with the shared control password can operate the relays. Use a unique
  strong password and keep the Cloudflare login rate limit enabled.
- The ESP32 cannot report whether the electrical load physically switched;
  it only applies and logs the requested output state.

If control of a hazardous load is involved, use suitable certified equipment,
electrical isolation, and fail-safe design. Never rely on this project as a
safety interlock.
