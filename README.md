# ESP32-C3 Relay Controller

The GitHub Pages site in `docs/` is the remote control interface. It sends
password-authenticated commands to a Cloudflare Worker. The ESP32-C3 connects
outbound to that Worker over verified HTTPS and polls for the desired relay
states; it does not host a public server and needs no inbound router rule.

The Worker stores the last requested state in Cloudflare D1. The webpage's
state is the requested state, not independent electrical feedback from the
relay hardware.

## 1. Cloudflare authentication

The Worker and D1 database are deployed. The required Worker secrets are
already configured; do not set or share their values again unless rotating
them. Worker URL:
`https://esp32-relay-api.surajupes-fd1.workers.dev`.

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
2. Set `DEVICE_TOKEN` to the exact same value used for the Worker secret.
3. `DEVICE_STATE_URL` is already set in `secrets.example.h` to the deployed
   Worker endpoint; confirm it if you copied an older template.
4. In VS Code, install the PlatformIO IDE extension and open this project.
   Confirm the board in `platformio.ini` is `esp32-c3-devkitm-1` or change it
   to match your board.
5. In `src/`, copy `setup_secrets.example.h` to `setup_secrets.h` and set
   `SETUP_AP_PASSWORD` to a private password of 8–63 characters. This local
   file is ignored by Git.
6. Connect the ESP32-C3 by USB. Choose **PlatformIO: Build**, then
   **PlatformIO: Upload**. Open **PlatformIO: Monitor** at 115200 baud.

### Enter Wi-Fi details from a phone

The ESP32 starts the `ESP32-Relay-Setup-XXXXXX` password-protected hotspot;
the six-character suffix distinguishes this board. Connect your phone to it
using the setup password you configured in `setup_secrets.h`. If your phone
offers to switch away because the hotspot has no internet, choose to stay
connected. Open `http://192.168.4.1/` (some phones open the setup page
automatically). Scan for or enter your 2.4 GHz home Wi-Fi name and password,
then choose **Save and connect**. The ESP32 saves the credentials locally and
restarts. The setup hotspot remains available for later Wi-Fi changes.

The GitHub Pages control site cannot configure Wi-Fi directly: it is hosted
remotely and cannot reach an ESP32 that is not already online. Use the
ESP32-hosted setup page for Wi-Fi credentials. They are stored in the ESP32's
local NVS settings and are not sent to Cloudflare or GitHub.

The Serial Monitor reports the setup hotspot name, Wi-Fi connection attempts
and assigned IP address, relay initialization, cloud polling on HTTPS/TCP
port 443, desired output states received from the page, and the GPIO level
applied when an output changes. It never logs Wi-Fi passwords.

The ESP32 starts both relays OFF and polls the Worker about every three
seconds. It needs outbound DNS and HTTPS (TCP port 443) access to the Worker.
Its TLS connection verifies certificates using the ESP32 Arduino built-in CA
bundle; do not disable certificate verification.

## 4. Relay wiring and remote operation

GPIO 4 controls Relay 1; GPIO 5 controls Relay 2. Use relay modules with
appropriate power and isolation; do not drive relay coils directly from GPIO.
For active-LOW modules, change `RELAY_ACTIVE_LOW` to `true` in `src/main.cpp`.

Open the published GitHub Pages URL and enter the Worker `CONTROL_PASSWORD`.
Each relay has its own mode:

- **Device name:** choose **Edit device name** on either device card to label it
  for the connected device (for example, Pump or Fan). Names are saved in
  Cloudflare and also appear in firmware relay-change logs.
- **Manual:** use its ON/OFF buttons.
- **Auto:** add up to 20 daily start times and ON durations, then save all
  timings. Each timing repeats daily in Asia/Kolkata time; the relay stays ON
  while any saved timing is active. If the ESP32 is disconnected across a
  timing's start and misses polling for more than 15 seconds, that day's run is
  skipped rather than started late. Timings are not active until saved.

The Worker stores mode, schedule, and requested states in D1. The webpage
shows the requested output state, not electrical feedback from the relay.
No port forwarding is required. **Do not forward HTTP or any port to the
ESP32.**

After sign-in, the page also reports the ESP32's most recent successful
check-in. It shows **Online** when the device has polled the Worker within
15 seconds, and **Offline** after that window expires. Offline means the
service has not heard from the device; it cannot tell whether the cause is
Wi-Fi, the home internet connection, or the device being powered off.

Use **Help & info** to view the Wi-Fi setup steps, schedule details, and the
signed-in **ESP32 Monitor**. The monitor shows timestamped Wi-Fi,
cloud-service, output-change, and system-metrics events. It shows the name of the Wi-Fi
network currently connected to, CPU clock speed, free/minimum heap, and controller
temperature when the sensor is available. It refreshes every five seconds.
Cloudflare keeps the latest 100 entries. The firmware queues a small number
of events while offline and uploads them after connectivity returns. Wi-Fi
passwords are not included in monitor events; events cannot
reach the website while the device has no internet connection.

## 5. Deploying schedule changes

The scheduling, monitor, and device-name features add D1 tables without
clearing existing relay states. Before deploying an updated Worker, apply the
schema (it is safe to rerun):

```sh
cd cloudflare
npx wrangler d1 execute esp32-relay-state --remote --file=schema.sql
npx wrangler deploy
```

Rebuild and upload the ESP32 firmware after changing `src/main.cpp` so that it
can send monitor events. GitHub Pages publishes changes to `docs/` when they
are pushed to the repository's configured branch.

## 6. Run tests and build

From the repository root, run the Worker API tests and D1 schema migration
tests with:

```sh
node --test cloudflare/test/worker.test.mjs
python3 cloudflare/test_schema.py
```

Build the ESP32-C3 firmware with PlatformIO:

```sh
pio run
```

## Security notes

- The GitHub Pages files and their source are public. The password is held by
  the Worker, not by the page.
- `src/secrets.h` contains the device token and is ignored by Git. Wi-Fi
  credentials are stored in the ESP32's local NVS storage; rotate the device
  token if it is ever exposed.
- `src/setup_secrets.h` contains the setup hotspot password and is ignored by
  Git. Choose a private password and do not share it.
- The browser session token is held in that browser tab's `sessionStorage` and
  expires after six hours. Signing out clears that browser's copy.
- Anyone with the shared control password can operate the relays. Use a unique
  strong password and keep the Cloudflare login rate limit enabled.
- The ESP32 cannot report whether the electrical load physically switched;
  it only applies and logs the requested output state.

If control of a hazardous load is involved, use suitable certified equipment,
electrical isolation, and fail-safe design. Never rely on this project as a
safety interlock.
