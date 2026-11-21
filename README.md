# ESP32-C3 Relay Controller

The GitHub Pages site in `docs/` is the remote control interface. It sends
password-authenticated commands to a Cloudflare Worker. The ESP32-C3 connects
outbound to that Worker over verified HTTPS and polls for the desired relay
states; it does not host a public server and needs no inbound router rule.

The Worker stores the last requested state in Cloudflare D1. The webpage's
state is the requested state, not independent electrical feedback from the
relay hardware.

## 1. Finish Cloudflare authentication

The Worker and D1 database are deployed. Worker URL:
`https://esp32-relay-api.surajupes-fd1.workers.dev`.

Authentication secrets are intentionally not set yet, so sign-in and device
polling fail closed until you configure them. In a terminal, generate two
different random values:

```sh
openssl rand -hex 32
```

From the project directory, set the three Worker secrets. Wrangler prompts for
each value. Use a long, unique password for `CONTROL_PASSWORD`, the first
random value for `SESSION_SECRET`, and the second random value for
`DEVICE_TOKEN`. Keep the second random value handy for your local firmware
configuration. Do not put secrets in GitHub or send them in chat.

```sh
cd cloudflare
npx wrangler secret put CONTROL_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put DEVICE_TOKEN
```

The Worker includes a Cloudflare rate-limit binding for login attempts (10
requests per IP per minute). Keep the Worker secrets private.

## 2. Open the GitHub Pages site

The public GitHub repository and Pages site are already created:
[repository](https://github.com/surajsingh81/esp32-relay-controller) and
[control page](https://surajsingh81.github.io/esp32-relay-controller/).
The page source is public; only the Worker API requires the password. The
password is not embedded in the page.

## 3. Configure and upload the ESP32

1. In `src/`, copy `secrets.example.h` to `secrets.h`. This file is ignored by
   Git.
2. Fill in `WIFI_SSID` and `WIFI_PASSWORD` for your 2.4 GHz home Wi-Fi.
3. Set `DEVICE_TOKEN` to the exact same value used for the Worker secret.
4. `DEVICE_STATE_URL` is already set in `secrets.example.h` to the deployed
   Worker endpoint; confirm it if you copied an older template.
5. In VS Code, install the PlatformIO IDE extension and open this project.
   Confirm the board in `platformio.ini` is `esp32-c3-devkitm-1` or change it
   to match your board.
6. Connect the ESP32-C3 by USB. Choose **PlatformIO: Build**, then
   **PlatformIO: Upload**. Open **PlatformIO: Monitor** at 115200 baud.

The Serial Monitor reports Wi-Fi connection attempts and IP address, relay
initialization, cloud polling on HTTPS/TCP port 443, desired relay states
received from the page, and the GPIO level applied when a relay changes.

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
